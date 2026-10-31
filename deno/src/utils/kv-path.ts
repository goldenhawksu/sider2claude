/**
 * Deno KV 路径解析。
 *
 * 本地运行时，KV 落在 `.runtime/*.sqlite` 文件里；Deno Deploy 上必须用
 * `Deno.openKv()`（不传路径）连接平台关联的数据库。若部署环境照抄了本地
 * 示例配置（如 `SIDER_CONTROLLER_KV_PATH=.runtime/controller.sqlite`），
 * 平台会把它当成数据库名去查元数据并返回 404，所有依赖 KV 的请求随之 502。
 * 因此在 Deploy 上忽略本地文件路径，只接受 http(s) 远程 KV 地址。
 */
import { getEnv } from './env.ts';

const warned = new Set<string>();

export function isDenoDeploy(): boolean {
  return !!getEnv('DENO_DEPLOYMENT_ID');
}

/**
 * @param configured 环境变量里配置的路径（可能为空）
 * @param localDefault 本地开发时的默认文件路径
 * @param source 用于告警日志的变量名
 * @returns 传给 `Deno.openKv` 的参数；undefined 表示平台默认数据库
 */
export function resolveKvPath(
  configured: string,
  localDefault: string,
  source: string,
): string | undefined {
  if (!isDenoDeploy()) return configured || localDefault;
  if (!configured) return undefined;
  if (/^https?:\/\//i.test(configured)) return configured;
  if (!warned.has(source)) {
    warned.add(source);
    console.warn(
      `⚠️ ${source} 在 Deno Deploy 上不是可用的数据库地址，已忽略并改用平台关联的默认 Deno KV`,
    );
  }
  return undefined;
}
