/**
 * Sider 账号池。
 *
 * 实测同一账号同一模型只能有一路在途请求（第二路必定 1101），不同模型可以并行；
 * 因此提升并发只能靠增加账号。账号由 SIDER_AUTH_TOKEN 与 SIDER_AUTH_TOKEN_1..8
 * 提供，按出现顺序去重，最多 8 个（超出部分忽略）。
 *
 * id 是账号身份（JWT 的 user_id，解析不出时退回 token）的 SHA-256，用于租约、
 * 冷却、节奏键和任务归属；任何地方都不落明文。同一账号的多个 token 归并为一个。
 */
import { getEnv } from './env.js';

export const MAX_SIDER_ACCOUNTS = 8;

export interface SiderAccount {
  /** SHA-256(token)。与历史 `controllerHash(token)` 完全一致，旧键继续有效。 */
  id: string;
  token: string;
  /** 主账号。升级前创建的主控检查点只能属于它。 */
  primary: boolean;
}

export async function getSiderAccounts(): Promise<SiderAccount[]> {
  const tokens: string[] = [];
  const primary = getEnv('SIDER_AUTH_TOKEN').trim();
  if (primary) tokens.push(primary);
  for (let index = 1; index <= MAX_SIDER_ACCOUNTS; index++) {
    const token = getEnv(`SIDER_AUTH_TOKEN_${index}`).trim();
    if (token) tokens.push(token);
  }

  const seen = new Set<string>();
  const accounts: SiderAccount[] = [];
  for (const token of tokens) {
    // 同一个 Sider 账号可能有多个 token（重新登录即换 token），但并发与额度按
    // 账号计：实测两枚同 user_id 的 token 并发仍返回 1101。按账号身份归并，
    // 既避免把同一账号当成两路并发，也让 token 轮换不影响任务绑定。
    const identity = tokenAccountIdentity(token);
    if (seen.has(identity)) continue;
    seen.add(identity);
    accounts.push({ id: await accountId(identity), token, primary: token === primary });
    if (accounts.length >= MAX_SIDER_ACCOUNTS) break;
  }
  return accounts;
}

/** 账号键：同一 Sider 账号的不同 token 结果相同。 */
export async function siderAccountId(token: string): Promise<string> {
  return await accountId(tokenAccountIdentity(token));
}

function tokenAccountIdentity(token: string): string {
  const parts = token.split('.');
  const payload = parts.length >= 2 ? parts[1] : undefined;
  if (payload) {
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const claims = JSON.parse(atob(padded)) as { user_id?: unknown };
      if (typeof claims.user_id === 'string' || typeof claims.user_id === 'number') {
        return `user:${claims.user_id}`;
      }
    } catch {
      // 非 JWT 或载荷不可解析时退回 token 本身。
    }
  }
  return `token:${token}`;
}

async function accountId(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`sider-account:${identity}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
