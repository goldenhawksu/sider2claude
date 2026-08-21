/**
 * 集成测试目标配置。
 *
 * 优先级与 src/utils/env.ts 一致：运行时环境变量 > 仓库根 `.env` > 默认值。
 * 这里刻意不复用 env.ts，因为集成测试要能独立指向任意已部署实例。
 */

const dotenv = loadDotenv();

function read(key: string, defaultValue = ''): string {
  const runtime = Deno.env.get(key);
  if (runtime !== undefined && runtime !== '') {
    return runtime;
  }
  const fromFile = dotenv.get(key);
  return fromFile !== undefined && fromFile !== '' ? fromFile : defaultValue;
}

function loadDotenv(): Map<string, string> {
  const values = new Map<string, string>();
  try {
    const text = Deno.readTextFileSync('.env');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const sep = line.indexOf('=');
      if (sep <= 0) continue;
      const key = line.slice(0, sep).trim();
      let value = line.slice(sep + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        const commentIndex = value.search(/\s+#/);
        if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
      }
      values.set(key, value);
    }
  } catch {
    // 没有 .env 时靠环境变量，安静降级。
  }
  return values;
}

export interface IntegrationConfig {
  baseUrl: string;
  authToken: string;
  /** 单个请求超时。工具轮 + thinking 可能较慢，默认放宽。 */
  timeoutMs: number;
  /** 有 Sider 配额时用于真实作答的模型，避免把限流误判成缺陷。 */
  liveModel: string;
  /** Claude Code 模拟套件使用的模型：一个 Sonnet、一个 Opus。 */
  claudeCodeSonnet: string;
  claudeCodeOpus: string;
  /** 报告输出目录。 */
  reportDir: string;
}

export function getConfig(): IntegrationConfig {
  const port = read('PORT', '8000');
  return {
    baseUrl: (read('E2E_BASE_URL') || read('TEST_API_BASE_URL') || `http://localhost:${port}`)
      .replace(/\/+$/, ''),
    authToken: read('E2E_AUTH_TOKEN') || read('TEST_AUTH_TOKEN') || read('AUTH_TOKEN'),
    timeoutMs: Number(read('E2E_TIMEOUT_MS', '120000')),
    liveModel: read('E2E_LIVE_MODEL', 'claude-haiku-4.5'),
    claudeCodeSonnet: read('E2E_CC_SONNET_MODEL', 'claude-sonnet-4.6'),
    claudeCodeOpus: read('E2E_CC_OPUS_MODEL', 'claude-opus-4.6'),
    reportDir: read('E2E_REPORT_DIR', 'deno/test/integration/reports'),
  };
}

export function maskToken(token: string): string {
  if (!token) return '(empty)';
  return token.length <= 10 ? '***' : `${token.slice(0, 6)}...${token.slice(-4)}`;
}
