import { isEffort, MODELS, type Effort } from './client';
import { OUTPUT_LIMITS } from '../settings';

/** 当前输入框在发送这一条时展示的选项。 */
export interface SendOptions {
  model: string;
  thinking: boolean;
  effort: Effort;
  search: boolean;
  maxTokens: number;
}

/** 复制五个公开字段。缺失或无效的值不能用其他标签写入的默认值替代。 */
export function parseSendOptions(value: unknown): SendOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('缺少有效的发送选项，请刷新页面后重试');
  const { model, thinking, effort, search, maxTokens } = value as Record<string, unknown>;
  if (typeof model !== 'string' || !MODELS.some((candidate) => candidate === model)) throw new Error('未知模型');
  if (typeof thinking !== 'boolean' || typeof search !== 'boolean') throw new Error('思考或搜索选项无效');
  if (!isEffort(effort)) throw new Error('思考强度无效');
  if (typeof maxTokens !== 'number' || !OUTPUT_LIMITS.includes(maxTokens)) throw new Error('输出上限无效');
  return { model, thinking, effort, search, maxTokens };
}
