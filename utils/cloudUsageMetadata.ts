import { normalizeLlmUsage } from './llmUsage';

/** 后台消息只回传可解释的用量字段；不透传供应商私有对象。 */
export function cloudUsageMetadata(raw: unknown) {
 const u=normalizeLlmUsage(raw);
 return {
  ...(u.promptTokens !== undefined ? {promptTokens:u.promptTokens}:{}),
  ...(u.completionTokens !== undefined ? {completionTokens:u.completionTokens}:{}),
  ...(u.totalTokens !== undefined ? {totalTokens:u.totalTokens}:{}),
  ...(u.cachedTokens !== undefined ? {cachedTokens:u.cachedTokens}:{}),
  ...(u.cacheReadTokens !== undefined ? {cacheReadTokens:u.cacheReadTokens}:{}),
  ...(u.cacheWriteTokens !== undefined ? {cacheWriteTokens:u.cacheWriteTokens}:{}),
  ...(u.reasoningTokens !== undefined ? {reasoningTokens:u.reasoningTokens}:{}),
  usageStatus:u.status,
  usageCacheReadSemantics:u.cacheReadSemantics,
  usageMissing:u.missing,
 };
}
