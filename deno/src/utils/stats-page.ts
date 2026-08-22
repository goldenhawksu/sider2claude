/**
 * `/stats` 用量看板。
 *
 * 服务端把 UsageSnapshot 渲染成一张自包含的 HTML（内联 SVG + CSS，无外部依赖、
 * 无构建步骤），因此在 Deno Deploy 上零额外成本，离线也能打开。
 *
 * 可视化取舍：
 * - 模型分布用环形图（构成占比）+ 表格（精确值），二者并置；
 * - token 趋势用面积图（随时间的量级变化），单一 y 轴；
 * - 后端占比用一条堆叠条 + 直接标签，比再来一个饼图更省地方也更好读。
 *
 * 配色取自 dataviz 参考调色板的前三个分类槽位，浅色/深色各自选步，
 * 已用 validate_palette 在两种模式下验证（CVD ΔE 9.2/9.4，均通过）。
 * 浅色模式下 aqua 对比度低于 3:1，因此所有色块都配可见文字标签，
 * 不让颜色单独承载含义。
 */

import type { ModelStat, TrendBucket, UsageSnapshot } from './usage-stats.ts';

/** HTML 转义：模型名与工具名来自请求，必须当作不可信输入。 */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 1234567 -> 1.23M，与看板表格的紧凑风格一致。 */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * 看板时区：固定 UTC+8（北京/上海）。
 *
 * 不能用 `Date#getHours()` —— 那读的是运行时本地时区。服务跑在 Deno Deploy
 * 上（进程时区为 UTC），页面会比北京时间晚 8 小时；而开发机若本身在 UTC+8，
 * 本地又完全看不出问题。故统一按固定偏移换算，与运行时时区无关。
 */
const DISPLAY_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DISPLAY_TZ_LABEL = 'UTC+8';

function hhmm(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + DISPLAY_TZ_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${
    String(shifted.getUTCMinutes()).padStart(2, '0')
  }`;
}

/** 分类槽位 1-8，超出的模型折叠成「其他」而不是循环取色。 */
const SERIES_COUNT = 8;

/** 环形图：按模型请求数构成。返回 SVG 弧段。 */
function donut(models: ModelStat[], total: number): string {
  if (total === 0) {
    return `<circle cx="90" cy="90" r="62" fill="none" stroke="var(--grid)" stroke-width="26"/>
      <text x="90" y="90" class="donut-empty" text-anchor="middle" dominant-baseline="middle">暂无数据</text>`;
  }

  const R = 62;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = models.map((m, i) => {
    const frac = m.requests / total;
    const len = frac * C;
    // 2px 表面间隙：相邻扇区之间留缝，避免两色直接相接
    const gap = models.length > 1 ? 2 : 0;
    const dash = `${Math.max(len - gap, 0.5)} ${C - Math.max(len - gap, 0.5)}`;
    const arc = `<circle cx="90" cy="90" r="${R}" fill="none"
      stroke="var(--s${i + 1})" stroke-width="26"
      stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 90 90)">
      <title>${esc(m.model)}：${m.requests} 次请求（${Math.round(frac * 100)}%）</title>
    </circle>`;
    offset += len;
    return arc;
  }).join('');

  return `${arcs}
    <text x="90" y="82" class="donut-num" text-anchor="middle">${total}</text>
    <text x="90" y="102" class="donut-cap" text-anchor="middle">总请求</text>`;
}

/** 面积图：token 使用趋势。单一 y 轴，input/output 两条序列。 */
function trendChart(trend: TrendBucket[]): string {
  const W = 720;
  const H = 200;
  const PAD_L = 48;
  const PAD_B = 26;
  const PAD_T = 12;
  const plotW = W - PAD_L - 12;
  const plotH = H - PAD_B - PAD_T;

  const peak = Math.max(1, ...trend.map((b) => Math.max(b.inputTokens, b.outputTokens)));
  const stepX = trend.length > 1 ? plotW / (trend.length - 1) : plotW;
  const x = (i: number) => PAD_L + i * stepX;
  const y = (v: number) => PAD_T + plotH - (v / peak) * plotH;

  const line = (pick: (b: TrendBucket) => number) =>
    trend.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pick(b)).toFixed(1)}`).join(
      ' ',
    );
  const area = (pick: (b: TrendBucket) => number) =>
    `${line(pick)} L${x(trend.length - 1).toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${
      x(0).toFixed(1)
    },${(PAD_T + plotH).toFixed(1)} Z`;

  // 4 条横向参考线，recessive 处理
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = PAD_T + plotH - f * plotH;
    return `<line x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - 12}" y2="${
      gy.toFixed(1)
    }" class="grid"/>
      <text x="${PAD_L - 8}" y="${(gy + 4).toFixed(1)}" class="tick" text-anchor="end">${
      compact(Math.round(peak * f))
    }</text>`;
  }).join('');

  // x 轴每 6 桶标一次，避免标签相撞
  const xLabels = trend.map((b, i) =>
    i % 6 === 0 || i === trend.length - 1
      ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="tick" text-anchor="middle">${
        hhmm(b.at)
      }</text>`
      : ''
  ).join('');

  // 悬停热区：整列可点，命中目标远大于数据点本身
  const hotspots = trend.map((b, i) =>
    `<rect x="${(x(i) - stepX / 2).toFixed(1)}" y="${PAD_T}" width="${stepX.toFixed(1)}"
      height="${plotH}" fill="transparent">
      <title>${hhmm(b.at)}　请求 ${b.requests}　输入 ${compact(b.inputTokens)}　输出 ${
      compact(b.outputTokens)
    }</title>
    </rect>`
  ).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img"
      aria-label="近 24 小时 token 使用趋势">
    ${grid}
    <path d="${area((b) => b.inputTokens)}" fill="var(--s1)" opacity="0.14"/>
    <path d="${line((b) => b.inputTokens)}" fill="none" stroke="var(--s1)" stroke-width="2"
      stroke-linejoin="round"/>
    <path d="${area((b) => b.outputTokens)}" fill="var(--s2)" opacity="0.14"/>
    <path d="${line((b) => b.outputTokens)}" fill="none" stroke="var(--s2)" stroke-width="2"
      stroke-linejoin="round"/>
    ${xLabels}
    ${hotspots}
  </svg>`;
}

