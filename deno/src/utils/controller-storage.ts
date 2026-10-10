/// <reference lib="deno.unstable" />
import { getEnv } from './env.ts';
import { ControllerMemoryStore, type ControllerStore } from './controller-memory-store.ts';

/** 任务数据必须等待落库；KV失败直接报错，禁止静默丢失主控状态。 */
export class ControllerKvStore implements ControllerStore {
  constructor(private kv: Deno.Kv) {}
  private key(key: string) {
    return ['controller', key];
  }
  async read<T>(key: string): Promise<T | null> {
    const entry = await this.kv.get<{ value: T; expiresAt: number }>(this.key(key));
    return entry.value && entry.value.expiresAt > Date.now() ? entry.value.value : null;
  }
  async write(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.kv.set(this.key(key), { value, expiresAt: Date.now() + ttlMs }, {
      expireIn: Math.max(1, ttlMs),
    });
  }
  async claim(key: string, holder: string, leaseMs: number): Promise<boolean> {
    const entry = await this.kv.get<{ value: string; expiresAt: number }>(this.key(key));
    if (entry.value && entry.value.expiresAt > Date.now()) return false;
    const result = await this.kv.atomic().check(entry)
      .set(this.key(key), { value: holder, expiresAt: Date.now() + leaseMs }, { expireIn: leaseMs })
      .commit();
    return result.ok;
  }
  async release(key: string, holder: string): Promise<void> {
    const entry = await this.kv.get<{ value: string }>(this.key(key));
    if (entry.value?.value === holder) {
      await this.kv.atomic().check(entry).delete(this.key(key)).commit();
    }
  }
}
let pending: Promise<ControllerStore> | undefined;
export function getControllerStore(): Promise<ControllerStore> {
  pending ??= getEnv('SIDER_CONTROLLER_STORAGE') === 'memory'
    ? Promise.resolve(new ControllerMemoryStore())
    : openControllerKv().then((kv) => new ControllerKvStore(kv));
  return pending;
}

async function openControllerKv(): Promise<Deno.Kv> {
  const configured = getEnv('SIDER_CONTROLLER_KV_PATH');
  const path = configured ||
    (getEnv('DENO_DEPLOYMENT_ID') ? undefined : '.runtime/controller.sqlite');
  if (path?.startsWith('.runtime/')) {
    await Deno.mkdir('.runtime', { recursive: true });
  }
  return await Deno.openKv(path);
}
