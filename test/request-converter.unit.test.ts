import { expect, test } from 'bun:test';
import { convertAnthropicToSiderAsync } from '../src/utils/request-converter';
import { getModelById, mapModelName } from '../src/config/models';
import { saveSiderSession } from '../src/utils/sider-session-manager';
import type { AnthropicRequest } from '../src/types/anthropic';

test('Sider 单消息续轮使用已保存的助手消息作为父消息', async () => {
  const cid = `session-${crypto.randomUUID()}`;
  const request: AnthropicRequest = {
    model: 'claude-sonnet-4.6',
    messages: [{ role: 'user', content: '刚才的数字是多少？' }],
    max_tokens: 64,
  };
  saveSiderSession(cid, 'user-1', 'assistant-1', request.model);

  const converted = await convertAnthropicToSiderAsync(request, 'sider-token', cid);

  expect(converted.cid).toBe(cid);
  expect(converted.parent_message_id).toBe('assistant-1');
  expect(converted.multi_content[0].text).toBe('刚才的数字是多少？');
});

test('Bun严格模型查找兼容Claude Code上下文窗口标签', () => {
  for (const decorated of ['claude-sonnet-5.5[1m]', 'CLAUDE-SONNET-5.5[200K]']) {
    expect(getModelById(decorated)?.siderModel).toBe('claude-sonnet-5.5');
    expect(mapModelName(decorated)).toBe('claude-sonnet-5.5');
  }
  expect(getModelById('claude-sonnet-5.5[beta]')).toBeUndefined();
});
