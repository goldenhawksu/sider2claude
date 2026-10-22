import { controllerRoutingStatus } from '../config/backends.js';
import { recordSiderActivity } from './sider-activity.js';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicTool,
  AnthropicToolUse,
} from '../types/anthropic.js';
import { getEnv } from './env.js';
import { getModelById, normalizeModelId } from '../config/models.js';
import { siderClient } from './sider-client.js';
import { SiderUpstreamError } from './sider-client.js';
import { buildSiderMessageText, contentToText } from './message-format.js';
import { buildToolContract } from './textual-tool-use.js';
import { declaredToolInputError, validDeclaredToolInput } from './tool-input-validation.js';
import { isValidWriteInput } from './textual-tool-use.js';
import { getControllerStore } from './controller-storage.js';
import type { ControllerStore } from './controller-memory-store.js';
import { persistSiderTelemetry } from './sider-telemetry.js';
import { recordCachedReplay, recordUsage } from './usage-stats.js';
import { applyStopSequences } from './stop-sequences.js';

const RETENTION_MS = 24 * 60 * 60_000;
const MIN_DIRECT_WRITE_VERIFY_CHARS = 4_000;
const MAX_WRITE_VERIFY_CHARS = 64_000;
const MAX_READ_LINES = 2_000;
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
interface WriteIntegrity {
  contentRef: string;
  filePath: string;
  sha256: string;
  characters: number;
  verification: 'readback' | 'dispatch';
}
interface PendingTool {
  id: string;
  upstreamId: string;
  name?: string;
  readPath?: string;
  writeIntegrity?: WriteIntegrity;
}
interface Task {
  id: string;
  model: string;
  cid: string;
  parent: string;
  refs: string[];
  pending: PendingTool[];
  uploads?: Record<string, number>;
  pendingUpload?: string;
  pendingHistory?: string;
  pendingUsage?: { input_tokens: number; output_tokens: number };
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
export const controllerEnabled = () => controllerRoutingStatus().enabled;
export const controllerHandlesRequest = (request: AnthropicRequest) =>
  controllerEnabled() && (!request.stream || controllerRoutingStatus().streaming);
export async function controllerHash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 发送前的无内容诊断，用于区分输入损坏与上游展示问题。 */
export function controllerPayloadDiagnostics(text: string) {
  return {
    payloadChars: text.length,
    payloadUtf8Bytes: new TextEncoder().encode(text).length,
    questionMarks: [...text].filter((char) => char === '?').length,
    replacementCharacters: [...text].filter((char) => char === '\uFFFD').length,
  };
}

// 分块后每个KV值小于64KiB；哈希校验不能依赖expireIn是否及时回收。
export async function saveControllerText(
  store: ControllerStore,
  key: string,
  text: string,
): Promise<void> {
  if (text.length > 512_000) throw new ControllerError('待登记内容超过可信内容库单项512000字符容量，请压缩会话历史或缩短正文', 400);
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
/** 真实Claude Code Read返回连续“行号+制表符”；拒绝截断、跳号和超出默认Read上限的正文。 */
export function extractReadText(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines.length >= MAX_READ_LINES) return null;
  const decoded: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\d+)\t(.*)$/);
    if (!match || Number(match[1]) !== index + 1) return null;
    decoded.push(match[2]!);
  }
  return decoded.join('\n');
}
/** JSON复制沿用通用Read解码，并额外要求语法完整。 */
export function extractReadJson(text: string): string | null {
  const content = extractReadText(text);
  if (content === null) return null;
  try {
    JSON.parse(content);
    return content;
  } catch {
    return null;
  }
}
function writeIntegrityReceipt(integrity: WriteIntegrity, verified: boolean): string {
  return JSON.stringify({
    written: true,
    verified,
    verification: integrity.verification,
    content_ref: integrity.contentRef,
    sha256: integrity.sha256,
    characters: integrity.characters,
    file_path: integrity.filePath,
  });
}
function writeIntegrityFailure(
  integrity: WriteIntegrity,
  upstreamId: string,
  error: string,
): string {
  return `[tool_result] tool_use_id=${upstreamId} is_error=true\n${
    JSON.stringify({
      written: true,
      verified: false,
      verification: integrity.verification,
      content_ref: integrity.contentRef,
      sha256: integrity.sha256,
      characters: integrity.characters,
      file_path: integrity.filePath,
      error,
    })
  }`;
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
    JSON.stringify({ model: normalizeModelId(request.model), system: request.system, messages: normalized }),
  );
}
async function resolveTask(
  store: ControllerStore,
  owner: string,
  request: AnthropicRequest,
  session?: string,
): Promise<Task> {
  let id: string | null = session ? await store.read(`${owner}:session:${session}`) : null;
  let lastAssistant = -1;
  request.messages.forEach((message, index) => {
    if (message.role === 'assistant') lastAssistant = index;
  });
  const historyId = lastAssistant >= 0
    ? await store.read<string>(
      `${owner}:history:${await historyKey(request, request.messages.slice(0, lastAssistant + 1))}`,
    )
    : null;
  const results = pendingUserMessages(request).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result')
      : []
  );
  if (results.length) {
    if (new Set(results.map((block) => block.tool_use_id)).size !== results.length) {
      throw new ControllerError('工具结果重复，不能重复处理', 400);
    }
    const ids = await Promise.all(
      results.map((block) => store.read<string>(`${owner}:tool:${block.tool_use_id}`)),
    );
    const mappedIds = ids.filter((value): value is string => !!value);
    if (new Set(mappedIds).size > 1) {
      throw new ControllerError('工具结果属于不同主控任务', 400);
    }
    const mappedId = mappedIds[0] ?? null;
    const candidateId = id ?? historyId;
    if (mappedId && candidateId && mappedId !== candidateId) {
      throw new ControllerError('会话与工具结果归属不一致', 400);
    }
    id = mappedId ?? candidateId;
  }
  id ??= historyId;
  let task = id ? await store.read<Task>(`${owner}:task:${id}`) : null;
  if (!task && !id && !session && !results.length && request.messages.length > 1) {
    const pendingHash = await historyKey(request, request.messages.slice(0, -1));
    const pendingId = await store.read<string>(`${owner}:pending-history:${pendingHash}`);
    const pendingTask = pendingId ? await store.read<Task>(`${owner}:task:${pendingId}`) : null;
    if (pendingTask?.pendingHistory === pendingHash) task = pendingTask;
  }
  const model = getModelById(request.model)!.siderModel;
  if (task && getModelById(task.model)?.siderModel !== model) {
    throw new ControllerError('恢复主控会话时不能静默切换模型', 400);
  }
  if (!task && results.length) {
    // 旧后端或过期实例可能没有检查点；只从最近助手轮的完整调用/结果配对重建。
    const content = request.messages[lastAssistant]?.content;
    const calls = Array.isArray(content)
      ? content.filter((block) => block.type === 'tool_use')
      : [];
    if (
      calls.length !== results.length ||
      new Set(calls.map((call) => call.id)).size !== calls.length ||
      calls.some((call) => !call.id || !call.name || !call.input ||
        typeof call.input !== 'object' || Array.isArray(call.input)) ||
      results.some((block) => !calls.some((call) => call.id === block.tool_use_id))
    ) throw new ControllerError('工具结果缺少完整且唯一配对的历史调用，无法恢复主控任务', 400);
    task = {
      id: crypto.randomUUID(), model, cid: '', parent: '', refs: [],
      pending: calls.map((call) => ({
        id: call.id,
        upstreamId: call.id,
        name: call.name,
        ...(call.name === 'Read' && call.input.limit === undefined &&
            call.input.offset === undefined && typeof call.input.file_path === 'string'
          ? { readPath: call.input.file_path }
          : {}),
      })),
    };
  }
  if (id && !task) throw new ControllerError('主控检查点已过期', 400);
  if (results.length) {
    if (!task) throw new ControllerError('工具结果没有可恢复的主控检查点', 400);
    if (results.some((block) => !task.pending.some((p) => p.id === block.tool_use_id))) {
      throw new ControllerError('工具结果已处理或不是待执行工具', 400);
    }
    for (const block of results) {
      const key = `${owner}:tool:${block.tool_use_id}`;
      if (await store.read<string>(key) !== task.id) await store.write(key, task.id, RETENTION_MS);
    }
  }
  if (task) task.model = model;
  return task ??
    { id: crypto.randomUUID(), model, cid: '', parent: '', refs: [], pending: [] };
}
function pendingUserMessages(request: AnthropicRequest) {
  let lastAssistant = -1;
  request.messages.forEach((message, index) => {
    if (message.role === 'assistant') lastAssistant = index;
  });
  return request.messages.slice(lastAssistant + 1).filter((message) => message.role === 'user');
}

