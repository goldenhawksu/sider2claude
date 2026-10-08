import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicTool,
  AnthropicToolUse,
} from '../types/anthropic.js';
import { getEnv } from './env.js';
import { getModelById } from '../config/models.js';
import { siderClient } from './sider-client.js';
import { SiderUpstreamError } from './sider-client.js';
import { buildSiderMessageText, contentToText } from './message-format.js';
import { buildToolContract } from './textual-tool-use.js';
import { declaredToolInputError, validDeclaredToolInput } from './tool-input-validation.js';
import { isValidWriteInput } from './textual-tool-use.js';
import { getControllerStore } from './controller-storage.js';
import type { ControllerStore } from './controller-memory-store.js';
import { persistSiderTelemetry } from './sider-telemetry.js';
import { recordUsage } from './usage-stats.js';
import { applyStopSequences } from './stop-sequences.js';

const RETENTION_MS = 24 * 60 * 60_000;
const INTERNAL_TOOLS: AnthropicTool[] = [
  {
    name: 'StoreContent',
    description:
      '代理内部可信正文库。保存你创作的完整正文，返回content_ref和sha256。保存不会写用户文件。保存成功后调用WriteFromRef执行写入。',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
  },
  {
    name: 'WriteFromRef',
    description: '从代理可信正文库引用完整正文并提交给客户端Write工具执行；禁止重新生成正文。',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content_ref: { type: 'string' } },
      required: ['file_path', 'content_ref'],
    },
  },
];
interface Task {
  id: string;
  model: string;
  cid: string;
  parent: string;
  refs: string[];
  pending: Array<{ id: string; upstreamId: string; name?: string; readPath?: string }>;
  uploads?: Record<string, number>;
  toolsHash?: string;
  mustWrite?: boolean;
  exactCopy?: boolean;
  copyRef?: string;
}
export class ControllerError extends Error {
  constructor(message: string, public statusCode = 502, public retryAfterMs?: number) {
    super(message);
  }
}
export const controllerEnabled = () => getEnv('SIDER_CONTROLLER') === 'true';
export async function controllerHash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 分块后每个KV值小于64KiB；哈希校验不能依赖expireIn是否及时回收。
export async function saveControllerText(
  store: ControllerStore,
  key: string,
  text: string,
): Promise<void> {
  if (text.length > 512_000) throw new ControllerError('正文超过可信内容库单项容量', 413);
  const count = Math.max(1, Math.ceil(text.length / 8000));
  for (let i = 0; i < count; i++) {
    await store.write(`${key}:${i}`, text.slice(i * 8000, (i + 1) * 8000), RETENTION_MS);
  }
  await store.write(key, { count, hash: await controllerHash(text) }, RETENTION_MS);
}
export async function readControllerText(store: ControllerStore, key: string): Promise<string> {
  const meta = await store.read<{ count: number; hash: string }>(key);
  if (!meta) throw new ControllerError('正文引用已过期或不属于当前任务');
  let text = '';
  for (let i = 0; i < meta.count; i++) {
    const chunk = await store.read<string>(`${key}:${i}`);
    if (chunk === null) throw new ControllerError('正文引用分块缺失');
    text += chunk;
  }
  if (await controllerHash(text) !== meta.hash) throw new ControllerError('正文引用哈希不匹配');
  return text;
}
export function strictControllerCalls(text: string, tools: AnthropicTool[]): AnthropicToolUse[] {
  const calls: AnthropicToolUse[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^\[tool_use:/.test(line)) continue;
    const match = line.match(/^\[tool_use:([^\]]+)\]\s+id=(\S+)\s+input=(\{.*\})\s*$/);
    if (!match) throw new ControllerError('Sider工具意图不符合单行严格JSON契约');
    let input: unknown;
    try {
      input = JSON.parse(match[3]!);
    } catch {
      throw new ControllerError('Sider工具参数JSON无效，禁止猜测修补');
    }
    if (!validDeclaredToolInput(tools, match[1]!, input)) {
      throw new ControllerError('Sider工具名称或参数不符合本次schema');
    }
    if (match[1] === 'Write' && !isValidWriteInput(input)) {
      throw new ControllerError('Sider文件路径或正文无效');
    }
    calls.push({
      type: 'tool_use',
      name: match[1]!,
      id: match[2]!,
      input: input as Record<string, unknown>,
    });
  }
  if (calls.length > 1) throw new ControllerError('主控契约每轮只允许一个工具意图');
  return calls;
}
/** 真实Claude Code Read返回连续“行号+制表符”；只接收可确认完整且合法的JSON展示正文。 */
export function extractReadJson(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines.length >= 2000) return null;
  const decoded: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\d+)\t(.*)$/);
    if (!match || Number(match[1]) !== index + 1) return null;
    decoded.push(match[2]!);
  }
  const content = decoded.join('\n');
  try {
    JSON.parse(content);
    return content;
  } catch {
    return null;
  }
}
async function historyKey(request: AnthropicRequest, messages = request.messages): Promise<string> {
  // 客户端可重新分块文本或省略thinking；工具id与参数保持原样。
  const normalized = messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.filter((block) => !['thinking', 'redacted_thinking'].includes(block.type)),
  }));
  return await controllerHash(
    JSON.stringify({ model: request.model, system: request.system, messages: normalized }),
  );
}
async function resolveTask(
  store: ControllerStore,
  owner: string,
  request: AnthropicRequest,
  session?: string,
): Promise<Task> {
  let id: string | null = session ? await store.read(`${owner}:session:${session}`) : null;
  const results = pendingUserMessages(request).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result')
      : []
  );
  if (results.length) {
    const ids = await Promise.all(
      results.map((block) => store.read<string>(`${owner}:tool:${block.tool_use_id}`)),
    );
    if (ids.some((value) => !value) || new Set(ids).size !== 1) {
      throw new ControllerError('工具结果没有有效主控检查点或属于不同任务', 409);
    }
    if (id && id !== ids[0]) throw new ControllerError('会话与工具结果归属不一致', 409);
    id = ids[0] ?? null;
  }
  if (!id && request.messages.length > 1) {
    id = await store.read(
      `${owner}:history:${await historyKey(request, request.messages.slice(0, -1))}`,
    );
  }
  const task = id ? await store.read<Task>(`${owner}:task:${id}`) : null;
  if (id && !task) throw new ControllerError('主控检查点已过期', 409);
  if (task && task.model !== request.model) {
    throw new ControllerError('恢复主控会话时不能静默切换模型', 409);
  }
  if (
    results.length && task &&
    results.some((block) => !task.pending.some((p) => p.id === block.tool_use_id))
  ) throw new ControllerError('工具结果已处理或不是待执行工具', 409);
  return task ??
    { id: crypto.randomUUID(), model: request.model, cid: '', parent: '', refs: [], pending: [] };
}
function pendingUserMessages(request: AnthropicRequest) {
  let lastAssistant = -1;
  request.messages.forEach((message, index) => {
    if (message.role === 'assistant') lastAssistant = index;
  });
  return request.messages.slice(lastAssistant + 1).filter((message) => message.role === 'user');
}
function containsImage(content: AnthropicRequest['messages'][number]['content']): boolean {
  return Array.isArray(content) &&
    content.some((block) =>
      block.type === 'image' ||
      ('content' in block && Array.isArray(block.content) &&
        containsImage(block.content as typeof content))
    );
}
let queued = 0;
export async function withControllerLease<T>(
  store: ControllerStore,
  key: string,
  signal: AbortSignal,
  totalMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (queued >= 32) throw new ControllerError('Sider主控等待队列已满', 429, 1000);
  queued++;
  const holder = crypto.randomUUID(), until = Date.now() + 30_000;
  let claimed = false;
  try {
    while (!(claimed = await store.claim(key, holder, totalMs + 5000))) {
      if (signal.aborted) throw signal.reason;
      if (Date.now() >= until) {
        throw new ControllerError('Sider账号正在处理其他任务，请稍后继续', 429, 1000);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return await fn();
  } finally {
    queued--;
    if (claimed) await store.release(key, holder);
  }
}

/** 主控协议独立于pro/max：从不把业务回合交给兼容后端重做。 */
export async function runSiderController(
  request: AnthropicRequest,
  token: string,
  signal?: AbortSignal,
  session?: string,
): Promise<AnthropicResponse> {
  if (!getModelById(request.model)) {
    throw new ControllerError('主控模式要求明确登记的上游模型名', 400);
  }
  if (request.messages.some((m) => containsImage(m.content))) {
    throw new ControllerError('已测Sider通道不支持视觉输入；不能静默丢图', 400);
  }
  if (request.messages.at(-1)?.role !== 'user') {
    throw new ControllerError('主控模式需要以用户或工具结果结束的消息', 400);
  }
  const siderToken = getEnv('SIDER_AUTH_TOKEN');
  if (!siderToken) throw new ControllerError('未配置Sider主控凭证', 503);
  const store = await getControllerStore();
  const owner = await controllerHash(token);
  const totalMs = Number(getEnv('SIDER_TOTAL_TIMEOUT_MS', '600000'));
  const deadline = AbortSignal.timeout(totalMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = Date.now();
  return await withControllerLease(
    store,
    `account:${await controllerHash(siderToken)}`,
    combined,
    totalMs,
    async () => {
      const replayKey = `${owner}:response:${await controllerHash(
        JSON.stringify({ ...request, stream: undefined }),
      )}`;
      const cached = await store.read<{ responseKey: string }>(replayKey);
      if (cached) return JSON.parse(await readControllerText(store, cached.responseKey));
      const cooldown = await store.read<number>(
        `cooldown:${await controllerHash(siderToken)}:${request.model}`,
      );
      if (cooldown && cooldown > Date.now()) {
        throw new ControllerError(
          'Sider模型额度仍在冷却，主控任务保留',
          429,
          cooldown - Date.now(),
        );
      }
      const inflightKey = `${replayKey}:task`;
      const resumeId = await store.read<string>(inflightKey);
      const task = await resolveTask(store, owner, request, session ?? resumeId ?? undefined);
      task.exactCopy ??= /逐字复制|原样复制/.test(contentToText(request.messages[0]!.content));
      await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
      await store.write(`${owner}:session:${task.id}`, task.id, RETENTION_MS);
      await store.write(inflightKey, task.id, RETENTION_MS);
      const clientTools = request.tool_choice?.type === 'none' ? [] : request.tools ?? [];
      if (
        clientTools.some((t) => ['StoreContent', 'WriteFromRef'].includes(t.name))
      ) throw new ControllerError('客户端工具名与代理内部工具冲突', 400);
      const tools = clientTools.some((t) => t.name === 'Write')
        ? [...clientTools, ...INTERNAL_TOOLS]
        : clientTools;
      for (const message of pendingUserMessages(request)) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type !== 'tool_result') continue;
          const pending = task.pending.find((p) => p.id === block.tool_use_id);
          if (block.is_error) {
            if (pending?.name === 'Write') task.mustWrite = true;
            continue;
          }
          if (pending?.name !== 'Read' || !pending.readPath?.endsWith('.json')) continue;
          const content = extractReadJson(
            typeof block.content === 'string' ? block.content : contentToText(block.content ?? []),
          );
          if (content === null) continue;
          const ref = `sha256:${await controllerHash(content)}`;
          await saveControllerText(store, `${owner}:${task.id}:asset:${ref}`, content);
          if (!task.refs.includes(ref)) task.refs.push(ref);
          if (task.refs.length > 32) throw new ControllerError('任务正文引用数量超过上限');
          if (task.exactCopy) {
            task.copyRef = ref;
            task.mustWrite = true;
          }
        }
      }
      let text = task.cid
        ? pendingUserMessages(request).map((message) => contentToText(message.content)).join('\n\n')
        : buildSiderMessageText(request, {
          includeHistory: request.messages.length > 1,
          currentUserInput: contentToText(request.messages.at(-1)!.content),
        });
      for (const p of task.pending) {
        text = text.replace(
          `tool_use_id=${p.id}`,
          `tool_use_id=${p.upstreamId}`,
        );
      }
      if (task.refs.length) text += `\n代理可信正文引用：${JSON.stringify(task.refs)}`;
      if (task.copyRef) {
        text +=
          `\n当前逐字复制任务的Read JSON正文已由代理去除连续行号并完整保存，content_ref=${task.copyRef}。必须使用WriteFromRef引用该正文，禁止重写、二次转义或再次StoreContent。`;
      }
      let corrections = 0;
      let totalInputTokens = 0, totalOutputTokens = 0;
      const paceKey = `pace:${await controllerHash(siderToken)}`;
      // 当前实测13,662字符通过、25,671字符中文被拒；大上下文按已测会话续轮分段登记。
      const maxChars = Number(getEnv('SIDER_CONTROLLER_MAX_INPUT_CHARS', '14000'));
      if (!Number.isFinite(maxChars) || maxChars < 2000) {
        throw new ControllerError(
          '主控输入体量配置无效',
          400,
        );
      }
      const sendText = async (prompt: string) => {
        if (prompt.length > maxChars) {
          throw new ControllerError(
            `Sider实际新增输入${prompt.length}字符超过配置上限${maxChars}，检查点已保留`,
            413,
          );
        }
        const callStarted = Date.now();
        let upstream;
        try {
          const nextAt = await store.read<number>(paceKey);
          if (nextAt && nextAt > Date.now()) {
            await new Promise((resolve) => setTimeout(resolve, nextAt - Date.now()));
          }
          if (combined.aborted) throw combined.reason;
          const body = {
            cid: task.cid,
            ...(task.parent ? { parent_message_id: task.parent } : {}),
            model: getModelById(request.model)!.siderModel,
            from: 'chat',
            filter_search_history: false,
            multi_content: [{ type: 'text' as const, text: prompt, user_input_text: prompt }],
            prompt_templates: [],
            tools: { auto: [] },
            output_language: 'zh-CN',
          };
          try {
            upstream = await siderClient.chat(body, siderToken, combined);
          } catch (error) {
            // 仅重试明确的建立连接失败；SSE失败、读取超时和工具服务端副作用均不重试。
            const message = error instanceof Error ? error.message : '';
            if (combined.aborted || !(/\(Connect\)|Unable to connect/.test(message))) throw error;
            persistSiderTelemetry({
              ts: Date.now(),
              model: request.model,
              strategy: 'controller',
              payloadChars: prompt.length,
              ok: false,
              siderCode: 0,
              ms: Date.now() - callStarted,
              hasTools: !!tools.length,
              restoredToolUse: false,
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
            upstream = await siderClient.chat(body, siderToken, combined);
          }
        } catch (error) {
          persistSiderTelemetry({
            ts: Date.now(),
            model: request.model,
            strategy: 'controller',
            payloadChars: prompt.length,
            ok: false,
            siderCode: error instanceof SiderUpstreamError ? error.siderCode : 0,
            ms: Date.now() - callStarted,
            hasTools: !!tools.length,
            restoredToolUse: false,
          });
          if (error instanceof SiderUpstreamError && error.siderCode === 1135) {
            const wait = error.retryAfterMs ?? 60_000;
            await store.write(
              `cooldown:${await controllerHash(siderToken)}:${request.model}`,
              Date.now() + wait,
              wait,
            );
          }
          throw error;
        } finally {
          await store.write(
            paceKey,
            Date.now() + Number(getEnv('SIDER_CONTROLLER_PACE_MS', '12000')),
            RETENTION_MS,
          );
        }
        if (upstream.model !== getModelById(request.model)!.siderModel) {
          throw new ControllerError(
            'Sider返回模型标识与主控请求不一致',
          );
        }
        if (!upstream.conversationId || !upstream.messageIds?.assistant) {
          throw new ControllerError(
            'Sider未提供可恢复的会话检查点',
          );
        }
        task.cid = upstream.conversationId;
        task.parent = upstream.messageIds.assistant;
        await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
        totalInputTokens += Math.ceil(prompt.length / 4);
        totalOutputTokens += Math.ceil(
          (upstream.textParts.join('').length + upstream.reasoningParts.join('').length) / 4,
        );
        return upstream;
      };
      const upload = async (context: string) => {
        const hash = await controllerHash(context), size = maxChars - 256;
        const count = Math.ceil(context.length / size);
        if (count > 16) {
          throw new ControllerError('上下文超过单次可登记的16个分段，检查点保留', 413);
        }
        task.uploads ??= {};
        for (let i = task.uploads[hash] ?? 0; i < count; i++) {
          const uploadStarted = Date.now();
          const chunk = `以下是当前任务上下文片段${
            i + 1
          }/${count}。仅记住，暂时不执行任务、不调用工具；只确认已记住，所有片段发送完后再执行。\n${
            context.slice(i * size, (i + 1) * size)
          }`;
          const result = await sendText(chunk);
          if (/\[tool_use:/.test(result.textParts.join(''))) {
            throw new ControllerError(
              'Sider在上下文登记阶段提前提出执行意图',
            );
          }
          task.uploads[hash] = i + 1;
          await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
          persistSiderTelemetry({
            ts: Date.now(),
            model: request.model,
            strategy: 'controller',
            payloadChars: chunk.length,
            ok: true,
            siderCode: 0,
            ms: Date.now() - uploadStarted,
            hasTools: !!tools.length,
            restoredToolUse: false,
          });
        }
      };
      let contract = buildToolContract(tools);
      if (text.length + Math.min(contract.length, maxChars - 1000) + 512 > maxChars) {
        await upload(text);
        text = '所有上下文已经完整发送。现在根据已提供的规范、历史及最新用户需求继续任务。';
      }
      if (contract.length > maxChars - 1000) {
        const toolsHash = await controllerHash(contract);
        if (task.toolsHash !== toolsHash) {
          await upload(contract);
          task.toolsHash = toolsHash;
          await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
        }
        contract = `使用已经完整登记的工具schema。可选工具名：${
          JSON.stringify(tools.map((tool) => tool.name))
        }。每轮最多一个调用，严格单行格式：[tool_use:ToolName] id=call_<random> input={<compact JSON matching input_schema>}。无需工具时直接回答。`;
      }
      for (let round = 0; round < 5; round++) {
        if (combined.aborted) throw combined.reason;
        const choice = request.tool_choice?.type === 'tool'
          ? `\n本轮必须调用工具${request.tool_choice.name}。`
          : request.tool_choice?.type === 'any'
          ? '\n本轮必须调用一个工具。'
          : '';
        const prompt = tools.length
          ? `${text}\n\n${contract}${choice}\n实际工具由客户端执行，不能在收到成功tool_result之前声称已执行。长正文先StoreContent，再用WriteFromRef；正文引用必须保持原样。`
          : `${text}\n本轮没有可调用的工具，直接回答，不得输出工具意图。`;
        const callStarted = Date.now();
        const upstream = await sendText(prompt);
        const raw = upstream.textParts.join('');
        let calls: AnthropicToolUse[];
        try {
          calls = strictControllerCalls(raw, tools);
          if (task.copyRef && calls[0]?.name === 'StoreContent') {
            throw new ControllerError(
              '逐字复制正文已有可信引用，不能由模型重新生成或重复转义',
            );
          }
          if (
            task.copyRef && calls[0]?.name === 'WriteFromRef' &&
            calls[0].input.content_ref !== task.copyRef
          ) throw new ControllerError('逐字复制必须使用Read源正文引用');
          if (
            task.copyRef && calls[0]?.name === 'Write' &&
            calls[0].input.content !==
              await readControllerText(store, `${owner}:${task.id}:asset:${task.copyRef}`)
          ) throw new ControllerError('Write正文改变了逐字复制的Read源正文');
          if (task.mustWrite && calls.length === 0) {
            throw new ControllerError(
              '正文已保存但尚未提交客户端Write，不能报告完成',
            );
          }
          const exactCommand = contentToText(request.messages.at(-1)!.content).match(
            /<command>\r?\n([\s\S]*?)\r?\n<\/command>/,
          )?.[1];
          if (
            calls[0]?.name === 'Bash' && exactCommand !== undefined &&
            calls[0].input.command !== exactCommand
          ) throw new ControllerError('Bash参数改变了用户明确给定的命令原文');
          if (!raw.trim()) throw new ControllerError('Sider没有输出可用正文');
          if (
            (request.tool_choice?.type === 'any' || request.tool_choice?.type === 'tool') &&
            !calls.length
          ) throw new ControllerError('Sider未满足强制工具选择');
          if (
            request.tool_choice?.type === 'tool' && calls[0] &&
            calls[0].name !== request.tool_choice.name &&
            !(request.tool_choice.name === 'Write' &&
              ['StoreContent', 'WriteFromRef'].includes(calls[0].name))
          ) throw new ControllerError('Sider调用与tool_choice不一致');
        } catch (error) {
          persistSiderTelemetry({
            ts: Date.now(),
            model: request.model,
            strategy: 'controller',
            payloadChars: prompt.length,
            ok: false,
            siderCode: 0,
            ms: Date.now() - callStarted,
            hasTools: !!tools.length,
            restoredToolUse: false,
          });
          if (++corrections > 2) throw error;
          const name = raw.match(/\[tool_use:([^\]]+)\]/)?.[1];
          const declared = tools.find((tool) => tool.name === name);
          text = `代理校验失败，尚未执行任何工具：${
            error instanceof Error ? error.message : '参数无效'
          }。请重新给出严格有效的工具意图，不改变原任务。${
            declared ? `本工具完整定义：${JSON.stringify(declared)}` : ''
          }${task.copyRef ? `必须使用Read源正文引用${task.copyRef}进行WriteFromRef。` : ''}`;
          continue;
        }
        persistSiderTelemetry({
          ts: Date.now(),
          model: request.model,
          strategy: 'controller',
          payloadChars: prompt.length,
          ok: true,
          siderCode: 0,
          ms: Date.now() - callStarted,
          hasTools: !!tools.length,
          restoredToolUse: !!calls.length,
        });
        const call = calls[0];
        if (call?.name === 'StoreContent') {
          if (Object.keys(call.input).some((key) => key !== 'content')) {
            throw new ControllerError(
              '内部正文保存包含未声明字段',
            );
          }
          const content = String(call.input.content),
            ref = `sha256:${await controllerHash(content)}`;
          await saveControllerText(store, `${owner}:${task.id}:asset:${ref}`, content);
          if (!task.refs.includes(ref)) task.refs.push(ref);
          task.mustWrite = true;
          if (task.refs.length > 32) throw new ControllerError('任务正文引用数量超过上限');
          await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
          text = `[tool_result] tool_use_id=${call.id}\n${
            JSON.stringify({
              stored: true,
              content_ref: ref,
              sha256: ref.slice(7),
              characters: content.length,
            })
          }\n请继续原任务，用WriteFromRef提交完整正文。`;
          continue;
        }
        if (call?.name === 'WriteFromRef') {
          if (
            Object.keys(call.input).some((key) => !['file_path', 'content_ref'].includes(key))
          ) throw new ControllerError('内部正文引用包含未声明字段');
          if (!task.refs.includes(call.input.content_ref)) {
            throw new ControllerError(
              '正文引用不属于当前任务',
            );
          }
          const content = await readControllerText(
            store,
            `${owner}:${task.id}:asset:${call.input.content_ref}`,
          );
          call.name = 'Write';
          call.input = { file_path: call.input.file_path, content };
          const error = declaredToolInputError(clientTools, 'Write', call.input);
          if (!isValidWriteInput(call.input) || error) {
            task.mustWrite = true;
            await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
            if (++corrections > 2) {
              throw new ControllerError(
                `正文装配后的Write参数无效：${error ?? '路径或正文无效'}`,
              );
            }
            text =
              `[tool_result] tool_use_id=${call.id} is_error=true\n尚未执行写入。代理校验失败：${
                error ?? '路径或正文无效'
              }。请修正参数重新调用，不能报告已完成。客户端Write完整定义：${
                JSON.stringify(clientTools.find((tool) => tool.name === 'Write'))
              }`;
            continue;
          }
        }
        // 对外id由代理生成，防止模型重复call_1导致会话归属冲突。
        task.pending = [];
        if (call) {
          if (call.name === 'Write') task.mustWrite = false;
          const upstreamId = call.id;
          call.id = `toolu_${crypto.randomUUID().replaceAll('-', '')}`;
          task.pending.push({
            id: call.id,
            upstreamId,
            name: call.name,
            ...(call.name === 'Read' && call.input.limit === undefined &&
                call.input.offset === undefined && typeof call.input.file_path === 'string'
              ? { readPath: call.input.file_path }
              : {}),
          });
          await store.write(`${owner}:tool:${call.id}`, task.id, RETENTION_MS);
        }
        const response: AnthropicResponse = {
          id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: call ? [call] : [{ type: 'text', text: raw }],
          stop_reason: call ? 'tool_use' : 'end_turn',
          usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
          sider_session: { conversation_id: task.id },
        };
        if (!call) {
          const stopped = applyStopSequences(response.content, request.stop_sequences);
          response.content = stopped.content;
          if (stopped.matched) {
            response.stop_reason = 'stop_sequence';
            response.stop_sequence = stopped.matched;
          }
        }
        if (combined.aborted) throw combined.reason;
        await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
        await store.write(`${owner}:session:${task.id}`, task.id, RETENTION_MS);
        await store.write(
          `${owner}:history:${await historyKey(request, [...request.messages, {
            role: 'assistant',
            content: response.content,
          }])}`,
          task.id,
          RETENTION_MS,
        );
        const responseKey = `${owner}:${task.id}:reply:${response.id}`;
        await saveControllerText(store, responseKey, JSON.stringify(response));
        await store.write(replayKey, { responseKey }, RETENTION_MS);
        recordUsage({
          model: request.model,
          backend: 'sider',
          fallback: false,
          toolUses: call ? [call.name] : [],
          stream: !!request.stream,
          ms: Date.now() - started,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        });
        return response;
      }
      throw new ControllerError('主控内部保存或参数纠正超过单请求轮数，检查点保留');
    },
  );
}
