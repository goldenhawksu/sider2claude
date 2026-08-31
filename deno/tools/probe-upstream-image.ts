/**
 * 一次性侦察：上游对图片的接受条件。
 *
 * A/B 对比发现同一张 2x2 PNG，GLM 能正确识别颜色，DeepSeek 侧直接 400：
 * 「You have uploaded an unsupported image ... formats: webp, png, jpeg, and gif」。
 * 传的确实是 `image/png` + PNG base64，所以问题不在 media_type，怀疑是尺寸或
 * 编码细节上的校验差异。
 *
 * 本脚本回答：到底哪一档能过？这决定了服务端要不要（以及怎么）介入。
 */

import { loadBackendConfig } from '../src/config/backends.ts';

const { baseUrl, apiKey, model } = loadBackendConfig().deepseek;

/** 生成 w×h 的纯色 PNG（无压缩 deflate，手写 chunk）。 */
function solidPng(w: number, h: number, r: number, g: number, b: number): string {
  const raw: number[] = [];
  for (let y = 0; y < h; y++) {
    raw.push(0);
    for (let x = 0; x < w; x++) raw.push(r, g, b);
  }
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf: number[]) => {
    let c = 0xffffffff;
    for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0));
    return [...be32(data.length), ...t, ...data, ...be32(crc32([...t, ...data]))];
  };
  const z: number[] = [0x78, 0x01];
  let off = 0;
  while (off < raw.length) {
    const len = Math.min(65535, raw.length - off);
    const last = off + len >= raw.length ? 1 : 0;
    z.push(last, len & 255, (len >> 8) & 255, ~len & 255, (~len >> 8) & 255);
    for (let i = 0; i < len; i++) z.push(raw[off + i]);
    off += len;
  }
  let a = 1, b2 = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b2 = (b2 + a) % 65521;
  }
  z.push(...be32(((b2 << 16) | a) >>> 0));

  const png = [
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', [...be32(w), ...be32(h), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', z),
    ...chunk('IEND', []),
  ];
  let s = '';
  for (const byte of png) s += String.fromCharCode(byte);
  return btoa(s);
}

async function attempt(label: string, data: string, mediaType = 'image/png'): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: '这张图是什么颜色？只答颜色名。' },
        ],
      }],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    const msg = JSON.parse(body)?.error?.message ?? body;
    console.log(`  ✗ ${label.padEnd(26)} HTTP ${response.status}: ${String(msg).slice(0, 90)}`);
    return;
  }
  const data2 = JSON.parse(body) as { content?: Array<{ type: string; text?: string }> };
  const text = (data2.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log(`  ✓ ${label.padEnd(26)} ${JSON.stringify(text.slice(0, 40))}`);
}

console.log(`baseUrl=${baseUrl} model=${model}\n`);
console.log('=== 尺寸阶梯（全是同样方式生成的纯红 PNG）===');
for (const n of [2, 4, 8, 16, 32, 64, 128]) {
  const px = solidPng(n, n, 255, 0, 0);
  await attempt(`${n}x${n} (${px.length} 字符)`, px);
}

console.log('\n=== media_type 声明与实际不符时 ===');
const png32 = solidPng(32, 32, 255, 0, 0);
await attempt('png 声明成 jpeg', png32, 'image/jpeg');

console.log('\n=== data URL 前缀（有些客户端会带）===');
await attempt('带 data: 前缀', `data:image/png;base64,${png32}`);
