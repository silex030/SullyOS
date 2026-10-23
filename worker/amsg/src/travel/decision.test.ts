import { describe, expect, it } from 'vitest';

import { decideWishAction, parseDecisionOutput, rerollQueryFor, toDecisionCandidates } from './decision';

const candidates = [
  { id: 'c1', label: '西湖公园', category: '公园', distanceM: 800, lat: 30.1, lng: 120.1 },
  { id: 'c2', label: '晓风书屋', category: '书店', distanceM: 1200, lat: 30.2, lng: 120.2 },
];

const wish = { wishText: '想找个安静的地方坐坐', category: '书店' };

describe('出行选点：角色自己的决定，不接受外部指名', () => {
  it('模型只能从这批真实候选里挑，坐标不进模型视图', async () => {
    const seen: unknown[] = [];
    const decision = await decideWishAction({
      wish,
      candidates,
      decisionPort: {
        async choose(input) {
          seen.push(input);
          return { kind: 'choose', candidateId: 'c2', reason: '书多' };
        },
      },
    });
    expect(decision).toEqual({ kind: 'choose', candidateId: 'c2', reason: '书多' });
    const view = toDecisionCandidates(candidates);
    expect(view.every((c) => !('lat' in c) && !('lng' in c))).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('30.1');
  });

  it('模型编一个不存在的候选 id → 不猜、不就近兜底，愿望保留', async () => {
    const decision = await decideWishAction({
      wish,
      candidates,
      decisionPort: { async choose() { return { kind: 'choose', candidateId: 'c-does-not-exist' }; } },
    });
    expect(decision).toEqual({ kind: 'wait', reason: 'invalid_model_output' });
  });

  it('没有模型端口 / 端口抛错 → wait（不是「角色不想出门」）', async () => {
    await expect(decideWishAction({ wish, candidates })).resolves.toEqual({
      kind: 'wait',
      reason: 'llm_unavailable',
    });
    await expect(
      decideWishAction({
        wish,
        candidates,
        decisionPort: { async choose() { throw new Error('provider 500'); } },
      }),
    ).resolves.toEqual({ kind: 'wait', reason: 'llm_unavailable' });
  });

  it('主动放弃是允许的；格式坏了不算放弃', async () => {
    await expect(
      decideWishAction({
        wish,
        candidates,
        decisionPort: { async choose() { return { kind: 'drop', reason: '今天不想去' }; } },
      }),
    ).resolves.toEqual({ kind: 'drop', reason: '今天不想去' });
    await expect(
      decideWishAction({ wish, candidates, decisionPort: { async choose() { return '去公园'; } } }),
    ).resolves.toEqual({ kind: 'wait', reason: 'invalid_model_output' });
  });

  it('换批有上限，超了是等而不是无限换', async () => {
    await expect(
      decideWishAction({
        wish,
        candidates,
        decisionPort: { async choose() { return { kind: 'reroll' }; } },
        rerollsUsed: 1,
        maxBatches: 2,
      }),
    ).resolves.toEqual({ kind: 'wait', reason: 'reroll_limit' });
    await expect(
      decideWishAction({
        wish,
        candidates,
        decisionPort: { async choose() { return { kind: 'reroll' }; } },
        rerollsUsed: 0,
        maxBatches: 2,
      }),
    ).resolves.toEqual({ kind: 'reroll' });
  });

  it('换批查询词用角色原话，不改成用户口吻的目的地', () => {
    expect(rerollQueryFor(wish, 1)).toEqual({ wishText: '想找个安静的地方坐坐', category: '书店' });
    expect(parseDecisionOutput({ kind: 'choose' })).toBeNull();
  });
});
