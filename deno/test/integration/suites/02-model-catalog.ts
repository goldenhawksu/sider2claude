// deno-lint-ignore-file no-explicit-any -- 集成测试要读取形状不固定的上游 JSON，any 是恰当选择。
/**
 * 模型清单：Anthropic 与 Gemini 两套发现接口必须暴露同一份清单，
 * 且与 `deno/src/config/models.ts` 保持一致（双运行时同源）。
 */

import { getAllModels } from '../../../src/config/models.ts';
import { assertEquals, assertStatus, assertTrue, type Suite } from '../harness.ts';

const EXPECTED = getAllModels();
const EXPECTED_IDS = EXPECTED.map((m) => m.id);

export const suite: Suite = {
  id: '02',
  title: '模型清单',
  cases: [
    {
      name: 'GET /v1/models 与代码内清单一致',
      async run({ api }) {
        const res = await api.get('/v1/models');
        assertStatus(res, 200);
        assertEquals(res.json?.object, 'list', 'object');
        const ids: string[] = (res.json?.data ?? []).map((m: any) => m.id);
        assertEquals(ids.length, EXPECTED_IDS.length, '模型数量');
        const missing = EXPECTED_IDS.filter((id) => !ids.includes(id));
        assertTrue(missing.length === 0, `无缺失模型（缺 ${missing.join(',')}）`);

        const fam = (p: string) => ids.filter((i) => i.startsWith(p)).length;
        return `共 ${ids.length} 个：claude=${fam('claude')} gpt=${fam('gpt')} ` +
          `gemini=${fam('gemini')} deepseek=${fam('deepseek')}`;
      },
    },
    {
      name: '每个模型条目结构完整',
      async run({ api }) {
        const res = await api.get('/v1/models');
        assertStatus(res, 200);
        for (const m of res.json.data) {
          assertTrue(typeof m.id === 'string' && !!m.id, 'id 非空');
          assertEquals(m.object, 'model', `${m.id}.object`);
          assertTrue(typeof m.created === 'number', `${m.id}.created 是数字`);
          assertTrue(!!m.siderModel, `${m.id}.siderModel 非空`);
        }
        return `${res.json.data.length} 个条目结构均合法`;
      },
    },
    {
      name: 'GET /v1/models/:id 明细',
      async run({ api }) {
        const res = await api.get('/v1/models/claude-opus-4.8');
        assertStatus(res, 200);
        assertEquals(res.json?.id, 'claude-opus-4.8', 'id');
        return `siderModel=${res.json.siderModel}`;
      },
    },
    {
      name: 'GET /v1/models/:id 未知模型返回 404',
      async run({ api }) {
        const res = await api.get('/v1/models/no-such-model-xyz');
        assertStatus(res, 404);
        return 'HTTP 404';
      },
    },
    {
      name: 'GET /v1beta/models（Gemini 发现）数量一致',
      async run({ api }) {
        const res = await api.get('/v1beta/models');
        assertStatus(res, 200);
        const models = res.json?.models ?? [];
        assertEquals(models.length, EXPECTED_IDS.length, 'Gemini 清单数量');
        return `共 ${models.length} 个，与 /v1/models 一致`;
      },
    },
    {
      name: 'GET /v1beta/models/:model 明细',
      async run({ api }) {
        const res = await api.get('/v1beta/models/gemini-3.7-flash');
        assertStatus(res, 200);
        assertTrue(!!(res.json?.name ?? res.json?.id), 'name/id 非空');
        return `name=${res.json.name ?? res.json.id}`;
      },
    },
  ],
};
