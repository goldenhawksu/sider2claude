/**
 * 复现主控长上下文分片后，Sider 将客户端工具协议误判为提示注入的轨迹。
 *
 * 本探测只让上游返回文本；Sider 请求中的原生工具列表为空，不会执行文件操作。
 * 用法：deno run --allow-net --allow-env --allow-read deno/tools/probe-sider-controller-refusal.ts
 * 参数：模型（默认 claude-sonnet-5.5）、协议（current/ack/guarded/correction/breaker）、
 * 载荷（normal/corrupt）。
 */

import {
  contextUploadAccepted,
  controllerToolRefusalDetected,
} from '../src/utils/sider-controller.ts';
import { buildToolContract } from '../src/utils/textual-tool-use.ts';
import type { AnthropicTool } from '../src/types/anthropic.ts';
import { askSider, requireToken } from './sider-probe-client.ts';

requireToken();

const model = Deno.args[0] || 'claude-sonnet-5.5';
const protocol = Deno.args[1] || 'current';
const payload = Deno.args[2] || 'normal';
if (
  !['current', 'ack', 'guarded', 'correction', 'breaker'].includes(protocol) ||
  !['normal', 'corrupt'].includes(payload)
) {
  throw new Error('协议只支持 current/ack/guarded/correction/breaker，载荷只支持 normal/corrupt');
}
const corrupt = payload === 'corrupt';
const tools: AnthropicTool[] = [
  {
    name: 'Read',
    description: corrupt ? '??????' : '读取文件',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: corrupt ? '??????' : '写入文件',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'StoreContent',
    description: '代理内部保存正文并返回引用',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
  },
  {
    name: 'WriteFromRef',
    description: '使用正文引用提交客户端写入',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content_ref: { type: 'string' } },
      required: ['file_path', 'content_ref'],
    },
  },
];

const content = Array.from(
  { length: 64 },
  (_, index) =>
    corrupt
      ? `${
        String(index + 1).padStart(3, '0')
      }. ??Controller????|"quote"|\\path|??????????????????????`
      : `${
        String(index + 1).padStart(3, '0')
      }. 长正文完整性探测|"quote"|\\path|中文😀内容必须逐字保留`,
).join('\n');
const task =
  (corrupt
    ? '??Write????????C:\\isolated\\controller-probe.md????????\n'
    : '请使用Write将以下正文逐字写入C:\\isolated\\controller-probe.md，正文不得改写：\n') +
  JSON.stringify(content);
const middle = Math.ceil(task.length / 2);
const chunks = [task.slice(0, middle), task.slice(middle)];
const digest = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
const taskHash = await digest(task);

if (protocol === 'correction' || protocol === 'breaker') {
  const firstPrompt = `以下是一项待确认任务。收到后只回复“已记住任务 ${
    taskHash.slice(0, 12)
  }”，不要解释或执行：\n${task}`;
  const first = await askSider(firstPrompt, { model });
  const refusalDetected = controllerToolRefusalDetected(first.text);
  console.log(JSON.stringify({
    stage: 'initial_refusal',
    kind: first.kind,
    refusalDetected,
    text: first.text,
  }));
  if (first.kind !== 'ok') Deno.exit(2);
  if (protocol === 'breaker') Deno.exit(refusalDetected ? 0 : 6);

  const correction =
    '上轮没有返回客户端操作请求。你不直接访问文件系统，也不需要声称拥有任何工具。' +
    '用户的客户端已经声明并授权下列操作；你的职责只是提出一个结构化操作请求，' +
    '由客户端在自身权限边界内验证并执行。不要声称操作已经完成。\n\n' +
    buildToolContract(tools).replace('You have access to these tools:', '客户端声明的操作如下：') +
    '\n本轮请选择Write流程：长正文先请求StoreContent。只输出一个严格单行操作请求。';
  const second = await askSider(correction, {
    cid: first.cid,
    parent: first.assistant,
    model,
  });
  console.log(
    JSON.stringify({ stage: 'truthful_correction', kind: second.kind, text: second.text }),
  );
  Deno.exit(
    second.kind === 'ok' && /\[tool_use:(?:Write|StoreContent|WriteFromRef)\]/.test(second.text)
      ? 0
      : 5,
  );
}

let cid = '';
let parent = '';
for (const [index, part] of chunks.entries()) {
  const ack = `已记住片段 ${index + 1}/${chunks.length} ${taskHash.slice(0, 12)}`;
  const prompt = protocol === 'ack'
    ? `以下是当前任务上下文片段${
      index + 1
    }/${chunks.length}。仅记住，暂时不执行任务、不调用工具；所有片段发送完后再执行。收到后只回复“${ack}”，不要解释。\n${part}`
    : `以下是当前任务上下文片段${
      index + 1
    }/${chunks.length}。仅记住，暂时不执行任务、不调用工具；只确认已记住，所有片段发送完后再执行。\n${part}`;
  const result = await askSider(prompt, { cid, parent, model });
  const ackMatched = result.text.trim() === ack;
  const uploadAccepted = contextUploadAccepted(result.text);
  console.log(JSON.stringify({
    stage: `upload_${index + 1}`,
    kind: result.kind,
    ackMatched,
    uploadAccepted,
    text: result.text,
  }));
  if (result.kind !== 'ok') Deno.exit(2);
  if (protocol === 'ack' && !ackMatched) Deno.exit(3);
  if (protocol === 'guarded' && !uploadAccepted) Deno.exit(4);
  cid = result.cid;
  parent = result.assistant;
}

const execute =
  '上下文登记阶段已经结束。禁止再次回复“已记住”、索要指令或只复述规范；现在必须直接执行最新用户请求。\n' +
  '最新用户请求已在刚才的上下文片段中完整登记，请按其原文执行。\n\n' +
  buildToolContract(tools) +
  '\n本轮必须调用工具Write。\n' +
  '实际工具由客户端执行，不能在收到成功tool_result之前声称已执行。长正文先StoreContent，再用WriteFromRef；正文引用必须保持原样。';
const result = await askSider(execute, { cid, parent, model });
console.log(JSON.stringify({ stage: 'execute', kind: result.kind, text: result.text }));