/** 后端占比：一条堆叠条 + 直接标签。 */
function backendBar(snapshot: UsageSnapshot): string {
  const { sider, deepseek } = snapshot.totals;
  const total = sider + deepseek;
  if (total === 0) {
    return `<div class="bar empty">暂无数据</div>`;
  }
  const sPct = (sider / total) * 100;
  return `<div class="bar" role="img"
      aria-label="Sider ${snapshot.backendShare.sider}，DeepSeek ${snapshot.backendShare.deepseek}">
    ${sPct > 0 ? `<span style="width:${sPct}%;background:var(--s1)"></span>` : ''}
    ${sPct < 100 ? `<span style="width:${100 - sPct}%;background:var(--s2)"></span>` : ''}
  </div>
  <div class="bar-legend">
    <span><i style="background:var(--s1)"></i>Sider <b>${sider}</b> ${snapshot.backendShare.sider}</span>
    <span><i style="background:var(--s2)"></i>DeepSeek <b>${deepseek}</b> ${snapshot.backendShare.deepseek}</span>
  </div>`;
}

export function renderStatsPage(snapshot: UsageSnapshot): string {
  const { totals } = snapshot;
  // 超过槽位数的模型折叠为「其他」，绝不循环取色
  const shown = snapshot.models.slice(0, SERIES_COUNT);
  const rest = snapshot.models.slice(SERIES_COUNT);
  if (rest.length > 0) {
    shown.push({
      model: `其他 ${rest.length} 个模型`,
      requests: rest.reduce((s, m) => s + m.requests, 0),
      inputTokens: rest.reduce((s, m) => s + m.inputTokens, 0),
      outputTokens: rest.reduce((s, m) => s + m.outputTokens, 0),
      totalTokens: rest.reduce((s, m) => s + m.totalTokens, 0),
      sider: rest.reduce((s, m) => s + m.sider, 0),
      deepseek: rest.reduce((s, m) => s + m.deepseek, 0),
    });
  }

  const modelRows = shown.length === 0
    ? `<tr><td colspan="5" class="empty-row">暂无数据</td></tr>`
    : shown.map((m, i) =>
      `<tr>
        <td><i class="dot" style="background:var(--s${i + 1})"></i>${esc(m.model)}</td>
        <td class="num">${m.requests}</td>
        <td class="num">${compact(m.totalTokens)}</td>
        <td class="num muted">${compact(m.inputTokens)}</td>
        <td class="num muted">${compact(m.outputTokens)}</td>
      </tr>`
    ).join('');

  const recentRows = snapshot.recent.length === 0
    ? `<tr><td colspan="6" class="empty-row">暂无数据</td></tr>`
    : snapshot.recent.map((r) =>
      `<tr>
        <td class="num muted">${hhmm(r.time)}</td>
        <td><span class="tag ${r.backend}">${r.backend}</span></td>
        <td>${esc(r.model)}</td>
        <td>${r.fallback ? '<span class="tag warn">fallback</span>' : ''}${
        r.stream ? '<span class="tag ghost">stream</span>' : ''
      }</td>
        <td>${r.tools.length ? esc(r.tools.join(', ')) : '<span class="muted">—</span>'}</td>
        <td class="num muted">${r.ms}ms</td>
      </tr>`
    ).join('');

  const toolRows = snapshot.tools.length === 0
    ? `<p class="muted small">暂无工具调用</p>`
    : `<ul class="tools">${
      snapshot.tools.map((t) => {
        // tools 已按次数降序，首项即最大值；空数组在上面的分支已排除
        const max = snapshot.tools[0]?.count || 1;
        return `<li><span class="tname">${esc(t.name)}</span>
          <span class="tbar"><i style="width:${(t.count / max) * 100}%"></i></span>
          <span class="tnum">${t.count}</span></li>`;
      }).join('')
    }</ul>`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sider2Claude 用量统计</title>
<style>
:root {
  color-scheme: light dark;
  --plane: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --border: rgba(11,11,11,0.10);
  --s1: #2a78d6;
  --s2: #eb6834;
  --s3: #1baf7a;
  --s4: #eda100;
  --s5: #e87ba4;
  --s6: #008300;
  --s7: #4a3aa7;
  --s8: #e34948;
  --warn: #fab219;
}
@media (prefers-color-scheme: dark) {
  :root {
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --border: rgba(255,255,255,0.10);
    --s1: #3987e5;
    --s2: #d95926;
    --s3: #199e70;
    --s4: #c98500;
    --s5: #d55181;
    --s6: #008300;
    --s7: #9085e9;
    --s8: #e66767;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px;
  background: var(--plane); color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0; font-weight: 600; }
.sub { color: var(--muted); font-size: 12px; }
.grid-3 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.row { display: grid; grid-template-columns: 1fr 1.35fr; gap: 16px; margin-bottom: 16px; }
@media (max-width: 900px) { .row, .grid-3 { grid-template-columns: 1fr; } }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px;
}
.card h2 { font-size: 13px; margin: 0 0 14px; font-weight: 600; color: var(--ink-2); }
.tile .v { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; }
.tile .k { color: var(--muted); font-size: 12px; margin-top: 2px; }
.donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.donut-num { font-size: 24px; font-weight: 650; fill: var(--ink); }
.donut-cap { font-size: 11px; fill: var(--muted); }
.donut-empty { font-size: 12px; fill: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-weight: 500; color: var(--muted); font-size: 12px;
  padding: 6px 8px; border-bottom: 1px solid var(--grid);
}
td { padding: 7px 8px; border-bottom: 1px solid var(--grid); }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.empty-row { text-align: center; color: var(--muted); padding: 20px 0; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 7px; vertical-align: baseline; }
.trend { width: 100%; height: auto; }
.grid { stroke: var(--grid); stroke-width: 1; }
.tick { font-size: 10px; fill: var(--muted); }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-bottom: 6px; }
.legend i, .bar-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
.bar { display: flex; height: 26px; border-radius: 5px; overflow: hidden; background: var(--grid); gap: 2px; }
.bar.empty { align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
.bar span { display: block; }
.bar-legend { display: flex; gap: 18px; margin-top: 10px; font-size: 12px; color: var(--ink-2); }
.bar-legend b { font-variant-numeric: tabular-nums; }
.tag {
  display: inline-block; padding: 1px 7px; border-radius: 4px;
  font-size: 11px; margin-right: 4px; border: 1px solid var(--border);
}
.tag.sider { color: var(--s1); }
.tag.deepseek { color: var(--s2); }
.tag.warn { color: var(--warn); }
.tag.ghost { color: var(--muted); }
.tools { list-style: none; margin: 0; padding: 0; }
.tools li { display: grid; grid-template-columns: 1fr 120px 34px; align-items: center; gap: 10px; padding: 4px 0; }
.tname { font-size: 13px; }
.tbar { height: 7px; background: var(--grid); border-radius: 4px; overflow: hidden; }
.tbar i { display: block; height: 100%; background: var(--s3); border-radius: 4px; }
.tnum { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); font-size: 12px; }
footer { color: var(--muted); font-size: 12px; margin-top: 18px; line-height: 1.7; }
a { color: var(--s1); }
</style>
</head>
<body>
<header>
  <h1>Sider2Claude 用量统计</h1>
  <span class="sub">自 ${
    esc(hhmm(snapshot.since))
  } 起 · 近 24 小时趋势 · 时间为 ${DISPLAY_TZ_LABEL} · <a href="/">服务信息</a></span>
