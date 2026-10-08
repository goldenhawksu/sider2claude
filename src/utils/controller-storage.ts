import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { getEnv } from './env.js';
import { ControllerMemoryStore, type ControllerStore } from './controller-memory-store.js';

/** Bun使用SQLite保存同样的任务和租约，跨进程状态不依赖内存。 */
export class ControllerSqliteStore implements ControllerStore {
  constructor(private db: Database) {
    db.run('CREATE TABLE IF NOT EXISTS controller (key TEXT PRIMARY KEY, value TEXT, expires INTEGER)');
    db.run('PRAGMA busy_timeout=5000');
  }
  async read<T>(key: string): Promise<T | null> {
    const row = this.db.query('SELECT value, expires FROM controller WHERE key=?').get(key) as {value:string;expires:number} | null;
    return row && row.expires > Date.now() ? JSON.parse(row.value) as T : null;
  }
  async write(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.db.run('DELETE FROM controller WHERE expires<=?', [Date.now()]);
    this.db.run('INSERT OR REPLACE INTO controller VALUES (?,?,?)', [key, JSON.stringify(value), Date.now()+ttlMs]);
  }
  async claim(key: string, holder: string, leaseMs: number): Promise<boolean> {
    return this.db.transaction(() => {
      this.db.run('DELETE FROM controller WHERE key=? AND expires<=?', [key, Date.now()]);
      return this.db.run('INSERT OR IGNORE INTO controller VALUES (?,?,?)', [key, JSON.stringify(holder), Date.now()+leaseMs]).changes === 1;
    })();
  }
  async release(key: string, holder: string): Promise<void> {
    this.db.run('DELETE FROM controller WHERE key=? AND value=?', [key, JSON.stringify(holder)]);
  }
}
let store: ControllerStore | undefined;
export function getControllerStore(): Promise<ControllerStore> {
  if (!store) {
    if (getEnv('SIDER_CONTROLLER_STORAGE') === 'memory') store = new ControllerMemoryStore();
    else {
      mkdirSync('.runtime', { recursive: true });
      store = new ControllerSqliteStore(new Database('.runtime/controller.sqlite', {create:true}));
    }
  }
  return Promise.resolve(store);
}
