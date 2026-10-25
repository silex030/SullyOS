/**
 * read_share_excerpts 的接线守卫（执行卡 t_75dd49a5）。
 *
 * 运行时行为在 socialShareTool.test.ts 里真跑（含真实 excerpts 服务逻辑 + fixture 模型/HTTP）；
 * 这里只钉「useChatAI / messageFormat 有没有把那个模块接上」——仓库的 vitest 是纯 Node，
 * useChatAI 绑死 React 跑不起来，沿用 amsg2ChatLoop.wiring.test.ts 的源码级断言做法。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const chatSrc = readFileSync(fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)), 'utf8');
const formatSrc = readFileSync(fileURLToPath(new URL('./messageFormat.ts', import.meta.url)), 'utf8');

describe('read_share_excerpts · useChatAI 接线', () => {
  it('引的是独立模块（逻辑不在 hook 里重写）', () => {
    expect(chatSrc).toContain("from '../utils/socialShareTool'");
    expect(chatSrc).toContain('buildShareExcerptsTool');
    expect(chatSrc).toContain('createShareExcerptTurn');
    expect(chatSrc).toContain('executeShareExcerptToolCall');
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

  it('按工具名分发到执行器，并用 buildToolResultMessage 成对回填', () => {
    const dispatch = chatSrc.match(/if \(shareExcerptTurn && fname === SHARE_EXCERPTS_TOOL_NAME\) \{[\s\S]{0,600}?continue;/);
    expect(dispatch, '找不到分发块').not.toBeNull();
    expect(dispatch![0]).toContain('executeShareExcerptToolCall({ toolCall: tc, turn: shareExcerptTurn })');
    expect(dispatch![0]).toContain('buildToolResultMessage(tc, excerptOutcome.text)');
    expect(dispatch![0]).toContain('loopMessages.push');
  });

  it('本轮 call/result 成对落进助手消息 metadata（下一轮投影读得回来）', () => {
    expect(chatSrc).toMatch(/pickShareExcerptAnchor\(recentAfterTurn as any\[\], turnStartedAt\)/);
    expect(chatSrc).toMatch(/DB\.updateMessageMetadata\(anchorId, \(prev: any\) => attachShareExcerptPairs\(prev, records\)\)/);
  });

  it('中转拒绝 tools 时这一轮退回无工具且明确不许假装读过', () => {
    expect(chatSrc).toContain('这一轮外部工具不可用：不要声称读过分享片段，基于卡片里已有的简介回答。');
    expect(chatSrc).toMatch(/if \(shareToolOnly\) \{\s*shareExcerptTurn = null;/);
  });
});

describe('read_share_excerpts · 下一轮投影接线', () => {
  it('messageFormat 的 normalizeMessageContent 会拼上成对记录投影', () => {
    expect(formatSrc).toContain("from './socialShareTool'");
    expect(formatSrc).toMatch(/const excerptProjection = renderShareExcerptPairProjection\(msg\.metadata, msg\.role\)/);
    expect(formatSrc).toMatch(/return excerptProjection \? `\$\{body\}\\n\\n\$\{excerptProjection\}` : body;/);
  });
});
