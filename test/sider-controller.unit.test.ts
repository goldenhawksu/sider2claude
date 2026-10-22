import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ControllerSqliteStore } from '../src/utils/controller-storage';
import { controllerPayloadDiagnostics, controllerToolRefusalDetected, contextUploadAccepted, strictControllerCalls, readControllerText, saveControllerText, extractReadJson } from '../src/utils/sider-controller';
import { validDeclaredToolInput } from '../src/utils/tool-input-validation';
import { convertAnthropicToSiderSync } from '../src/utils/request-converter';
import { restoreToolUseFromText } from '../src/utils/textual-tool-use';
import { fetchSiderResponse } from '../src/utils/sider-transport';
import { SiderClient } from '../src/utils/sider-client';
import { controllerResponse } from '../src/utils/controller-http';
import { createRequestLogContext } from '../src/utils/request-observability';
import { runSiderController, controllerHash } from '../src/utils/sider-controller';
import { getControllerStore } from '../src/utils/controller-storage';
import { isSiderCooling, recordSiderQuotaExhausted, resetSiderAvailability } from '../src/utils/sider-availability';
import { canUseSider, consumeSiderSlot, resetSiderThrottle } from '../src/utils/sider-throttle';
import { isSafetyClassifierRequest } from '../src/utils/request-analyzer';
import { RouterEngine } from '../src/routing/router-engine';
import { AnthropicApiAdapter } from '../src/adapters/anthropic-adapter';
import type { AnthropicRequest } from '../src/types/anthropic';

test('Bun：XML分类使用兼容后端，保留显式disabled及真实阻止判定', async () => {
  const original = globalThis.fetch;
  const request = { model: 'claude-sonnet-5.5[1M]', max_tokens: 64,
    system: 'Safety classifier. Classification format: <block>yes</block> or <block>no</block>.',
    thinking: { type: 'disabled' as const }, stop_sequences: ['</block>'],
    messages: [{ role: 'user' as const, content: '评估命令，不执行' }] };
  const config = { sider: { enabled: true, apiUrl: 'https://sider.ai/api/chat/v1/completions', authToken: 'test' },
    deepseek: { enabled: true, provider: 'anthropic-compatible' as const, baseUrl: 'https://classifier.example',
      apiKey: 'test', model: 'glm-5.3-flash' },
    routing: { defaultBackend: 'sider' as const, autoFallback: true, preferSiderForSimpleChat: true,
      debugMode: false, siderStrategy: 'max' as const } };
  try {
    expect(isSafetyClassifierRequest(request)).toBe(true);
    expect(isSafetyClassifierRequest({ ...request, system: undefined })).toBe(false);
    expect(isSafetyClassifierRequest({ ...request, tools: [{ name: 'Bash', input_schema: { type: 'object', properties: {} } }] })).toBe(false);
    const decision = new RouterEngine(config).decide(request);
    expect(decision.backend).toBe('deepseek');
    expect(decision.allowFallback).toBe(false);
    globalThis.fetch = ((_url, init) => {
      expect(String(_url)).toBe('https://classifier.example/v1/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.model).toBe('glm-5.3-flash');
      expect(body.system).toBe(request.system);
      return Promise.resolve(new Response(JSON.stringify({ id: 'classifier-bun', type: 'message',
        role: 'assistant', model: body.model, content: [{ type: 'text', text: '<block>yes</block>' }],
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 8 } }),
        { headers: { 'content-type': 'application/json' } }));
    }) as typeof fetch;
    const result = await new AnthropicApiAdapter(config.deepseek).sendRequest(request);
    expect(result.model).toBe(request.model);
    expect(result.content).toEqual([{ type: 'text', text: '<block>yes' }]);
    expect(result.stop_reason).toBe('stop_sequence');
  } finally { globalThis.fetch = original; resetSiderThrottle(); }
});