</header>

<div class="grid-3">
  <div class="card tile"><div class="v">${totals.requests}</div><div class="k">上游请求</div></div>
  <div class="card tile"><div class="v">${
    compact(totals.inputTokens + totals.outputTokens)
  }</div><div class="k">Token 总量</div></div>
  <div class="card tile"><div class="v">${totals.fallbacks}</div><div class="k">Fallback 次数</div></div>
  <div class="card tile"><div class="v">${totals.toolCalls}</div><div class="k">工具调用</div></div>
</div>

<div class="row">
  <div class="card">
    <h2>模型分布</h2>
    <div class="donut-wrap">
      <svg viewBox="0 0 180 180" width="150" height="150" role="img"
        aria-label="按模型的请求数构成">${donut(shown, totals.requests)}</svg>
      <table>
        <thead><tr><th>模型</th><th class="num">请求</th><th class="num">Token</th>
          <th class="num">输入</th><th class="num">输出</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h2>Token 使用趋势（近 24 小时）</h2>
    <div class="legend">
      <span><i style="background:var(--s1)"></i>输入 Token</span>
      <span><i style="background:var(--s2)"></i>输出 Token</span>
    </div>
    ${trendChart(snapshot.trend)}
  </div>
</div>

<div class="row">
  <div class="card">
    <h2>后端占比</h2>
    ${backendBar(snapshot)}
    <p class="muted small" style="margin:12px 0 0">
      最近 1 小时：${snapshot.lastHour.requests} 次请求
      （Sider ${snapshot.lastHour.sider} · DeepSeek ${snapshot.lastHour.deepseek}
      · fallback ${snapshot.lastHour.fallbacks}）
    </p>
  </div>
  <div class="card">
    <h2>工具调用频次</h2>
    ${toolRows}
  </div>
</div>

<div class="card">
  <h2>最近请求</h2>
  <table>
    <thead><tr><th>时间</th><th>后端</th><th>模型</th><th>标记</th><th>工具</th>
      <th class="num">耗时</th></tr></thead>
    <tbody>${recentRows}</tbody>
  </table>
</div>

<footer>
  ${esc(snapshot.note)}<br>
  ${
    snapshot.persisted
      ? '聚合数据已持久化（Deno KV）。'
      : '⚠️ 聚合数据未持久化：仅统计当前实例，且实例回收后清零。'
  }
  缓存回放 ${totals.cachedReplays} 次（命中重复响应缓存、未触达上游，故不计入上方请求数）。
  流式请求 ${totals.streaming} 次；Sider 流式不回传 token 用量，Token 总量以非流式请求为准。
</footer>
</body>
</html>`;
}
