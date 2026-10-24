/**
 * read_share_excerpts 的接线守卫（执行卡 t_75dd49a5 / 返工卡 t_38463abd）。
 *
 * 运行时行为在 socialShareTool.test.ts 里真跑（含真实 excerpts 服务逻辑 + fixture 模型/HTTP）；
 * 这里只钉「useChatAI / messageFormat 有没有把那个模块接上」——仓库的 vitest 是纯 Node，
 * useChatAI 绑死 React 跑不起来，沿用 amsg2ChatLoop.wiring.test.ts 的源码级断言做法。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const chatSrc = readFileSync(fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)), 'utf8');
const formatSrc = readFileSync(fileURLToPath(new URL('./messageFormat.ts', import.meta.url)), 'utf8');

describe('read_share_excerpts · useChatAI 接线', () => {
  it('引的是独立模块（逻辑不在 hook 里重写）', () => {
    expect(chatSrc).toContain("from '../utils/socialShareTool'");
    expect(chatSrc).toContain('buildShareExcerptsTool');
    expect(chatSrc).toContain('createShareExcerptTurn');
    expect(chatSrc).toContain('dispatchShareExcerptToolCall');
    expect(chatSrc).toContain('ShareExcerptPairRecorder');
    expect(chatSrc).toContain('SHARE_EXCERPTS_TOOL_NAME');
  });

  it('只有总开关开着 + 有主代理地址 + 分享卡在场才注入工具', () => {
    expect(chatSrc).toMatch(/isSocialShareEnabled\(shareCfg\)\s*\?\s*resolveShareEndpoint\(shareCfg\)\s*:\s*null/);
    expect(chatSrc).toMatch(/createShareExcerptTurn\(contextMsgs,\s*\{\s*endpoint:\s*shareEndpoint\s*\}\)/);
    expect(chatSrc).toMatch(/if\s*\(shareExcerptTurn\)\s*\{[\s\S]{0,220}baseReqBody\.tools\s*=\s*\[\.\.\.\(baseReqBody\.tools\s*\|\|\s*\[\]\),\s*buildShareExcerptsTool\(\)\]/);
  });

  it('一张能读的卡都没有时不注入（失败卡不该换来一个注定报错的工具）', () => {
    expect(chatSrc).toMatch(/if \(shareExcerptTurn && !hasReadableShareExcerptTarget\(shareExcerptTurn\)\) shareExcerptTurn = null;/);
  });

  it('工具循环的入口把分享工具也算进去（不是只有 MCP 才进循环）', () => {
    expect(chatSrc).toMatch(/chatLifeWorkflowToolsInjected\s*\|\|\s*shareExcerptTurn\)\s*&&\s*data\.choices\?\.\[0\]\?\.message\?\.tool_calls\?\.length/);
  });

  it('按工具名分发到执行器，用 dispatch 一次完成「执行 + 立刻成对落库」，再回填工具结果', () => {
    const dispatch = chatSrc.match(/if \(shareExcerptTurn && fname === SHARE_EXCERPTS_TOOL_NAME\) \{[\s\S]{0,700}?continue;/);
    expect(dispatch, '找不到分发块').not.toBeNull();
    expect(dispatch![0]).toContain('dispatchShareExcerptToolCall({');
    expect(dispatch![0]).toContain('recorder: shareExcerptRecorder');
    expect(dispatch![0]).toContain('buildToolResultMessage(tc, excerptOutcome.text)');
    expect(dispatch![0]).toContain('loopMessages.push');
    // 不允许绕过 dispatch 直接调执行器（否则记录又会回到「等最终回复」才有）
    expect(dispatch![0]).not.toContain('executeShareExcerptToolCall(');
  });

  it('落库器锚在本轮触发消息，逐次写库；不依赖最终回复、也不按时间戳猜锚点', () => {
    // 在 try 外声明：成功 / 失败 / 中断三条路径（含 finally）都能收尾
    expect(chatSrc).toMatch(/let shareExcerptRecorder: ShareExcerptPairRecorder \| null = null;/);
    expect(chatSrc).toMatch(/shareExcerptRecorder = shareExcerptTurn\s*\?\s*new ShareExcerptPairRecorder\(\{/);
    expect(chatSrc).toMatch(/anchorId: shareExcerptAnchorId/);
    // 返工第 3 轮 P1：必须用「等事务提交」的专用入口；旧的 updateMessageMetadata 在 put 之后
    // 就 resolve，配额/abort 会把其实没落盘的批次当已保存清掉。
    expect(chatSrc).toMatch(/DB\.updateMessageMetadataCommitted\(messageId, \(prev: any\) => attachShareExcerptPairs\(prev, records\)\)/);
    expect(chatSrc).not.toMatch(/DB\.updateMessageMetadata\(messageId/);
    // 返工要求：不再用「最近 30 条里找 assistant」这种猜锚点
    expect(chatSrc).not.toContain('pickShareExcerptAnchor');
    expect(chatSrc).not.toContain('executeShareExcerptToolCall');
    // 成功尾部与 finally 都收尾 flush（有界重试；重复 flush 幂等）
    const flushes = chatSrc.match(/await shareExcerptRecorder\.flush\(\)/g) || [];
    expect(flushes.length).toBeGreaterThanOrEqual(2);
  });

  it('写库失败有界重试走生产收尾：共享待补偿队列 + 未保存时明确上报', () => {
    // 同一进程内跨轮共享的待补偿队列（失败批次下一次 dispatch/flush 还能补写）
    expect(chatSrc).toMatch(/SHARE_EXCERPT_OUTBOX/);
    expect(chatSrc).toMatch(/outbox: SHARE_EXCERPT_OUTBOX/);
    // 收尾仍没落库 → 明确打日志（不静默当作已保存）
    expect(chatSrc).toMatch(/if \(excerptPersist\.unsaved\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*console\.error\('\[share-excerpt\] 分享工具记录仍有未写入历史的批次，保留在待补偿队列：'/);
  });

  it('专用落库入口必须等事务提交（db.ts 里是 oncomplete/onerror/onabort 三件套）', () => {
    const dbSrc = readFileSync(fileURLToPath(new URL('./db.ts', import.meta.url)), 'utf8');
    const block = dbSrc.match(/updateMessageMetadataCommitted: async \(id: number, updater: \(prev: any\) => any\): Promise<void> => \{[\s\S]*?\n  \},\n/);
    expect(block, '找不到 updateMessageMetadataCommitted').not.toBeNull();
    expect(block![0]).toContain('transaction.oncomplete');
    expect(block![0]).toContain('transaction.onerror');
    expect(block![0]).toContain('transaction.onabort');
    expect(block![0]).not.toMatch(/store\.put\(data\);\s*\n\s*resolve\(\)/);
  });

  it('拿不到本轮持久化锚点时不注入工具（读完却没地方落库的调用不该存在）', () => {
    expect(chatSrc).toMatch(/const shareExcerptAnchorId = pickShareExcerptTurnAnchor\(contextMsgs\);/);
    expect(chatSrc).toMatch(/if \(shareExcerptTurn && shareExcerptAnchorId == null\) shareExcerptTurn = null;/);
  });

  it('中转拒绝 tools 时这一轮退回无工具且明确不许假装读过', () => {
    expect(chatSrc).toContain('这一轮外部工具不可用：不要声称读过分享片段，基于卡片里已有的简介回答。');
    expect(chatSrc).toMatch(/if \(shareToolOnly\) \{\s*shareExcerptTurn = null;/);
  });

  it('同一轮还有排程工具时，降级也要堵住「假装登记成功」', () => {
    expect(chatSrc).toMatch(/if \(shareToolOnly && amsg2ToolsInjected\) \{/);
    expect(chatSrc).toContain('这一轮排程工具不可用：不要声称已经记下、修改或撤销任何提醒/安排。');
  });
});

describe('read_share_excerpts · 下一轮投影接线', () => {
  it('messageFormat 的 normalizeMessageContent 会拼上成对记录投影', () => {
    expect(formatSrc).toContain("from './socialShareTool'");
    expect(formatSrc).toMatch(/const excerptProjection = renderShareExcerptPairProjection\(msg\.metadata, msg\.role\)/);
    expect(formatSrc).toMatch(/return excerptProjection \? `\$\{body\}\\n\\n\$\{excerptProjection\}` : body;/);
  });
});

describe('read_share_excerpts · 可见标识与文档', () => {
  it('模型投影用完整 shareRef（不再截成 12 字符的短引用）', () => {
    const shareSrc = readFileSync(fileURLToPath(new URL('./socialShare.ts', import.meta.url)), 'utf8');
    expect(shareSrc).toMatch(/const ref = share\.shareRef;/);
    expect(shareSrc).toMatch(/const token = `\[分享 \$\{att\.shareRef\}\]`;/);
    expect(shareSrc).not.toMatch(/const ref = shortShareRef\(share\.shareRef\)/);
    expect(shareSrc).not.toMatch(/\[分享 \$\{shortShareRef\(att\.shareRef\)\}\]/);
  });

  it('文档 §8 记录工具接入、可见标识、预算与失败/超限降级', () => {
    const docPath = fileURLToPath(new URL('../docs/social-content/integration-v1.md', import.meta.url));
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    expect(doc).toContain('工具接入与预算');
    expect(doc).toContain('SHARE_REF_AMBIGUOUS');
    expect(doc).toContain('ShareExcerptPairRecorder');
    // 返工第 2 轮：无锚点不读 + 写库失败的真实重试/未保存语义必须写进文档（不能只承诺「会重试」）
    expect(doc).toContain('HISTORY_UNAVAILABLE');
    expect(doc).toContain('ShareExcerptPairOutbox');
    expect(doc).toContain('未保存·待补偿');
    // 返工第 3 轮：去重按（锚点, toolCallId）+ 写库等事务提交，都必须写进文档
    expect(doc).toContain('（锚点, toolCallId）');
    expect(doc).toContain('updateMessageMetadataCommitted');
    expect(doc).toContain('### 8.12 返工记录（第 3 轮');
  });
});
