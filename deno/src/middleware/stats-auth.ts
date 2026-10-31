/**
 * 用量看板鉴权。
 *
 * 看板含最近请求明细、模型与工具使用、Sider 健康度，默认不对外公开：
 * - API 客户端用 `x-api-key` / `Authorization: Bearer` 携带 STATS_TOKEN、AUTH_TOKEN 或 ADMIN_TOKEN；
 * - 浏览器先在登录页提交凭证，换取 HttpOnly 会话 cookie（内容是凭证的派生摘要，不是原文）；
 * - `STATS_PUBLIC=true` 显式恢复旧的公开行为。
 */

import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { getEnv } from '../utils/env.ts';
import { extractAuthToken, getStatsTokens, timingSafeEqual } from './auth.ts';

export const STATS_COOKIE = 's2c_stats';
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

export function isStatsPublic(): boolean {
  return getEnv('STATS_PUBLIC') === 'true';
}

async function sessionDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`s2c-stats-session:${token}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function matchesStatsToken(token: string): boolean {
  return getStatsTokens().some((valid) => timingSafeEqual(token, valid));
}

async function hasValidSession(c: Context): Promise<boolean> {
  const cookie = getCookie(c, STATS_COOKIE);
  if (!cookie) return false;
  for (const token of getStatsTokens()) {
    if (timingSafeEqual(cookie, await sessionDigest(token))) return true;
  }
  return false;
}

function hasAuthHeader(c: Context): boolean {
  return !!(c.req.header('authorization') || c.req.header('x-api-key'));
}

function wantsHtml(c: Context): boolean {
  return !c.req.path.endsWith('.json') && (c.req.header('accept') ?? '').includes('text/html');
}

export async function requireStatsAuth(c: Context, next: Next) {
  if (isStatsPublic()) return await next();

  if (!getStatsTokens().length) {
    return c.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Stats authentication is not configured (set STATS_TOKEN/AUTH_TOKEN or STATS_PUBLIC=true)',
      },
    }, 503);
  }

  if (hasAuthHeader(c)) {
    try {
      const { token } = extractAuthToken(c);
      if (matchesStatsToken(token)) return await next();
    } catch {
      // 格式错误按未授权处理
    }
  } else if (await hasValidSession(c)) {
    return await next();
  }

  if (wantsHtml(c)) return c.html(renderStatsLoginPage(), 401);
  return c.json({
    type: 'error',
    error: { type: 'authentication_error', message: 'Stats access requires authentication' },
  }, 401);
}

/** 浏览器登录：校验凭证后写入 HttpOnly 会话 cookie。 */
export async function statsLogin(c: Context) {
  const body = await c.req.json().catch(() => ({})) as { token?: unknown };
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || !matchesStatsToken(token)) {
    return c.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid token' } }, 401);
  }
  const secure = new URL(c.req.url).protocol === 'https:' ||
    c.req.header('x-forwarded-proto') === 'https';
  setCookie(c, STATS_COOKIE, await sessionDigest(token), {
    httpOnly: true,
    sameSite: 'Strict',
    secure,
    path: '/stats',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return c.json({ status: 'ok' });
}

export function statsLogout(c: Context) {
  setCookie(c, STATS_COOKIE, '', { httpOnly: true, sameSite: 'Strict', path: '/stats', maxAge: 0 });
  return c.json({ status: 'ok' });
}

export function renderStatsLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sider2Claude 用量看板 · 登录</title>
<style>
:root { color-scheme: light dark; --bg:#f7f7f5; --fg:#1f1f1d; --muted:#6b6b66; --card:#fff; --line:#dcdcd6; --accent:#2f5bd3; }
@media (prefers-color-scheme: dark) { :root { --bg:#1a1a18; --fg:#ececea; --muted:#a3a39d; --card:#242422; --line:#3a3a37; --accent:#7c9cf0; } }
body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
form { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:24px; width:min(360px, calc(100vw - 32px)); box-sizing:border-box; }
h1 { font-size:18px; margin:0 0 4px; }
p { color:var(--muted); margin:0 0 16px; font-size:13px; }
input { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; }
button { margin-top:12px; width:100%; padding:9px; border:0; border-radius:6px; background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
#msg { min-height:20px; margin-top:8px; font-size:13px; color:#c0392b; }
</style>
</head>
<body>
<form id="login">
  <h1>用量看板</h1>
  <p>输入看板凭证（STATS_TOKEN、AUTH_TOKEN 或 ADMIN_TOKEN）。</p>
  <input id="token" type="password" autocomplete="current-password" aria-label="看板凭证" required>
  <button type="submit">进入</button>
  <div id="msg" role="status"></div>
</form>
<script>
document.getElementById('login').addEventListener('submit', function (event) {
  event.preventDefault();
  var msg = document.getElementById('msg');
  fetch('/stats/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: document.getElementById('token').value }),
  }).then(function (r) {
    if (r.ok) { location.reload(); return; }
    msg.textContent = '凭证无效';
  }).catch(function () { msg.textContent = '登录失败'; });
});
</script>
</body>
</html>`;
}
