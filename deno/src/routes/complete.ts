/**
 * /v1/complete 路由
 * Anthropic Text Completion API (Legacy)
 *
 * 注意: 这是一个 legacy API，Anthropic 推荐使用 /v1/messages
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getAuthInfo, requireAuth } from '../middleware/auth.ts';
import type { CompleteError, CompleteRequest } from '../types/complete.ts';
import {
  convertCompleteToMessages,
  convertMessagesToComplete,
  validateCompleteRequest,
} from '../utils/complete-converter.ts';
import { siderClient } from '../utils/sider-client.ts';
import { convertAnthropicToSiderSync } from '../utils/request-converter.ts';
import type { AnthropicResponse } from '../types/anthropic.ts';
import { loadBackendConfig } from '../config/backends.ts';

const app = new Hono();
const config = loadBackendConfig();

// 应用认证中间件
app.use('*', requireAuth);

/**
 * POST /v1/complete
 * Text Completion API
 */
app.post('/', async (c: Context) => {
  try {
    // 1. 解析请求
    const completeRequest = await c.req.json() as CompleteRequest;

    console.log('📝 Complete API request:', {
      model: completeRequest.model,
      promptLength: completeRequest.prompt?.length,
      maxTokens: completeRequest.max_tokens_to_sample,
      stream: completeRequest.stream,
    });

    // 2. 验证请求
    const errors = validateCompleteRequest(completeRequest);
    if (errors.length > 0) {
      const errorResp: CompleteError = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `Invalid request: ${errors.map((e) => `${e.field} - ${e.message}`).join(', ')}`,
        },
      };
      return c.json(errorResp, 400);
    }

    // 3. 转换为 Messages API 格式
    const messagesRequest = convertCompleteToMessages(completeRequest);
    console.log('🔄 Converted to Messages format:', {
      messageCount: messagesRequest.messages.length,
      maxTokens: messagesRequest.max_tokens,
    });

    // 4. 转换为 Sider 格式
    const siderRequest = convertAnthropicToSiderSync(messagesRequest);

    // 5. 获取认证信息
    const auth = getAuthInfo(c);
    if (!auth) {
      const errorResp: CompleteError = {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Authentication required',
        },
      };
      return c.json(errorResp, 401);
    }

    // 6. 调用 Sider API
    const siderAuthToken = config.sider.authToken || auth.token;

    // siderClient.chat() 返回已解析的 SiderParsedResponse
    const siderParsedResponse = await siderClient.chat(siderRequest, siderAuthToken);

    // 7. 处理响应 - 构建 Messages API 格式的响应
    const messagesResponse: AnthropicResponse = {
      id: `msg_${Date.now()}`,
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{
        type: 'text' as const,
        text: siderParsedResponse.textParts.join(''),
      }],
      model: siderParsedResponse.model,
      stop_reason: 'end_turn' as const,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    };

    // 转换为 Complete 响应格式
    const completeResponse = convertMessagesToComplete(
      messagesResponse,
      completeRequest.model,
    );

    console.log('✅ Complete API response:', {
      id: completeResponse.id,
      completionLength: completeResponse.completion.length,
      stopReason: completeResponse.stop_reason,
    });

    return c.json(completeResponse);
  } catch (error) {
    console.error('❌ Complete API error:', error);

    const errorResp: CompleteError = {
      type: 'error',
      error: {
        type: 'api_error',
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    };

    return c.json(errorResp, 500);
  }
});

export default app;
