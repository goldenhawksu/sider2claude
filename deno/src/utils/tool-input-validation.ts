import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnthropicRequest } from '../types/anthropic.ts';

// 不强制转换类型、不删除字段、不填充默认值，防止“校验”改写模型参数。
const ajv = new Ajv({ strict: false, validateFormats: false, addUsedSchema: false });
const ajv2020 = new Ajv2020({ strict: false, validateFormats: false, addUsedSchema: false });

export function validDeclaredToolInput(
  tools: AnthropicRequest['tools'],
  name: string,
  input: unknown,
): boolean {
  return declaredToolInputError(tools, name, input) === null;
}
export function declaredToolInputError(
  tools: AnthropicRequest['tools'],
  name: string,
  input: unknown,
): string | null {
  const tool = tools?.find((tool) => tool.name === name);
  if (!tool) return '工具未声明';
  try {
    const dialect = (tool.input_schema as { $schema?: string }).$schema;
    const validator = dialect?.includes('2020-12') ? ajv2020 : ajv;
    return validator.validate(tool.input_schema, input)
      ? null
      : validator.errorsText(validator.errors);
  } catch (error) {
    return error instanceof Error ? error.message : '工具schema无法编译';
  }
}
