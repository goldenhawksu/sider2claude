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
import { getSiderActivitySnapshot, resetSiderActivity } from '../src/utils/sider-activity';
import { controllerHandlesRequest } from '../src/utils/sider-controller';
import { getSiderAccounts, siderAccountId } from '../src/utils/sider-accounts';

test('Bun P0：主控默认接管流式，实际调用的1135独立于fallback统计', async () => {
  const original = globalThis.fetch;
  const previous = { controller: process.env.SIDER_CONTROLLER, streaming: process.env.SIDER_CONTROLLER_STREAMING };
  resetSiderActivity();
  try {
    process.env.SIDER_CONTROLLER = 'true';
    delete process.env.SIDER_CONTROLLER_STREAMING;
    const request: AnthropicRequest = { model: 'claude-opus-5.5', stream: true, messages: [{ role: 'user', content: 'P0测试' }] };
    expect(controllerHandlesRequest(request)).toBe(true);
    process.env.SIDER_CONTROLLER_STREAMING = 'false';
    expect(controllerHandlesRequest(request)).toBe(false);
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ code: 1135, msg: 'Please try again after 1 minutes.' }), { status: 400 }))) as typeof fetch;
    await expect(new SiderClient().chat(convertAnthropicToSiderSync(request), 'test')).rejects.toThrow('1135');
    const activity = await getSiderActivitySnapshot();
    expect(activity.totals.attempts).toBe(1);
    expect(activity.totals.failed).toBe(1);
    expect(activity.totals.quotaErrors).toBe(1);
    expect(activity.totals.completed).toBe(0);
  } finally {
    globalThis.fetch = original;
    if (previous.controller === undefined) delete process.env.SIDER_CONTROLLER;
    else process.env.SIDER_CONTROLLER = previous.controller;
    if (previous.streaming === undefined) delete process.env.SIDER_CONTROLLER_STREAMING;
    else process.env.SIDER_CONTROLLER_STREAMING = previous.streaming;
    resetSiderActivity();
  }
});

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
  const cooldownKey = `cooldown:${await siderAccountId('window-controller-test')}:${model}`;
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
        system: '既有SVG规范。'.repeat(mode === 'long' ? 80000 : 68000) + `尾部唯一路径：${path}`,
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

for (const stream of [false, true]) {
  for (const compact of [false, true]) {
    test(`Bun长会话容量：超过512000字符的SVG历史可${compact ? '压缩' : '继续'}，stream=${stream}`, async () => {
      await withUploadDiagnosticsFixture(async (f) => {
        const marker = crypto.randomUUID();
        const svg = '<svg><text>历史页面</text></svg>\n'.repeat(18000);
        const instruction = compact ? '请总结当前会话，保留尾部事实。' : '请继续并回答尾部事实。';
        const request: AnthropicRequest = { model: 'claude-sonnet-5.5', stream,
          system: compact ? 'Your task is to create a detailed summary of the conversation so far.' : '继续现有任务。',
          messages: [{ role: 'user', content: '生成演示文稿。' },
            { role: 'assistant', content: svg + marker }, { role: 'user', content: instruction }] };
        const original = `System: ${request.system}\n\nUser: 生成演示文稿。\n\nAssistant: ${svg}${marker}\n\nUser: ${instruction}\n\nAssistant:`;
        expect(original.length).toBeGreaterThan(512000);
        const chunks: string[] = [];
        f.mock((body: any) => {
          const text = body.multi_content[0].text;
          expect(text.length).toBeLessThanOrEqual(3000);
          const part = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
          if (part) {
            expect(Number(part[1])).toBe(chunks.length + 1);
            if (chunks.length) expect(body.parent_message_id).toBe(`capacity-${chunks.length}`);
            chunks.push(part[3]);
            return f.sse(body, '已记住', `capacity-${chunks.length}`);
          }
          expect(chunks.join('')).toBe(original);
          return f.sse(body, marker, 'capacity-answer');
        });
        const response = await controllerResponse(request, marker, createRequestLogContext(request));
        expect(response.status).toBe(200);
        if (stream) {
          const text = await response.text();
          expect(text).toContain(marker);
          expect(text).toContain('event: message_stop');
          expect(text).not.toContain('event: error');
        } else {
          expect((await response.json()).content[0].text).toBe(marker);
        }
      });
    });
  }
}
test('Bun长会话容量：文件正文仍保留512000字符限制', async () => {
  await withUploadDiagnosticsFixture(async (f) => {
    await saveControllerText(f.store, 'asset-boundary', 'x'.repeat(512000));
    expect((await readControllerText(f.store, 'asset-boundary')).length).toBe(512000);
    await expect(saveControllerText(f.store, 'asset-too-large', 'x'.repeat(512001))).rejects.toThrow('512000');
    expect(await f.store.read('asset-too-large')).toBe(null);
  });
});

