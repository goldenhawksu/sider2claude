/**
 * Deno Deploy 上 KV 路径的解析：本地文件路径必须被忽略，改用平台默认数据库。
 * 生产曾因 SIDER_CONTROLLER_KV_PATH=.runtime/controller.sqlite 导致所有主控请求 502。
 */
import { resolveKvPath } from '../src/utils/kv-path.ts';

function equal(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Error(`${what}：期望 ${expected}，实际 ${actual}`);
}

async function withDeployment(id: string | undefined, fn: () => void | Promise<void>) {
  const previous = Deno.env.get('DENO_DEPLOYMENT_ID');
  if (id === undefined) Deno.env.delete('DENO_DEPLOYMENT_ID');
  else Deno.env.set('DENO_DEPLOYMENT_ID', id);
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete('DENO_DEPLOYMENT_ID');
    else Deno.env.set('DENO_DEPLOYMENT_ID', previous);
  }
}

Deno.test('KV 路径：本地运行使用配置或默认文件', async () => {
  await withDeployment(undefined, () => {
    equal(resolveKvPath('', '.runtime/a.sqlite', 'X'), '.runtime/a.sqlite', '默认文件');
    equal(resolveKvPath('/tmp/b.sqlite', '.runtime/a.sqlite', 'X'), '/tmp/b.sqlite', '配置路径');
  });
});

Deno.test('KV 路径：Deno Deploy 上忽略本地文件路径，改用平台默认数据库', async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    await withDeployment('abcdef123456', () => {
      equal(resolveKvPath('', '.runtime/a.sqlite', 'X'), undefined, '未配置');
      equal(
        resolveKvPath('.runtime/controller.sqlite', '.runtime/a.sqlite', 'SIDER_CONTROLLER_KV_PATH'),
        undefined,
        '本地相对路径被忽略',
      );
      equal(resolveKvPath('/data/x.sqlite', '.runtime/a.sqlite', 'Y'), undefined, '绝对文件路径被忽略');
      equal(
        resolveKvPath('https://api.deno.com/databases/x/connect', '.runtime/a.sqlite', 'Z'),
        'https://api.deno.com/databases/x/connect',
        '远程 KV 地址保留',
      );
    });
  } finally {
    console.warn = originalWarn;
  }
  equal(warnings.length >= 1, true, '记录告警');
  equal(warnings.some((w) => w.includes('.runtime')), false, '告警不回显配置值');
});
