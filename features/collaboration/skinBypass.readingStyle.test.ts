import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * t_40feeeaa 第 1 轮返工补测（审计算法 1）：
 * 非 sully 协作皮肤的既有 !important 会压掉行内分享样式，本卡在“已应用分享的
 * 局部目标上避开旧规则”，而不是加全局 !important 反压。
 * 本文件是源码级护栏：断言 5 处气泡覆盖选择器均排除打标节点、MessageBubble
 * 在分享生效时打标、旧规则（无分享路径）原样保留。
 */

const SRC = new URL('./CollaborationWindow.tsx', import.meta.url);

function source(): string {
  return readFileSync(SRC, 'utf8');
}

describe('collab 非 sully 皮肤不再压掉分享样式（源码护栏）', () => {
  it('5 处气泡覆盖规则避让已应用分享的节点', () => {
    const text = source();
    for (const selector of [
      '.collab-ui-root:not(.collab-ui-sully) .collab-message-bubble:not([data-ap-share-applied])',
      '.collab-ui-root:not(.collab-ui-sully) .collab-message-bubble-assistant:not([data-ap-share-applied])',
      '.collab-ui-root:not(.collab-ui-sully) .collab-message-bubble-user:not([data-ap-share-applied])',
      '.collab-ui-kimi .collab-message-bubble-assistant:not([data-ap-share-applied])',
      '.collab-ui-deepseek .collab-message-bubble-assistant:not([data-ap-share-applied])',
    ]) {
      expect(text).toContain(selector);
    }
  });

  it('MessageBubble 在分享生效时给气泡打标，无分享时不打标', () => {
    const text = source();
    expect(text).toContain("data-ap-share-applied={shareStyle ? '1' : undefined}");
  });

  it('旧皮肤行为保留：无分享时原 !important 规则仍在（零视觉变化）', () => {
    const text = source();
    expect(text).toContain('border:0!important');
    expect(text).toContain('background:transparent!important');
    expect(text).toContain('.collab-ui-kimi .collab-message-bubble-assistant:not([data-ap-share-applied])');
  });

  it('不新增全局 !important 补丁抢覆盖（分享变量引用一律无 !important）', () => {
    const text = source();
    const hits = text.split('\n').filter(line => line.includes('--ap-share-') && line.includes('!important'));
    expect(hits).toEqual([]);
  });
});
