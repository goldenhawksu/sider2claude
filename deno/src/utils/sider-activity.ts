/// <reference lib="deno.unstable" />
import { normalizeModelId } from '../config/models.ts';
import { getKv } from './usage-stats-kv.ts';

/** 调用与业务响应分别计数；聚合不受明细遥测的采样上限影响。 */
const FIELDS = [
  'attempts',
  'succeeded',
  'failed',
  'quotaErrors',
  'contextUploads',
  'corrections',
  'cooldownRejections',
  'completed',
  'requestFailures',
  'checkpointResponses',
  'cachedReplays',
  'telemetryRecorded',
  'telemetryDropped',
] as const;
type Field = typeof FIELDS[number];
export type SiderActivityCounts = Record<Field, number>;
export interface SiderActivitySnapshot {
  since: string | null;
  persisted: boolean;
  totals: SiderActivityCounts;
  models: Array<SiderActivityCounts & { model: string }>;
}
const HOUR_MS = 3600_000;
const buckets = new Map<number, Map<string, SiderActivityCounts>>();
let since: number | undefined;
const empty = () => Object.fromEntries(FIELDS.map((key) => [key, 0])) as SiderActivityCounts;

function oldestBucket(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
}

export function recordSiderActivity(
  model: string,
  increments: Partial<SiderActivityCounts>,
  now = Date.now(),
): void {
  model = normalizeModelId(model);
  const values = FIELDS.flatMap((field) => {
    const value = increments[field];
    return Number.isSafeInteger(value) && value! > 0 ? [[field, value!] as const] : [];
  });
  if (!values.length) return;
  since = Math.min(since ?? now, now);
  const bucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  let models = buckets.get(bucket);
  if (!models) buckets.set(bucket, models = new Map());
  let row = models.get(model);
  if (!row) models.set(model, row = empty());
  for (const [field, value] of values) row[field] += value;
  for (const key of buckets.keys()) if (key < oldestBucket(now)) buckets.delete(key);

  // 各小时、模型、字段独立原子累加，不争抢共享快照，也不阻塞请求。
  void (async () => {
    const kv = await getKv();
    if (!kv) return;
    const op = kv.atomic().min(['sider-activity', 'since'], BigInt(now));
    for (const [field, value] of values) {
      op.sum(['sider-activity', bucket, model, field], BigInt(value));
    }
    await op.commit();
  })().catch(() => {});
}

function snapshot(
  rows: Map<string, SiderActivityCounts>,
  started: number | undefined,
  persisted: boolean,
): SiderActivitySnapshot {
  const totals = empty();
  const models = [...rows].map(([model, row]) => ({ model, ...row }));
  for (const row of models) for (const field of FIELDS) totals[field] += row[field];
  return {
    since: started === undefined ? null : new Date(started).toISOString(),
    persisted,
    totals,
    models: models.sort((a, b) => b.attempts - a.attempts),
  };
}

export function getLocalSiderActivity(now = Date.now()): SiderActivitySnapshot {
  const rows = new Map<string, SiderActivityCounts>();
  for (const [bucket, models] of buckets) {
    if (bucket < oldestBucket(now)) continue;
    for (const [model, values] of models) {
      let row = rows.get(model);
      if (!row) rows.set(model, row = empty());
      for (const field of FIELDS) row[field] += values[field];
    }
  }
  return snapshot(rows, since, false);
}

export async function getSiderActivitySnapshot(now = Date.now()): Promise<SiderActivitySnapshot> {
  const local = getLocalSiderActivity(now);
  const kv = await getKv();
  if (!kv) return local;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const started = await kv.get<Deno.KvU64>(['sider-activity', 'since']);
        const rows = new Map<string, SiderActivityCounts>();
        for await (
          const entry of kv.list<Deno.KvU64>({
            start: ['sider-activity', oldestBucket(now)],
            end: ['sider-activity', Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS],
          })
        ) {
          const [, , model, field] = entry.key;
          if (typeof model !== 'string' || !FIELDS.includes(field as Field)) continue;
          let row = rows.get(model);
          if (!row) rows.set(model, row = empty());
          row[field as Field] += Number(entry.value.value);
        }
        // 确定性回收过期小时桶，避免长期运行时无限增长。
        void (async () => {
          for await (
            const entry of kv.list({
              start: ['sider-activity', 0],
              end: ['sider-activity', oldestBucket(now)],
            })
          ) await kv.delete(entry.key);
        })().catch(() => {});
        return snapshot(rows, started.value ? Number(started.value.value) : undefined, true);
      })(),
      new Promise<SiderActivitySnapshot>((resolve) => {
        timer = setTimeout(() => resolve(local), 2000);
      }),
    ]);
  } catch {
    return local;
  } finally {
    clearTimeout(timer);
  }
}

/** 仅供测试；持久化聚合不随当前实例清空。 */
export function resetSiderActivity(): void {
  buckets.clear();
  since = undefined;
}