test('Bun：1M标签与原名共享限流状态，发送边界只传原名', async () => {
  const original = globalThis.fetch;
  try {
    const model = 'claude-sonnet-5.5';
    recordSiderQuotaExhausted(model + '[1M]', 1000, 60_000);
    expect(isSiderCooling(model, 1000)).toBe(true);
    expect(isSiderCooling('claude-opus-5.5', 1000)).toBe(false);
    for (let i = 0; i < 12; i++) consumeSiderSlot(model + '[1m]', 1000);
    expect(canUseSider(model, 100, 1000).ok).toBe(false);
    globalThis.fetch = ((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.chat_models).toEqual(['claude-opus-5.5']);
      return Promise.resolve(new Response('data: ' + JSON.stringify({ code: 0, msg: 'ok',
        data: { type: 'text', model, text: '验证通过' } }) + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }));
    }) as typeof fetch;
    const req = { ...convertAnthropicToSiderSync({ model,
      messages: [{ role: 'user', content: '模型边界测试' }] }),
      model: model + '[1M]', chat_models: ['claude-opus-5.5[1m]'] };
    const result = await new SiderClient().chat(req, 'test');
    expect(result.model).toBe(model);
    expect(req.model).toBe(model + '[1M]');
  } finally {
    globalThis.fetch = original;
    resetSiderAvailability();
    resetSiderThrottle();
  }
});