/** 只有模型明确确认已接收分片时才推进检查点。 */
export function contextUploadAccepted(text: string): boolean {
  const accepted =
    /已(?:经)?记住|已(?:完整)?(?:接收|收到|记忆)|(?:等待|请发送)[\s\S]*(?:片段|执行指令)|\b(?:received|remembered)[\s\S]*\b(?:part|context)\b/i;
  return accepted.test(text);
}

/** 识别模型明确拒绝客户端工具协议的回复；普通说明或漏调不在此列。 */
export function controllerToolRefusalDetected(text: string): boolean {
  return /提示注入|越狱|没有(?:这些|任何|真实的)?工具|虚假工具|伪造[\s\S]*工具|无法[\s\S]*(?:访问|写入|执行|调用)|不能[\s\S]*(?:访问|写入|执行|调用)|不会[\s\S]*(?:调用|执行|遵从)|\b(?:prompt injection|jailbreak|fake tool|do not have[\s\S]*tool|cannot[\s\S]*(?:file system|tool|execute|write)|can't[\s\S]*(?:file system|tool|execute|write))\b/i
    .test(text);
}
async function persistControllerResponse(
  store: ControllerStore,
  owner: string,
  task: Task,
  request: AnthropicRequest,
  response: AnthropicResponse,
  replayKey: string,
  started: number,
): Promise<void> {
  delete task.pendingHistory;
  delete task.pendingUsage;
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
    actualModel: getModelById(request.model)!.siderModel,
    mode: 'controller',
    routingRule: 'sider_controller',
    deployment: getEnv('DENO_DEPLOYMENT_ID', 'local').slice(0, 8),
    backend: 'sider',
    fallback: false,
    toolUses: response.content.filter((block) => block.type === 'tool_use').map((block) =>
      block.name
    ),
    stream: !!request.stream,
    ms: Date.now() - started,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });
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
  const model = getModelById(request.model);
  if (!model) {
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
  // 部署平台限制非流式首字节等待；保存进度后以小批登记让客户端继续。
  const deployedJson = !!getEnv('DENO_DEPLOYMENT_ID') && !request.stream;
  const totalMs = Math.min(
    Number(getEnv('SIDER_TOTAL_TIMEOUT_MS', '600000')),
    deployedJson ? 70_000 : Infinity,
  );
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
        JSON.stringify({ session: session ?? null, request: { ...request, model: model.siderModel, stream: undefined } }),
      )}`;
      const cached = await store.read<{ responseKey: string }>(replayKey);
      if (cached) {
        recordCachedReplay();
        recordSiderActivity(model.siderModel, { cachedReplays: 1 });
        return { ...JSON.parse(await readControllerText(store, cached.responseKey)), model: request.model };
      }
      const cooldown = await store.read<number>(
        `cooldown:${await controllerHash(siderToken)}:${model.siderModel}`,
      );
      if (cooldown && cooldown > Date.now()) {
        recordSiderActivity(model.siderModel, { cooldownRejections: 1 });
        throw new ControllerError(
          'Sider模型额度仍在冷却，主控任务保留',
          429,
          cooldown - Date.now(),
        );
      }
      const inflightKey = `${replayKey}:task`;
      const resumeId = await store.read<string>(inflightKey);
      const task = await resolveTask(store, owner, request, session ?? resumeId ?? undefined);
      task.pendingHistory = await historyKey(request);
      task.exactCopy ??= /逐字复制|原样复制/.test(contentToText(request.messages[0]!.content));
      await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
      await store.write(`${owner}:session:${task.id}`, task.id, RETENTION_MS);
      await store.write(inflightKey, task.id, RETENTION_MS);
      await store.write(`${owner}:pending-history:${task.pendingHistory}`, task.id, RETENTION_MS);
      const clientTools = request.tool_choice?.type === 'none' ? [] : request.tools ?? [];
      if (
        clientTools.some((t) => ['StoreContent', 'WriteFromRef'].includes(t.name))
      ) throw new ControllerError('客户端工具名与代理内部工具冲突', 400);
      const tools = clientTools.some((t) => t.name === 'Write')
        ? [...clientTools, ...INTERNAL_TOOLS]
        : clientTools;
      let writeIntegrityResult: string | undefined;
      for (const message of pendingUserMessages(request)) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type !== 'tool_result') continue;
          const pending = task.pending.find((p) => p.id === block.tool_use_id);
          if (block.is_error) {
            if (pending?.name === 'Write') task.mustWrite = true;
            if (pending?.name === 'Read' && pending.writeIntegrity) {
              task.mustWrite = true;
              writeIntegrityResult = writeIntegrityFailure(
                pending.writeIntegrity,
                pending.upstreamId,
                '写后回读失败，必须使用原content_ref重新写入并校验',
              );
            }
            continue;
          }
          if (pending?.name === 'Write' && pending.writeIntegrity) {
            if (pending.writeIntegrity.verification === 'readback') {
              const call: AnthropicToolUse = {
                type: 'tool_use',
                id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
                name: 'Read',
                input: { file_path: pending.writeIntegrity.filePath },
              };
              task.pending = [{
                id: call.id,
                upstreamId: pending.upstreamId,
                name: 'Read',
                readPath: pending.writeIntegrity.filePath,
                writeIntegrity: pending.writeIntegrity,
              }];
              await store.write(`${owner}:tool:${call.id}`, task.id, RETENTION_MS);
              const response: AnthropicResponse = {
                id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
                type: 'message',
                role: 'assistant',
                model: request.model,
                content: [call],
                stop_reason: 'tool_use',
                usage: { input_tokens: 0, output_tokens: 0 },
                sider_session: { conversation_id: task.id },
              };
              await persistControllerResponse(
                store,
                owner,
                task,
                request,
                response,
                replayKey,
                started,
              );
              return response;
            }
            task.mustWrite = false;
            writeIntegrityResult = `[tool_result] tool_use_id=${pending.upstreamId}\n${
              writeIntegrityReceipt(pending.writeIntegrity, false)
            }`;
            continue;
          }
          if (pending?.name === 'Read' && pending.writeIntegrity) {
            const content = extractReadText(
              typeof block.content === 'string'
                ? block.content
                : contentToText(block.content ?? []),
            );
            if (content === null) {
              task.mustWrite = true;
              writeIntegrityResult = writeIntegrityFailure(
                pending.writeIntegrity,
                pending.upstreamId,
                '写后回读不完整，必须使用原content_ref重新写入并校验',
              );
              continue;
            }
            const actualHash = await controllerHash(content);
            if (
              actualHash !== pending.writeIntegrity.sha256 ||
              content.length !== pending.writeIntegrity.characters
            ) {
              task.mustWrite = true;
              writeIntegrityResult = writeIntegrityFailure(
                pending.writeIntegrity,
                pending.upstreamId,
                `写后回读不匹配，实际sha256=${actualHash}，实际字符数=${content.length}；必须使用原content_ref重新写入并校验`,
              );
              continue;
            }
            task.mustWrite = false;
            writeIntegrityResult = `[tool_result] tool_use_id=${pending.upstreamId}\n${
              writeIntegrityReceipt(pending.writeIntegrity, true)
            }`;
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
      let corrections = 0;
      let totalInputTokens = task.pendingUsage?.input_tokens ?? 0;
      let totalOutputTokens = task.pendingUsage?.output_tokens ?? 0;
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
            400,
          );
        }
        const callStarted = Date.now();
        let upstream;
        try {
          const nextAt = await store.read<number>(paceKey);
          if (nextAt && nextAt > Date.now()) {
            await delay(nextAt - Date.now(), undefined, { signal: combined });
          }
          if (combined.aborted) throw combined.reason;
          const body = {
            cid: task.cid,
            ...(task.parent ? { parent_message_id: task.parent } : {}),
            model: model.siderModel,
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
              ...controllerPayloadDiagnostics(prompt),
              ok: false,
              siderCode: 0,
              ms: Date.now() - callStarted,
              hasTools: !!tools.length,
              restoredToolUse: false,
              phase: 'upstream',
              outcome: 'connect_retry',
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
            upstream = await siderClient.chat(body, siderToken, combined);
          }
        } catch (error) {
          persistSiderTelemetry({
            ts: Date.now(),
            model: request.model,
            strategy: 'controller',
            ...controllerPayloadDiagnostics(prompt),
            ok: false,
            siderCode: error instanceof SiderUpstreamError ? error.siderCode : 0,
            ms: Date.now() - callStarted,
            hasTools: !!tools.length,
            restoredToolUse: false,
            phase: 'upstream',
            outcome: 'upstream_error',
          });
          if (error instanceof SiderUpstreamError && error.siderCode === 1135) {
            const wait = error.retryAfterMs ?? 60_000;
            await store.write(
              `cooldown:${await controllerHash(siderToken)}:${model.siderModel}`,
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
        if (upstream.model !== model.siderModel) {
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
        totalInputTokens += Math.ceil(prompt.length / 4);
        totalOutputTokens += Math.ceil(
          (upstream.textParts.join('').length + upstream.reasoningParts.join('').length) / 4,
        );
        task.pendingUsage = { input_tokens: totalInputTokens, output_tokens: totalOutputTokens };
        await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
        return upstream;
      };
      let uploaded = 0;
      const upload = async (context: string) => {
        const hash = await controllerHash(context), size = maxChars - 256;
        const count = Math.ceil(context.length / size);
        task.uploads ??= {};
        if ((task.uploads[hash] ?? 0) < count && task.pendingUpload !== hash) {
          await saveControllerText(store, `${owner}:${task.id}:upload:${hash}`, context);
          task.pendingUpload = hash;
          await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
        }
        for (let i = task.uploads[hash] ?? 0; i < count; i++) {
          if (deployedJson && uploaded >= 2) {
            throw new ControllerError(`上下文登记进度${i}/${count}，检查点已保存，请自动重试或继续`, 429, 1000);
          }
          const uploadStarted = Date.now();
          const chunk = `以下是当前任务上下文片段${
            i + 1
          }/${count}。仅记住，暂时不执行任务、不调用工具；只确认已记住，所有片段发送完后再执行。\n${
            context.slice(i * size, (i + 1) * size)
          }`;
          let result;
          try {
            result = await sendText(chunk);
          } catch (error) {
            if (deployedJson && deadline.aborted && !signal?.aborted) {
              throw new ControllerError('上下文登记达到本次时限，检查点已保存，请自动重试或继续', 429, 1000);
            }
            throw error;
          }
          if (!contextUploadAccepted(result.textParts.join(''))) {
            persistSiderTelemetry({
              ts: Date.now(),
              model: request.model,
              strategy: 'controller',
              ...controllerPayloadDiagnostics(chunk),
              ok: false,
              siderCode: 0,
              ms: Date.now() - uploadStarted,
              hasTools: !!tools.length,
              restoredToolUse: false,
              phase: 'context_upload',
              outcome: 'context_unconfirmed',
            });
            throw new ControllerError(
              `Sider未确认上下文分片${i + 1}/${count}，已停止后续发送`,
            );
          }
          uploaded++;
          recordSiderActivity(model.siderModel, { contextUploads: 1 });
          task.uploads[hash] = i + 1;
          await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
          persistSiderTelemetry({
            ts: Date.now(),
            model: request.model,
            strategy: 'controller',
            ...controllerPayloadDiagnostics(chunk),
            ok: true,
            siderCode: 0,
            ms: Date.now() - uploadStarted,
            hasTools: !!tools.length,
            restoredToolUse: false,
            phase: 'context_upload',
            outcome: 'context_accepted',
          });
        }
        if (task.pendingUpload === hash) {
          delete task.pendingUpload;
          await store.write(`${owner}:task:${task.id}`, task, RETENTION_MS);
        }
        // 最后一批也要结束当前请求，给下一轮实际执行保留完整期限。
        if (deployedJson && uploaded >= 2) {
          throw new ControllerError(
            `上下文登记进度${count}/${count}，检查点已保存，请自动重试或继续`,
            429,
            1000,
          );
        }
      };
      // 必须先续传原始上下文尾部，再根据当前会话发送新增消息。
      if (task.pendingUpload) {
        await upload(await readControllerText(store, `${owner}:${task.id}:upload:${task.pendingUpload}`));
      }
      let text = writeIntegrityResult ??
        (task.cid
          ? pendingUserMessages(request).map((message) => contentToText(message.content)).join(
            '\n\n',
          )
          : buildSiderMessageText(request, {
            includeHistory: request.messages.length > 1,
            currentUserInput: contentToText(request.messages.at(-1)!.content),
          }));
      for (const p of task.pending) {
        text = text.replace(
          `tool_use_id=${p.id}`,
          `tool_use_id=${p.upstreamId}`,
        );
      }
      if (!task.cid && task.pending.length) {
        text += '\n\n代理检查点已从以上完整历史恢复。已有tool_result的工具已经执行，禁止重新执行；后台任务应按返回的任务ID或输出路径继续查询，不能把后台启动当作任务完成。';
      }
      if (task.refs.length) text += `\n代理可信正文引用：${JSON.stringify(task.refs)}`;
      if (task.copyRef) {
        text +=
          `\n当前逐字复制任务的Read JSON正文已由代理去除连续行号并完整保存，content_ref=${task.copyRef}。必须使用WriteFromRef引用该正文，禁止重写、二次转义或再次StoreContent。`;
      }
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
          const forcedToolMissing = error instanceof ControllerError &&
            error.message === 'Sider未满足强制工具选择';
          const toolProtocolRefused = forcedToolMissing && controllerToolRefusalDetected(raw);
          persistSiderTelemetry({
            ts: Date.now(),
            model: request.model,
            strategy: 'controller',
            ...controllerPayloadDiagnostics(prompt),
            ok: false,
            siderCode: 0,
            ms: Date.now() - callStarted,
            hasTools: !!tools.length,
            restoredToolUse: false,
            phase: 'tool_selection',
            outcome: toolProtocolRefused
              ? 'tool_protocol_refused'
              : forcedToolMissing
              ? 'forced_tool_missing'
              : 'invalid_tool_intent',
            correctionCount: corrections,
          });
          if (toolProtocolRefused) {
            throw new ControllerError('Sider拒绝客户端工具协议，已停止重复纠错');
          }
          const correctionLimit = forcedToolMissing ? 1 : 2;
          if (++corrections > correctionLimit) throw error;
          recordSiderActivity(model.siderModel, { corrections: 1 });
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
          ...controllerPayloadDiagnostics(prompt),
          ok: true,
          siderCode: 0,
          ms: Date.now() - callStarted,
          hasTools: !!tools.length,
          restoredToolUse: !!calls.length,
          phase: 'tool_selection',
          outcome: calls.length ? 'tool_restored' : 'text_answer',
          correctionCount: corrections,
        });
        const call = calls[0];
        let writeIntegrity: WriteIntegrity | undefined;
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
          const contentRef = String(call.input.content_ref);
          const filePath = String(call.input.file_path);
          writeIntegrity = {
            contentRef,
            filePath,
            sha256: contentRef.slice('sha256:'.length),
            characters: content.length,
            verification: content.length <= MAX_WRITE_VERIFY_CHARS &&
                content.split(/\r?\n/).length < MAX_READ_LINES &&
                clientTools.some((tool) => tool.name === 'Read')
              ? 'readback'
              : 'dispatch',
          };
          call.name = 'Write';
          call.input = { file_path: filePath, content };
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
        if (
          call?.name === 'Write' && !writeIntegrity &&
          String(call.input.content).length >= MIN_DIRECT_WRITE_VERIFY_CHARS
        ) {
          const content = String(call.input.content);
          const contentRef = `sha256:${await controllerHash(content)}`;
          await saveControllerText(store, `${owner}:${task.id}:asset:${contentRef}`, content);
          if (!task.refs.includes(contentRef)) task.refs.push(contentRef);
          if (task.refs.length > 32) throw new ControllerError('任务正文引用数量超过上限');
          writeIntegrity = {
            contentRef,
            filePath: String(call.input.file_path),
            sha256: contentRef.slice('sha256:'.length),
            characters: content.length,
            verification: content.length <= MAX_WRITE_VERIFY_CHARS &&
                content.split(/\r?\n/).length < MAX_READ_LINES &&
                clientTools.some((tool) => tool.name === 'Read')
              ? 'readback'
              : 'dispatch',
          };
        }
        // 对外id由代理生成，防止模型重复call_1导致会话归属冲突。
        task.pending = [];
        if (call) {
          if (call.name === 'Write') task.mustWrite = !!writeIntegrity;
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
            ...(writeIntegrity ? { writeIntegrity } : {}),
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
        await persistControllerResponse(
          store,
          owner,
          task,
          request,
          response,
          replayKey,
          started,
        );
        return response;
      }
      throw new ControllerError('主控内部保存或参数纠正超过单请求轮数，检查点保留');
    },
  );
}
