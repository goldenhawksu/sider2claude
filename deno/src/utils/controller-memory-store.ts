export interface ControllerStore {
  read<T>(key: string): Promise<T | null>;
  write(key: string, value: unknown, ttlMs: number): Promise<void>;
  claim(key: string, holder: string, leaseMs: number): Promise<boolean>;
  release(key: string, holder: string): Promise<void>;
}

/** 仅用于显式memory模式；达到容量后拒绝，不能淘汰尚未完成的任务。 */
export class ControllerMemoryStore implements ControllerStore {
  private records = new Map<string, { value: unknown; expiresAt: number }>();
  async read<T>(key: string): Promise<T | null> {
    const record = this.records.get(key);
    if (!record || record.expiresAt <= Date.now()) {
      this.records.delete(key);
      return null;
    }
    return structuredClone(record.value) as T;
  }
  async write(key: string, value: unknown, ttlMs: number): Promise<void> {
    for (const [k, r] of this.records) if (r.expiresAt <= Date.now()) this.records.delete(k);
    if (!this.records.has(key) && this.records.size >= 2048) throw new Error('主控状态容量已满');
    this.records.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttlMs });
  }
  async claim(key: string, holder: string, leaseMs: number): Promise<boolean> {
    const record = this.records.get(key);
    if (record && record.expiresAt > Date.now()) return false;
    this.records.set(key, { value: holder, expiresAt: Date.now() + leaseMs });
    return true;
  }
  async release(key: string, holder: string): Promise<void> {
    if (this.records.get(key)?.value === holder) this.records.delete(key);
  }
}