test('Bun：1M切换保持主控重放、历史恢复与冷却，真正换模型仍拒绝', async () => {
  const original = globalThis.fetch;
  const previous = { token: process.env.SIDER_AUTH_TOKEN, storage: process.env.SIDER_CONTROLLER_STORAGE,
    pace: process.env.SIDER_CONTROLLER_PACE_MS };
  process.env.SIDER_AUTH_TOKEN = 'window-controller-test';
  process.env.SIDER_CONTROLLER_STORAGE = 'memory';
  process.env.SIDER_CONTROLLER_PACE_MS = '0';
  const owner = 'window-owner-' + crypto.randomUUID();
  const model = 'claude-sonnet-5.5';
  let calls = 0;
  const store = await getControllerStore();
  const cooldownKey = `cooldown:${await controllerHash('window-controller-test')}:${model}`;
  try {
    globalThis.fetch = ((_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      if (calls === 2) {
        expect(body.cid).toBe('window-bun-cid');
        expect(body.parent_message_id).toBe('window-bun-parent-1');
      }
      return Promise.resolve(new Response([
        { code: 0, msg: 'ok', data: { type: 'message_start', model,
          message_start: { cid: 'window-bun-cid', user_message_id: 'u',
            assistant_message_id: `window-bun-parent-${calls}` } } },
        { code: 0, msg: 'ok', data: { type: 'text', model, text: '已记住42' } },
      ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } }));
    }) as typeof fetch;
    const request = { model: model + '[1M]', messages: [{ role: 'user' as const, content: crypto.randomUUID() }] };
    const first = await runSiderController(request, owner);
    const replay = await runSiderController({ ...request, model }, owner);
    expect(replay.id).toBe(first.id);
    expect(replay.model).toBe(model);
    expect(calls).toBe(1);
    const next = await runSiderController({ model: model + '[200k]',
      messages: [...request.messages, { role: 'assistant', content: first.content },
        { role: 'user', content: '继续' }] }, owner);
    expect(next.sider_session?.conversation_id).toBe(first.sider_session?.conversation_id);
    expect(next.model).toBe(model + '[200k]');
    await expect(runSiderController({ ...request, model: 'claude-opus-5.5' }, owner,
      undefined, first.sider_session?.conversation_id)).rejects.toThrow('切换模型');
    await store.write(cooldownKey, Date.now() + 60_000, 60_000);
    await expect(runSiderController({ ...request, model: model + '[200k]',
      messages: [{ role: 'user', content: crypto.randomUUID() }] }, owner)).rejects.toThrow('冷却');
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
    await store.write(cooldownKey, 0, -1);
    for (const [key, value] of [['SIDER_AUTH_TOKEN', previous.token],
      ['SIDER_CONTROLLER_STORAGE', previous.storage], ['SIDER_CONTROLLER_PACE_MS', previous.pace]]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});

const tools: any[]=[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}}];
test('Bun：后台PowerShell历史恢复后继续查询，重试不重放且新工具续接原会话', async () => {
  const original = globalThis.fetch;
  const keys = ['SIDER_AUTH_TOKEN', 'SIDER_CONTROLLER_STORAGE', 'SIDER_CONTROLLER_PACE_MS'];
  const previous = keys.map((key) => process.env[key]);
  process.env.SIDER_AUTH_TOKEN = 'checkpoint-bun-test';
  process.env.SIDER_CONTROLLER_STORAGE = 'memory';
  process.env.SIDER_CONTROLLER_PACE_MS = '0';
  const id = 'native_' + crypto.randomUUID();
  const owner = 'checkpoint-owner-' + crypto.randomUUID();
  const request = { model: 'claude-sonnet-5.5', tools: [{ name: 'TaskOutput', input_schema: {
    type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'],
  } }], messages: [
    { role: 'user' as const, content: '根据生图后台任务输出继续完成，不要重新运行命令。' },
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id, name: 'PowerShell',
      input: { command: 'python skills/ppt-master/scripts/image_gen.py --manifest images/image_prompts.json', timeout: 600000 } }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: id,
      content: 'Command running in background with ID: blvuwvc0a. Output is being written to: C:/Temp/blvuwvc0a.output' }] },
    { role: 'user' as const, content: '请继续完成' },
  ] };
  let calls = 0;
  try {
    globalThis.fetch = ((_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls++;
      const text = body.multi_content[0].text;
      if (calls === 1) {
        expect(body.cid).toBe('');
        for (const value of ['image_gen.py --manifest', 'blvuwvc0a.output', '请继续完成', `tool_use_id=${id}`]) {
          expect(text.includes(value)).toBe(true);
        }
      } else {
        expect(body.cid).toBe('checkpoint-bun-cid');
        expect(body.parent_message_id).toBe('checkpoint-bun-parent-1');
        expect(text.includes('tool_use_id=poll_1')).toBe(true);
        expect(text.includes('图片已生成')).toBe(true);
        expect(text.includes('image_gen.py')).toBe(false);
      }
      return Promise.resolve(new Response([
        { code: 0, msg: 'ok', data: { type: 'message_start', model: request.model,
          message_start: { cid: 'checkpoint-bun-cid', user_message_id: 'u', assistant_message_id: `checkpoint-bun-parent-${calls}` } } },
        { code: 0, msg: 'ok', data: { type: 'text', model: request.model,
          text: calls === 1 ? '[tool_use:TaskOutput] id=poll_1 input={"task_id":"blvuwvc0a"}' : '图片已生成，任务完成' } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }));
    }) as typeof fetch;
    const first = await runSiderController(request, owner);
    const call = first.content.find((block) => block.type === 'tool_use')!;
    expect(call.name).toBe('TaskOutput');
    expect(call.input).toEqual({ task_id: 'blvuwvc0a' });
    expect((await runSiderController(request, owner)).id).toBe(first.id);
    expect(calls).toBe(1);
    const store = await getControllerStore();
    await store.write(`${await controllerHash(owner)}:tool:${call.id}`, 'expired', -1);
    const next = await runSiderController({ ...request, messages: [...request.messages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: '图片已生成' }] },
      { role: 'user', content: '请继续完成' },
    ] }, owner);
    expect(next.stop_reason).toBe('end_turn');
    expect(next.sider_session?.conversation_id).toBe(first.sider_session?.conversation_id);
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('Bun：无检查点的孤立、重复和缺失结果仍拒绝，不能请求上游', async () => {
  const original = globalThis.fetch;
  const previous = process.env.SIDER_AUTH_TOKEN;
  process.env.SIDER_AUTH_TOKEN = 'invalid-checkpoint-bun';
  const call = { type: 'tool_use' as const, id: crypto.randomUUID(), name: 'PowerShell', input: { command: 'echo ok' } };
  const result = { type: 'tool_result' as const, tool_use_id: call.id, content: 'ok' };
  try {
    globalThis.fetch = (() => { throw new Error('无效历史不应请求上游'); }) as typeof fetch;
    for (const messages of [
      [{ role: 'user' as const, content: [result] }],
      [{ role: 'assistant' as const, content: [call] }, { role: 'user' as const, content: [result, result] }],
      [{ role: 'assistant' as const, content: [call, { ...call, id: 'missing-result' }] }, { role: 'user' as const, content: [result] }],
    ]) {
      await expect(runSiderController({ model: 'claude-sonnet-5.5', messages }, crypto.randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    }
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.SIDER_AUTH_TOKEN;
    else process.env.SIDER_AUTH_TOKEN = previous;
  }
});

test('Bun长会话：超过16分片完整登记，中断后追加继续仍保留尾部且不重发已确认内容', async () => {
  const original = globalThis.fetch;
  const keys = ['SIDER_AUTH_TOKEN', 'SIDER_CONTROLLER_STORAGE', 'SIDER_CONTROLLER_PACE_MS', 'SIDER_CONTROLLER_MAX_INPUT_CHARS'];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { SIDER_AUTH_TOKEN: 'context-bun', SIDER_CONTROLLER_STORAGE: 'memory',
    SIDER_CONTROLLER_PACE_MS: '0', SIDER_CONTROLLER_MAX_INPUT_CHARS: '3000' });
  try {
    for (const mode of ['long', 'resume']) {
      const id = crypto.randomUUID();
      const path = `C:/isolated/${id}/08.svg`;
      const seen = new Map<number, string>();
      let total = 0, failed = false;
      const request: AnthropicRequest = { model: 'claude-sonnet-5.5',
        system: '既有SVG规范。'.repeat(mode === 'long' ? 8000 : 1800) + `尾部唯一路径：${path}`,
        tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
        messages: [
          { role: 'user', content: 'P07已完成，读取规范后继续P08。' },
          { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'spec_lock.md' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '已读取规范' }] },
        ],
      };
      globalThis.fetch = ((_url, init) => {
        const body = JSON.parse(String(init?.body));
        const text = body.multi_content[0].text;
        expect(text.length).toBeLessThanOrEqual(3000);
        const part = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
        let reply: string;
        if (part) {
          const index = Number(part[1]);
          total = Number(part[2]);
          if (mode === 'resume' && index === 2 && !failed) {
            failed = true;
            return Promise.resolve(new Response('temporary upstream failure', { status: 503 }));
          }
          expect(seen.has(index)).toBe(false);
          if (index > 1) expect(body.parent_message_id).toBe(`parent-${index - 1}`);
          seen.set(index, part[3]);
          reply = '已记住';
        } else {
          expect(seen.size).toBe(total);
          expect([...seen.values()].join('')).toContain(path);
          if (mode === 'long') expect(total).toBeGreaterThan(16);
          else expect(text).toContain('请继续完成P08');
          reply = `[tool_use:Read] id=p08 input=${JSON.stringify({ file_path: path })}`;
        }
        return Promise.resolve(new Response([
          { code: 0, msg: 'ok', data: { type: 'message_start', model: request.model,
            message_start: { cid: `context-${id}`, user_message_id: 'u', assistant_message_id: `parent-${part?.[1] ?? 'done'}` } } },
          { code: 0, msg: 'ok', data: { type: 'text', model: request.model, text: reply } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
      }) as typeof fetch;
      if (mode === 'resume') {
        await expect(runSiderController(request, id)).rejects.toThrow();
        expect(seen.size).toBe(1);
        request.messages.push({ role: 'user', content: '请继续完成P08' });
      }
      const result = await runSiderController(request, id);
      expect(result.content.find((block) => block.type === 'tool_use')?.input.file_path).toBe(path);
      expect(seen.size).toBe(total);
    }
  } finally {
    globalThis.fetch = original;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('Bun长会话：内容库超限返回明确的400容量错误，保留真正上游413的语义', async () => {
  const original = globalThis.fetch;
  const previous = process.env.SIDER_AUTH_TOKEN;
  process.env.SIDER_AUTH_TOKEN = 'context-capacity-bun';
  const request: AnthropicRequest = { model: 'claude-sonnet-5.5', system: 'x'.repeat(512001),
    messages: [{ role: 'user', content: crypto.randomUUID() }] };
  try {
    globalThis.fetch = (() => { throw new Error('容量校验失败不应调用上游'); }) as typeof fetch;
    const response = await controllerResponse(request, crypto.randomUUID(), createRequestLogContext(request));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('512000');
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.SIDER_AUTH_TOKEN;
    else process.env.SIDER_AUTH_TOKEN = previous;
  }
});

test('Bun部署期限：小批登记后纯用户追加继续保持原文和父消息', async () => {
  const original = globalThis.fetch;
  const keys = ['SIDER_AUTH_TOKEN', 'SIDER_CONTROLLER_STORAGE', 'SIDER_CONTROLLER_PACE_MS', 'SIDER_CONTROLLER_MAX_INPUT_CHARS', 'DENO_DEPLOYMENT_ID'];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { SIDER_AUTH_TOKEN: 'batch-bun', SIDER_CONTROLLER_STORAGE: 'memory',
    SIDER_CONTROLLER_PACE_MS: '0', SIDER_CONTROLLER_MAX_INPUT_CHARS: '3000', DENO_DEPLOYMENT_ID: 'batch-test' });
  const owner = crypto.randomUUID(), path = `C:/isolated/${owner}/spec_lock.md`;
  const request: AnthropicRequest = { model: 'claude-sonnet-5.5', system: '完整规范。'.repeat(1600) + path,
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    messages: [{ role: 'user', content: '按尾部唯一路径用Read读取规范。' }] };
  const seen = new Set<number>();
  let inRequest = 0, total = 0;
  try {
    globalThis.fetch = ((_url, init) => {
      const body = JSON.parse(String(init?.body));
      const text = body.multi_content[0].text;
      const part = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
      if (part) {
        expect(++inRequest).toBeLessThanOrEqual(2);
        const index = Number(part[1]);
        total = Number(part[2]);
        expect(seen.has(index)).toBe(false);
        if (index > 1) expect(body.parent_message_id).toBe(`parent-${index - 1}`);
        seen.add(index);
      } else {
        expect(seen.size).toBe(total);
        expect(text).toContain('请继续完成P08');
      }
      return Promise.resolve(new Response([
        { code: 0, msg: 'ok', data: { type: 'message_start', model: request.model,
          message_start: { cid: `batch-${owner}`, user_message_id: 'u', assistant_message_id: `parent-${part?.[1] ?? 'done'}` } } },
        { code: 0, msg: 'ok', data: { type: 'text', model: request.model,
          text: part ? '已记住' : `[tool_use:Read] id=p08 input=${JSON.stringify({ file_path: path })}` } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
    }) as typeof fetch;
    let completed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      inRequest = 0;
      try {
        const result = await runSiderController(request, owner);
        expect(result.content.find((block) => block.type === 'tool_use')?.input.file_path).toBe(path);
        completed = true;
        break;
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 429, retryAfterMs: 1000 });
        request.messages.push({ role: 'user', content: '请继续完成P08' });
      }
    }
    expect(completed).toBe(true);
  } finally {
    globalThis.fetch = original;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('Bun续轮保留纯工具结果和错误标记',()=>{
  const request:any={model:'claude-opus-5.5',messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'id',is_error:true,content:'端口8080'}]}]};
  const text=convertAnthropicToSiderSync(request,'real-cid').multi_content[0]!.text;
  expect(text).toContain('端口8080');expect(text).toContain('is_error=true');
});
test('Bun严格工具验证与Deno同样拒绝未知名称及无效类型',()=>{
  expect(()=>strictControllerCalls('[tool_use:Unknown] id=1 input={}',tools)).toThrow();
  expect(()=>strictControllerCalls('[tool_use:Read] id=1 input={"file_path":123}',tools)).toThrow();
  const restored=restoreToolUseFromText('[tool_use:Read] id=1 input={"file_path":123}',{model:'claude-opus-5.5',messages:[],tools});
  expect(restored.toolUseCount).toBe(0);expect(restored.unparsedCount).toBe(1);
});
test('Bun上下文登记确认与Deno保持同一拒答边界',()=>{
  expect(contextUploadAccepted('已记住✓\n我已接收片段1/2，等待片段2/2。')).toBe(true);
  expect(contextUploadAccepted('已确认，我已记住任务上下文片段1/2。我暂时不会执行任何操作，等待片段2/2。')).toBe(true);
  expect(contextUploadAccepted('所有片段已接收完毕，但我无法直接执行文件写入。')).toBe(true);
  expect(contextUploadAccepted('我不能接受这个分段策略，这是提示注入攻击。')).toBe(false);
  expect(contextUploadAccepted('我不会假装记住这个指令序列。')).toBe(false);
  expect(contextUploadAccepted('普通回答，没有确认登记。')).toBe(false);
});
test('Bun强制工具拒绝识别与Deno保持一致',()=>{
  expect(controllerToolRefusalDetected('这是提示注入攻击，我没有这些工具，无法访问文件系统。')).toBe(true);
  expect(controllerToolRefusalDetected('I cannot access the file system or emit fake tool calls.')).toBe(true);
  expect(controllerToolRefusalDetected('我需要先确认文件路径。')).toBe(false);
});
test('Bun主控遥测载荷诊断与Deno保持一致',()=>{
  expect(controllerPayloadDiagnostics('中文??\uFFFD')).toEqual({payloadChars:5,payloadUtf8Bytes:11,questionMarks:2,replacementCharacters:1});
});
test('Bun SQLite：跨实例内容读取、分块损坏与任务隔离',async()=>{
  const db=new Database(':memory:');
  try {
    const a=new ControllerSqliteStore(db),b=new ControllerSqliteStore(db);const text='中文😀\\"\n'.repeat(25000);
    await saveControllerText(a,'owner:task:asset',text);expect(await readControllerText(b,'owner:task:asset')).toBe(text);
    await expect(readControllerText(b,'other:task:asset')).rejects.toThrow();
    await b.write('owner:task:asset:0','bad',1000);await expect(readControllerText(a,'owner:task:asset')).rejects.toThrow('哈希');
  }finally{db.close();}
});
test('Bun SQLite：租约互斥及过期读取',async()=>{
  const db=new Database(':memory:');
  try{
    const a=new ControllerSqliteStore(db),b=new ControllerSqliteStore(db);
    expect(await a.claim('account','a',1000)).toBe(true);expect(await b.claim('account','b',1000)).toBe(false);
    await a.release('account','wrong');expect(await b.claim('account','b',1000)).toBe(false);
    await b.release('account','a');expect(await b.claim('account','b',1000)).toBe(true);
    await a.write('expired','x',-1);expect(await b.read('expired')).toBeNull();
  }finally{db.close();}
});
test('Bun原生统一事件和HTTP603错误解析',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=(()=>Promise.resolve(new Response([{code:0,msg:'ok',data:{type:'tool_call',model:'claude-opus-5.5',tool_call:{id:'id',name:'search',status:'finish',search:{search_snippets:{title:'来源'}}}}},{code:0,msg:'ok',data:{type:'text',model:'claude-opus-5.5',text:'完成'}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}}))) as typeof fetch;
    const client=new SiderClient();const req:any={cid:'',model:'claude-opus-5.5',multi_content:[{type:'text',text:'probe'}],tools:{auto:[]}};
    const result=await client.chat(req,'test');expect(result.toolResults?.length).toBe(1);expect(result.toolResults?.[0]?.result.search.search_snippets.title).toBe('来源');
    globalThis.fetch=(()=>Promise.resolve(new Response(JSON.stringify({code:603,msg:'Too many words'}),{status:400}))) as typeof fetch;
    await expect(client.chat(req,'test')).rejects.toMatchObject({siderCode:603,statusCode:413});
  }finally{globalThis.fetch=original;}
});
test('Bun上游静默超时会取消正文reader',async()=>{
  const original=globalThis.fetch;let cancelled=false;
  try{
    globalThis.fetch=(()=>Promise.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})))) as typeof fetch;
    await expect((await fetchSiderResponse('https://sider.ai/x',{},20,100)).text()).rejects.toThrow();expect(cancelled).toBe(true);
  }finally{globalThis.fetch=original;}
});
test('Bun真实Claude Code2020-12工具schema校验',()=>{
  const tool:any={name:'Write',input_schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content'],additionalProperties:false}};
  expect(validDeclaredToolInput([tool],'Write',{file_path:'C:/isolated/file.json',content:'中文\\"\n'})).toBe(true);
  expect(validDeclaredToolInput([tool],'Write',{file_path:'C:/isolated/file.json',content:123})).toBe(false);
});
test('Bun真实Read展示正文不重复转义，不猜测坏输入',()=>{
  const content='{\n  "text":"中文\\n\\\\路径"\n}';
  expect(extractReadJson(content.split('\n').map((line,i)=>`${i+1}\t${line}`).join('\n'))).toBe(content);
  expect(extractReadJson('1\t{\n3\t}')).toBeNull();
});
test('Bun真实HTTP：上游静默超过10秒时SSE心跳保持连接',async()=>{
  const original=globalThis.fetch;
  const previous={token:process.env.SIDER_AUTH_TOKEN,storage:process.env.SIDER_CONTROLLER_STORAGE,pace:process.env.SIDER_CONTROLLER_PACE_MS};
  process.env.SIDER_AUTH_TOKEN='controller-http-test';process.env.SIDER_CONTROLLER_STORAGE='memory';process.env.SIDER_CONTROLLER_PACE_MS='0';
  const request={model:'claude-opus-5.5',messages:[{role:'user' as const,content:crypto.randomUUID()}],stream:true};
  const server=Bun.serve({port:0,idleTimeout:10,fetch:()=>controllerResponse(request,'local-test-owner',createRequestLogContext(request))});
  try {
    globalThis.fetch=(async()=>{
      await new Promise(resolve=>setTimeout(resolve,11_500));
      return new Response([{code:0,msg:'ok',data:{type:'message_start',model:request.model,message_start:{cid:'slow-cid',user_message_id:'u',assistant_message_id:'a'}}},{code:0,msg:'ok',data:{type:'text',model:request.model,text:'HTTP保持连接成功'}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    }) as typeof fetch;
    const response=await original(`http://localhost:${server.port}`);const text=await response.text();
    expect(text).toContain('event: ping');expect(text).toContain('HTTP保持连接成功');expect(text).toContain('event: message_stop');
  }finally{
    globalThis.fetch=original;server.stop(true);
    for(const [key,value]of [['SIDER_AUTH_TOKEN',previous.token],['SIDER_CONTROLLER_STORAGE',previous.storage],['SIDER_CONTROLLER_PACE_MS',previous.pace]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
  }
},20_000);