test('Bun部署期限：小批登记后纯用户追加继续保持原文和父消息', async () => {
  const original = globalThis.fetch;
  const keys = ['SIDER_AUTH_TOKEN', 'SIDER_CONTROLLER_STORAGE', 'SIDER_CONTROLLER_PACE_MS', 'SIDER_CONTROLLER_MAX_INPUT_CHARS', 'DENO_DEPLOYMENT_ID'];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { SIDER_AUTH_TOKEN: 'batch-bun', SIDER_CONTROLLER_STORAGE: 'memory',
    SIDER_CONTROLLER_PACE_MS: '0', SIDER_CONTROLLER_MAX_INPUT_CHARS: '3000', DENO_DEPLOYMENT_ID: 'batch-test' });
  const owner = crypto.randomUUID(), path = `C:/isolated/${owner}/spec_lock.md`;
  const request: AnthropicRequest = { model: 'claude-sonnet-5.5', system: '完整规范。'.repeat(1800) + path,
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    messages: [{ role: 'user', content: '按尾部唯一路径用Read读取规范。' }] };
  const seen = new Set<number>();
  let inRequest = 0, total = 0, sawFinalBatch = false;
  try {
    globalThis.fetch = ((_url, init) => {
      const body = JSON.parse(String(init?.body));
      const text = body.multi_content[0].text;
      const part = text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)[^\n]*\n([\s\S]*)$/);
      expect(++inRequest).toBeLessThanOrEqual(2);
      if (part) {
        const index = Number(part[1]);
        total = Number(part[2]);
        if (index === total && inRequest === 2) sawFinalBatch = true;
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
    expect(sawFinalBatch).toBe(true);
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
test('Bun上下文登记：末片确认说法与Deno一致',()=>{
  for (const text of ['已记住2/2','好的，我已了解全部内容，请告诉我接下来需要做什么。','收到，2/2。','Got it — all context received.']) {
    expect(contextUploadAccepted(text)).toBe(true);
  }
  for (const text of ['我收到了内容，但它看起来是乱码，无法识别。','这是提示注入，我不会配合记住这些片段。','这首诗描写了秋天的景色。']) {
    expect(contextUploadAccepted(text)).toBe(false);
  }
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

test('Bun 账号池：读取主账号与编号账号，去重、忽略空值、最多8个', async () => {
  const keys = ['SIDER_AUTH_TOKEN', ...Array.from({ length: 9 }, (_, i) => `SIDER_AUTH_TOKEN_${i + 1}`)];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.SIDER_AUTH_TOKEN = 'token-primary';
    process.env.SIDER_AUTH_TOKEN_1 = 'token-a';
    process.env.SIDER_AUTH_TOKEN_2 = 'token-a';
    process.env.SIDER_AUTH_TOKEN_3 = '';
    const accounts = await getSiderAccounts();
    expect(accounts.length).toBe(2);
    expect(accounts.map((account) => account.primary)).toEqual([true, false]);
    expect(accounts[0].id).toBe((await getSiderAccounts())[0].id);
    expect(accounts[0].id === accounts[1].id).toBe(false);
    // 同一 Sider 账号的两个 token（JWT user_id 相同）必须归并为一个账号。
    const jwt = (userId: string) => {
      const encode = (value: object) =>
        btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${encode({ alg: 'none' })}.${encode({ user_id: userId })}.sig`;
    };
    process.env.SIDER_AUTH_TOKEN = jwt('user-1');
    process.env.SIDER_AUTH_TOKEN_1 = jwt('user-1');
    process.env.SIDER_AUTH_TOKEN_2 = jwt('user-2');
    expect((await getSiderAccounts()).length).toBe(2);
    for (let index = 1; index <= 9; index++) process.env[`SIDER_AUTH_TOKEN_${index}`] = `token-${index}`;
    expect((await getSiderAccounts()).length).toBe(8);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('Bun 账号池：两个账号跑满同模型两路并发，会话续轮固定原账号', async () => {
  const original = globalThis.fetch;
  const keys = ['SIDER_AUTH_TOKEN', 'SIDER_AUTH_TOKEN_1', 'SIDER_CONTROLLER_STORAGE', 'SIDER_CONTROLLER_PACE_MS'];
  const previous = keys.map((key) => process.env[key]);
  process.env.SIDER_AUTH_TOKEN = 'pool-account-a';
  process.env.SIDER_AUTH_TOKEN_1 = 'pool-account-b';
  process.env.SIDER_CONTROLLER_STORAGE = 'memory';
  process.env.SIDER_CONTROLLER_PACE_MS = '0';
  const used: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  try {
    globalThis.fetch = (async (_url, init) => {
      used.push(String((init?.headers as Record<string, string>)?.Authorization));
      const body = JSON.parse(String(init?.body));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 120));
      inFlight--;
      const cid = `pool-cid-${crypto.randomUUID()}`;
      return new Response([
        { code: 0, msg: 'ok', data: { type: 'message_start', model: body.model,
          message_start: { cid, user_message_id: 'u', assistant_message_id: crypto.randomUUID() } } },
        { code: 0, msg: 'ok', data: { type: 'text', model: body.model, text: 'OK' } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const owner = 'pool-owner-' + crypto.randomUUID();
    const request = () => ({ model: 'claude-sonnet-5.5', max_tokens: 20,
      messages: [{ role: 'user' as const, content: crypto.randomUUID() }] });

    // 两个账号：同模型的两路请求必须同时进入上游。
    const [a, b] = await Promise.all([
      runSiderController(request(), owner),
      runSiderController(request(), owner),
    ]);
    expect(a.sider_session?.conversation_id).toBeTruthy();
    expect(b.sider_session?.conversation_id).toBeTruthy();
    expect(maxInFlight).toBe(2);
    expect(new Set(used.slice(-2)).size).toBe(2);

    // 续轮必须沿用建立会话时的账号。
    used.length = 0;
    const first = await runSiderController(request(), owner);
    const firstToken = used[0];
    used.length = 0;
    await runSiderController(request(), owner, undefined, first.sider_session!.conversation_id);
    expect(used[0]).toBe(firstToken);
  } finally {
    globalThis.fetch = original;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('Bun 主控流式：chat 实时转发文本增量且仍返回完整结果', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          [
            {
              code: 0,
              msg: 'ok',
              data: {
                type: 'message_start',
                model: 'claude-sonnet-5.5',
                message_start: {
                  cid: 'stream-client-cid',
                  user_message_id: 'u',
                  assistant_message_id: 'a',
                },
              },
            },
            { code: 0, msg: 'ok', data: { type: 'text', model: 'claude-sonnet-5.5', text: '甲' } },
            { code: 0, msg: 'ok', data: { type: 'text', model: 'claude-sonnet-5.5', text: '乙' } },
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      )) as typeof fetch;
    const seen: string[] = [];
    const result = await new SiderClient().chat(
      convertAnthropicToSiderSync({
        model: 'claude-sonnet-5.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: '流式客户端测试' }],
      }),
      'test',
      undefined,
      (text) => seen.push(text),
    );
    expect(seen).toEqual(['甲', '乙']);
    expect(result.textParts.join('')).toBe('甲乙');
  } finally {
    globalThis.fetch = original;
  }
});

test('Bun 主控：非流式部署超时返回要求改用流式的400', async () => {
  const original = globalThis.fetch;
  const keys = [
    'SIDER_AUTH_TOKEN',
    'SIDER_CONTROLLER_STORAGE',
    'SIDER_CONTROLLER_PACE_MS',
    'DENO_DEPLOYMENT_ID',
    'SIDER_TOTAL_TIMEOUT_MS',
  ];
  const previous = keys.map((key) => process.env[key]);
  process.env.SIDER_AUTH_TOKEN = 'timeout-account';
  process.env.SIDER_CONTROLLER_STORAGE = 'memory';
  process.env.SIDER_CONTROLLER_PACE_MS = '0';
  process.env.DENO_DEPLOYMENT_ID = 'timeout-bun';
  process.env.SIDER_TOTAL_TIMEOUT_MS = '50';
  try {
    globalThis.fetch = ((_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })) as typeof fetch;
    await expect(
      runSiderController({
        model: 'claude-opus-5.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: `超时-${crypto.randomUUID()}` }],
      }, 'timeout-owner'),
    ).rejects.toThrow('stream=true');
  } finally {
    globalThis.fetch = original;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('Bun 主控：提供方工具（无 input_schema）不进主控', () => {
  const previous = process.env.SIDER_CONTROLLER;
  process.env.SIDER_CONTROLLER = 'true';
  try {
    const provider = {
      model: 'claude-opus-5.5',
      stream: false,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [{ role: 'user', content: '搜索' }],
    } as unknown as AnthropicRequest;
    expect(controllerHandlesRequest(provider)).toBe(false);
    expect(controllerHandlesRequest({
      ...provider,
      tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
    } as AnthropicRequest)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.SIDER_CONTROLLER;
    else process.env.SIDER_CONTROLLER = previous;
  }
});

test('Bun 路由：提供方工具走 DeepSeek，续轮不被 Sider 记录带回', () => {
  const config = {
    sider: { enabled: true, apiUrl: 'https://sider.ai/api/chat/v1/completions', authToken: 'test' },
    deepseek: {
      enabled: true,
      provider: 'anthropic-compatible' as const,
      baseUrl: 'https://compatible.example',
      apiKey: 'test',
      model: 'glm-5.3-flash',
    },
    routing: {
      defaultBackend: 'sider' as const,
      autoFallback: true,
      preferSiderForSimpleChat: true,
      debugMode: false,
      siderStrategy: 'pro' as const,
    },
  };
  const router = new RouterEngine(config);
  router.recordSessionBackend('provider-session', 'sider');
  const request = {
    model: 'claude-opus-5.5',
    max_tokens: 64,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: '结果' }] }],
  } as unknown as AnthropicRequest;

  const decision = router.decide(request, 'provider-session');
  expect(decision.backend).toBe('deepseek');
  expect(decision.ruleId).toBe('rule_4_provider_tools');
  expect(decision.allowFallback).toBe(false);
});

for (const scenario of ['恢复', '期限不足', '再次限流', '执行前限流']) {
  test(`Bun主控OpenAI流式上传：1135${scenario}`, async () => {
    const recover = scenario === '恢复' || scenario === '执行前限流';
    const quotaWaitMs = scenario === '期限不足' ? 60_000 : 40;
    const keys = ['AUTH_TOKEN', 'SIDER_AUTH_TOKEN', 'SIDER_CONTROLLER', 'SIDER_CONTROLLER_STORAGE',
      'SIDER_CONTROLLER_PACE_MS', 'SIDER_CONTROLLER_MAX_INPUT_CHARS', 'SIDER_TOTAL_TIMEOUT_MS',
      'SIDER_CONTROLLER_STREAM_COMMIT_MS'];
    const values = ['quota-client', 'quota-bun-token', 'true', 'memory', '0', '3000', '1000', '0'];
    const previous = keys.map((key) => process.env[key]);
    keys.forEach((key, index) => { process.env[key] = values[index]; });
    const original = globalThis.fetch;
    const store = await getControllerStore();
    const model = 'gemini-3.8-flash';
    const cooldownKey = `cooldown:${await siderAccountId('quota-bun-token')}:${model}`;
    const chunks: number[] = [];
    let retries = 0, limitedAt = 0;
    try {
      const { SiderUpstreamError } = await import('../src/utils/sider-client');
      const { default: protocolRouter } = await import('../src/routes/protocols');
      globalThis.fetch = ((_url, init) => {
        const body = JSON.parse(String(init?.body));
        const part = body.multi_content[0].text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)/);
        let reply = '上传恢复后真实回答';
        if (!part && scenario === '执行前限流' && retries++ === 0) {
          limitedAt = Date.now();
          throw new SiderUpstreamError('登记后执行前达到额度', 1135, 429, '', quotaWaitMs);
        }
        if (part) {
          const index = Number(part[1]);
          chunks.push(index);
          if (index === 2 && scenario !== '执行前限流') {
            expect(body.cid).toBe('quota-bun-cid');
            expect(body.parent_message_id).toBe('quota-parent-1');
            if (retries++ === 0 || scenario === '再次限流') {
              limitedAt = Date.now();
              throw new SiderUpstreamError('上传时达到模型额度', 1135, 429, '', quotaWaitMs);
            }
            expect(Date.now() - limitedAt).toBeGreaterThanOrEqual(30);
          }
          reply = `已记住${index}/${part[2]}`;
        }
        return Promise.resolve(new Response([
          { code: 0, msg: 'ok', data: { type: 'message_start', model,
            message_start: { cid: 'quota-bun-cid', user_message_id: 'u', assistant_message_id: `quota-parent-${part?.[1] ?? 'answer'}` } } },
          { code: 0, msg: 'ok', data: { type: 'text', model, text: reply } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } }));
      }) as typeof fetch;
      const response = await protocolRouter.request('/v1/chat/completions', {
        method: 'POST', headers: { 'x-api-key': 'quota-client', 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: [
          { role: 'system', content: '完整规范。'.repeat(1600) },
          { role: 'user', content: crypto.randomUUID() },
        ] }),
      });
      const text = await response.text();
      const events = text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
      if (recover) {
        expect(events.some((event) => event.error)).toBe(false);
        expect(text).toContain('上传恢复后真实回答');
        expect(chunks.filter((index) => index === 1)).toHaveLength(1);
        expect(chunks.filter((index) => index === 2)).toHaveLength(scenario === '执行前限流' ? 1 : 2);
      } else {
        const failed = events.find((event) => event.error);
        expect(failed.error.type).toBe('rate_limit_error');
        expect(failed.error.retry_after).toBe(Math.ceil(quotaWaitMs / 1000));
        expect(failed.choices).toEqual([]);
        expect(chunks).toEqual(scenario === '再次限流' ? [1, 2, 2] : [1, 2]);
      }
    } finally {
      globalThis.fetch = original;
      await store.write(cooldownKey, 0, -1);
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
}

test('Bun主控流式：开流前撞1135返回HTTP 429与Retry-After；提交窗口为0保持旧行为', async () => {
  const original = globalThis.fetch;
  const keys = ['SIDER_AUTH_TOKEN', 'SIDER_CONTROLLER_STORAGE', 'SIDER_CONTROLLER_PACE_MS', 'SIDER_CONTROLLER_STREAM_COMMIT_MS'];
  const previous = keys.map((key) => process.env[key]);
  const quota = () => new Response(
    'data: ' + JSON.stringify({ code: 1135, msg: 'Please try again after 1 minutes.', data: null }) + '\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    process.env.SIDER_CONTROLLER_STORAGE = 'memory';
    process.env.SIDER_CONTROLLER_PACE_MS = '0';
    globalThis.fetch = (async () => quota()) as unknown as typeof fetch;

    process.env.SIDER_AUTH_TOKEN = `bun-stream-commit-${crypto.randomUUID()}`;
    delete process.env.SIDER_CONTROLLER_STREAM_COMMIT_MS;
    const request: AnthropicRequest = { model: 'claude-haiku-5.5', stream: true,
      messages: [{ role: 'user', content: crypto.randomUUID() }] };
    const deferred = await controllerResponse(request, crypto.randomUUID(), createRequestLogContext(request));
    expect(deferred.status).toBe(429);
    expect(deferred.headers.get('retry-after')).toBe('60');
    expect((await deferred.json()).error.type).toBe('rate_limit_error');

    process.env.SIDER_AUTH_TOKEN = `bun-stream-commit-${crypto.randomUUID()}`;
    process.env.SIDER_CONTROLLER_STREAM_COMMIT_MS = '0';
    const legacy = await controllerResponse(request, crypto.randomUUID(), createRequestLogContext(request));
    expect(legacy.status).toBe(200);
    const text = await legacy.text();
    expect(text).toContain('event: error');
    expect(text).toContain('rate_limit_error');
  } finally {
    globalThis.fetch = original;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

async function withUploadDiagnosticsFixture(run: (f: any) => Promise<void>) {
  const vars: Record<string, string> = { SIDER_AUTH_TOKEN: 'upload-bun-fixture',
    SIDER_CONTROLLER_STORAGE: 'memory', SIDER_CONTROLLER_PACE_MS: '0',
    SIDER_CONTROLLER_PACE_MIN_MS: '0', SIDER_CONTROLLER_MAX_INPUT_CHARS: '3000',
    SIDER_CONTROLLER_STREAM_COMMIT_MS: '20000', SIDER_TOTAL_TIMEOUT_MS: '5000',
    SIDER_CONTROLLER: 'true', DENO_DEPLOYMENT_ID: '', AUTH_TOKEN: 'upload-bun-client' };
  for (let i = 1; i <= 8; i++) vars[`SIDER_AUTH_TOKEN_${i}`] = '';
  const previous = Object.keys(vars).map((key) => [key, process.env[key]]);
  Object.assign(process.env, vars);
  const store = await getControllerStore();
  const db = new Database(':memory:');
  let backing = new ControllerSqliteStore(db);
  const original = { read: store.read, write: store.write, claim: store.claim, release: store.release,
    fetch: globalThis.fetch, info: console.info, warn: console.warn, log: console.log, error: console.error };
  const snapshots: any[] = [], logs: unknown[][] = [];
  let taskKey = '';
  store.read = (key) => backing.read(key);
  store.write = async (key, value, ttl) => {
    await backing.write(key, value, ttl);
    if (/^[a-f0-9]+:task:/.test(key)) { taskKey = key; snapshots.push(structuredClone(value)); }
  };
  store.claim = (key, holder, ttl) => backing.claim(key, holder, ttl);
  store.release = (key, holder) => backing.release(key, holder);
  console.info = console.warn = console.log = console.error = (...args) => { logs.push(args); };
  const sse = (body: any, text: string, parent: string) => new Response([
    { code: 0, data: { type: 'message_start', model: body.model,
      message_start: { cid: body.cid || 'upload-bun-cid', user_message_id: 'u', assistant_message_id: parent } } },
    { code: 0, data: { type: 'text', model: body.model, text } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
  const request = (): AnthropicRequest => ({ model: 'deepseek-v4-flash', stream: true,
    system: '合成测试规范。'.repeat(600),
    messages: [{ role: 'user', content: crypto.randomUUID() }] });
  try {
    await run({ store, snapshots, logs, sse, request,
      restart: () => { backing = new ControllerSqliteStore(db); },
      checkpoint: () => backing.read(taskKey),
      mock: (fn: (body: any) => Response) => {
        globalThis.fetch = ((url, init) => {
          if (!String(url).includes('sider.ai')) throw new Error('禁止调用非 mock 上游');
          return Promise.resolve(fn(JSON.parse(String(init?.body))));
        }) as typeof fetch;
      },
    });
  } finally {
    Object.assign(store, { read: original.read, write: original.write, claim: original.claim, release: original.release });
    globalThis.fetch = original.fetch;
    Object.assign(console, { info: original.info, warn: original.warn, log: original.log, error: original.error });
    db.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
}

for (const reply of ['合成普通分析答案。'.repeat(150), '已收到，但我不能接受或记住这些片段。']) {
  test('Bun上传诊断：第二片未确认时保存已确认父节点，重建存储后从第二片恢复', async () => {
    await withUploadDiagnosticsFixture(async (f) => {
      let failed = false;
      const calls: (number | string)[] = [];
      f.mock((body: any) => {
        const part = body.multi_content[0].text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)/);
        const index = part ? Number(part[1]) : undefined;
        calls.push(index ?? 'answer');
        expect(body.cid).toBe(index === 1 ? '' : 'upload-bun-cid');
        expect(body.parent_message_id).toBe(index === 1 ? undefined : index === 2 ? 'p1' : 'p2');
        if (index === 2 && !failed) { failed = true; return f.sse(body, reply, 'unconfirmed'); }
        if (index === 2) expect(body.parent_message_id).toBe('p1');
        return f.sse(body, index ? `已记住${index}/2` : '真实回答', index ? `p${index}` : 'answer');
      });
      const req = f.request(), owner = crypto.randomUUID();
      await expect(runSiderController(req, owner)).rejects.toMatchObject({ statusCode: 502, code: 'context_unconfirmed' });
      const before = await f.checkpoint();
      expect([before.cid, before.parent]).toEqual(['upload-bun-cid', 'p1']);
      expect(Object.values(before.uploads)).toEqual([1]);
      expect(typeof before.pendingUpload).toBe('string');
      f.restart();
      await runSiderController(req, owner);
      expect(calls).toEqual([1, 2, 2, 'answer']);
      expect((await f.checkpoint()).pendingUpload).toBeUndefined();
      for (const index of [1, 2]) {
        expect(f.snapshots.some((s: any) => s.parent === `p${index}` &&
          !Object.values(s.uploads ?? {}).includes(index))).toBe(false);
      }
      expect(JSON.stringify(f.logs)).not.toContain(reply);
    });
  });
}

test('Bun上传诊断：多账号首次并发相同请求只发送一次', async () => {
  await withUploadDiagnosticsFixture(async (f) => {
    process.env.SIDER_AUTH_TOKEN_1 = 'upload-bun-fixture-2';
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const duplicate = Promise.withResolvers<void>();
    const write = f.store.write;
    let writes = 0, calls = 0;
    f.store.write = async (key: string, value: unknown, ttl: number) => {
      if (/^[a-f0-9]+:task:/.test(key)) {
        if (++writes === 1) entered.resolve(); else duplicate.resolve();
        await gate.promise;
      }
      await write(key, value, ttl);
    };
    f.mock((body: any) => { calls++; return f.sse(body, '真实回答', 'p'); });
    const req: AnthropicRequest = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: crypto.randomUUID() }] };
    const first = runSiderController(req, 'upload-concurrent-owner');
    await entered.promise;
    const second = runSiderController(req, 'upload-concurrent-owner').catch((error) => error);
    await Promise.race([duplicate.promise, second]);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    if (b instanceof Error) expect((b as any).statusCode).toBe(429);
    else expect(a.id).toBe(b.id);
  });
});

for (const protocol of ['anthropic', 'openai']) {
  for (const scenario of ['unconfirmed', 'quota', 'checkpoint']) {
    test(`Bun上传诊断 HTTP：${protocol} ${scenario} 保留状态、退避和原因`, async () => {
      await withUploadDiagnosticsFixture(async (f) => {
        if (scenario === 'checkpoint') process.env.DENO_DEPLOYMENT_ID = 'fixture-deployment';
        f.mock((body: any) => {
          if (scenario === 'quota') return new Response(
            'data: ' + JSON.stringify({ code: 1135, msg: 'Please try again after 1 minutes.' }) + '\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
          const part = body.multi_content[0].text.match(/^以下是当前任务上下文片段(\d+)\/(\d+)/);
          return f.sse(body, scenario === 'unconfirmed' ? '合成私密普通答案。'.repeat(150) : `已记住${part?.[1]}/2`, 'p');
        });
        const req = scenario === 'quota'
          ? { model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user' as const, content: crypto.randomUUID() }] }
          : { ...f.request(), stream: scenario !== 'checkpoint' };
        let response: Response;
        if (protocol === 'anthropic') response = await controllerResponse(req, 'upload-bun-client', createRequestLogContext(req));
        else {
          const { default: router } = await import('../src/routes/protocols');
          response = await router.request('/v1/chat/completions', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'upload-bun-client' },
            body: JSON.stringify({ model: req.model, stream: req.stream,
              messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages] }) });
        }
        expect(response.status).toBe(scenario === 'unconfirmed' ? 502 : 429);
        expect(response.headers.get('retry-after')).toBe(scenario === 'unconfirmed' ? null : scenario === 'quota' ? '60' : '1');
        const json = await response.json();
        const code = protocol === 'openai' ? json.error.details?.code : json.error.code;
        expect(code).toBe(scenario === 'unconfirmed' ? 'context_unconfirmed' : scenario === 'quota' ? 'sider_1135' : 'context_checkpoint');
        expect(JSON.stringify(f.logs)).not.toContain('合成私密普通答案');
        expect(JSON.stringify(f.logs)).not.toContain('upload-bun-fixture');
      });
    });
  }
}

for (const protocol of ['anthropic', 'openai']) {
  test(`Bun上传诊断 HTTP：${protocol} 已提交SSE仍保留具体原因`, async () => {
    await withUploadDiagnosticsFixture(async (f) => {
      process.env.SIDER_CONTROLLER_STREAM_COMMIT_MS = '0';
      f.mock((body: any) => f.sse(body, '合成普通答案。'.repeat(150), 'unconfirmed'));
      const req = f.request();
      let response: Response;
      if (protocol === 'anthropic') response = await controllerResponse(req, 'upload-bun-client', createRequestLogContext(req));
      else {
        const { default: router } = await import('../src/routes/protocols');
        response = await router.request('/v1/chat/completions', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'upload-bun-client' },
          body: JSON.stringify({ model: req.model, stream: true,
            messages: [{ role: 'system', content: req.system }, ...req.messages] }) });
      }
      expect(response.status).toBe(200);
      const text = await response.text();
      const error = text.split('\n').filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6))).find((event) => event.error)?.error;
      expect(protocol === 'openai' ? error?.details?.code : error?.code).toBe('context_unconfirmed');
      expect(text).not.toContain('合成普通答案');
      expect(text).not.toContain('event: message_stop');
      expect(text).not.toContain('"finish_reason":"stop"');
    });
  });
}

for (const [deployed, stream, configured, effective] of [
  [true, false, undefined, 70_000], [true, false, '20000', 20_000],
  [true, false, '120000', 70_000], [true, true, undefined, 600_000],
  [true, true, '120000', 120_000], [false, false, undefined, 600_000],
] as const) {
  test(`Bun请求锁期限：deployed=${deployed} stream=${stream} timeout=${configured ?? 'default'}`, async () => {
    await withUploadDiagnosticsFixture(async (f) => {
      process.env.DENO_DEPLOYMENT_ID = deployed ? 'fixture-deployment' : '';
      if (configured) process.env.SIDER_TOTAL_TIMEOUT_MS = configured;
      else delete process.env.SIDER_TOTAL_TIMEOUT_MS;
      const claims: { key: string; ttl: number }[] = [], claim = f.store.claim;
      f.store.claim = (key: string, holder: string, ttl: number) => {
        claims.push({ key, ttl }); return claim(key, holder, ttl);
      };
      f.mock((body: any) => f.sse(body, '合成回答', 'p'));
      await runSiderController({ model: 'deepseek-v4-flash', stream,
        messages: [{ role: 'user', content: crypto.randomUUID() }] }, crypto.randomUUID());
      expect(claims.find((entry) => entry.key.startsWith('request:'))?.ttl).toBe(effective + 35_000);
      expect(claims.find((entry) => entry.key.startsWith('account:'))?.ttl).toBe(effective + 5_000);
    });
  });
}

test('Bun请求锁期限：模拟未释放的锁，在有效期限及余量结束后恢复', async () => {
  await withUploadDiagnosticsFixture(async (f) => {
    process.env.DENO_DEPLOYMENT_ID = 'fixture-deployment';
    delete process.env.SIDER_TOTAL_TIMEOUT_MS;
    const originalNow = Date.now, release = f.store.release;
    let now = originalNow(), interrupted = true, calls = 0;
    f.store.release = (key: string, holder: string) => interrupted ? Promise.resolve() : release(key, holder);
    Date.now = () => now;
    f.mock((body: any) => {
      calls++;
      if (interrupted) throw new Error('合成进程中断');
      return f.sse(body, '恢复后的合成回答', 'p');
    });
    const req: AnthropicRequest = { model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: crypto.randomUUID() }] };
    const owner = crypto.randomUUID(), started = now;
    try {
      try { await runSiderController(req, owner); } catch { /* 模拟锁未释放 */ }
      interrupted = false;
      for (const elapsed of [69_999, 70_000, 104_999]) {
        now = started + elapsed;
        await expect(runSiderController(req, owner)).rejects.toMatchObject({ code: 'controller_busy' });
      }
      now = started + 105_000;
      f.restart();
      await runSiderController(req, owner);
      expect(calls).toBe(2);
    } finally { Date.now = originalNow; }
  });
});

test('Bun请求锁期限：正常异常仍立即释放锁', async () => {
  await withUploadDiagnosticsFixture(async (f) => {
    let calls = 0;
    f.mock((body: any) => {
      if (++calls === 1) throw new Error('合成普通异常');
      return f.sse(body, '合成回答', 'p');
    });
    const req: AnthropicRequest = { model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: crypto.randomUUID() }] }, owner = crypto.randomUUID();
    await expect(runSiderController(req, owner)).rejects.toThrow('合成普通异常');
    await runSiderController(req, owner);
    expect(calls).toBe(2);
  });
});

test('Bun请求锁期限：账号重选不能重置原始截止时间', async () => {
  await withUploadDiagnosticsFixture(async (f) => {
    process.env.DENO_DEPLOYMENT_ID = 'fixture-deployment';
    delete process.env.SIDER_TOTAL_TIMEOUT_MS;
    f.mock((body: any) => f.sse(body, '合成回答', 'p'));
    const owner = crypto.randomUUID();
    const req: AnthropicRequest = { model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: crypto.randomUUID() }] };
    const first = await runSiderController(req, owner);
    const session = first.sider_session!.conversation_id;
    const key = `${await controllerHash(owner)}:task:${session}`;
    const task = await f.store.read(key);
    process.env.SIDER_AUTH_TOKEN_1 = 'upload-bun-fixture-2';
    const primary = await siderAccountId('upload-bun-fixture');
    const secondary = await siderAccountId('upload-bun-fixture-2');
    const originalNow = Date.now, originalTimeout = AbortSignal.timeout;
    let now = originalNow(), accountClaims = 0, calls = 0;
    const deadlines: { at: number; abort: AbortController }[] = [];
    const advance = (ms: number) => {
      now += ms;
      for (const entry of deadlines) {
        if (now >= entry.at) entry.abort.abort(new DOMException('合成请求期限已到', 'TimeoutError'));
      }
    };
    Date.now = () => now;
    AbortSignal.timeout = (ms) => {
      const abort = new AbortController();
      deadlines.push({ at: now + ms, abort }); return abort.signal;
    };
    const claim = f.store.claim, release = f.store.release;
    f.store.claim = async (leaseKey: string, holder: string, ttl: number) => {
      if (leaseKey.startsWith('account:')) {
        if (++accountClaims === 1) {
          task.account = leaseKey.includes(primary) ? secondary : primary;
          await f.store.write(key, task, 600_000);
        } else advance(15_000);
      }
      return claim(leaseKey, holder, ttl);
    };
    f.store.release = async (leaseKey: string, holder: string) => {
      await release(leaseKey, holder);
      if (leaseKey.startsWith('account:') && accountClaims === 1) advance(60_000);
    };
    f.mock((body: any) => { calls++; return f.sse(body, '不应发送的超时回答', 'p'); });
    try {
      await expect(runSiderController({ ...req, messages: [{ role: 'user', content: crypto.randomUUID() }] },
        owner, undefined, session)).rejects.toMatchObject({ statusCode: 400 });
      expect(deadlines).toHaveLength(1);
      expect(calls).toBe(0);
    } finally { Date.now = originalNow; AbortSignal.timeout = originalTimeout; }
  });
});
