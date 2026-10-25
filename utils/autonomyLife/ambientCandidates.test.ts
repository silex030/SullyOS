import { describe, expect, it } from 'vitest';

import { buildAmbientCandidates } from './ambientCandidates';
import { buildRhythmProfile } from './rhythm';

const profile = (personaText: string) => buildRhythmProfile({
  personaText,
  scheduleText: '',
  timezone: 'Asia/Shanghai',
  personaHash: 'h1',
  nowMs: Date.UTC(2026, 9, 24, 4, 0, 0),
});

describe('外部窗口的自主候选（人设兴趣 → 查询词，零模型）', () => {
  it('外部只读可用时：从兴趣标签生成查询，查询词就是标签本身（不外传别的字段）', () => {
    const p = profile('喜欢天文，也爱看小说，是个夜猫子。');
    const candidates = buildAmbientCandidates({
      profile: p,
      externalReadAvailable: true,
      travelAvailable: false,
    });
    expect(candidates.length).toBeGreaterThan(0);
    const external = candidates.find((item) => item.kind === 'external.read')!;
    expect(external).toBeTruthy();
    const args = external.args as { query: string; fields: string[] };
    expect(p.interestTags).toContain(args.query);
    expect(args.fields).toEqual(['title', 'excerpt', 'url']);
    // 语义目的一致、可去重。
    expect(external.semanticPurpose).toBe(`external_interest:${args.query}`);
  });

  it('能力不可用（没配置/没授权/不可达）→ 一个外部候选都不生成', () => {
    const p = profile('喜欢天文，也爱看小说。');
    const candidates = buildAmbientCandidates({
      profile: p,
      externalReadAvailable: false,
      travelAvailable: false,
    });
    expect(candidates.some((item) => item.kind === 'external.read')).toBe(false);
    expect(candidates.some((item) => item.kind === 'travel.wish')).toBe(false);
  });

  it('出行愿望需要真实城市 + 地图可用；wishText 里只用真实城市与兴趣', () => {
    const p = profile('喜欢咖啡和摄影。');
    const noCity = buildAmbientCandidates({ profile: p, externalReadAvailable: false, travelAvailable: true });
    expect(noCity.some((item) => item.kind === 'travel.wish')).toBe(false);

    const withCity = buildAmbientCandidates({
      profile: p,
      externalReadAvailable: false,
      travelAvailable: true,
      city: '杭州',
    });
    const wish = withCity.find((item) => item.kind === 'travel.wish')!;
    expect(wish).toBeTruthy();
    const args = wish.args as { wishText: string; placeHint: string };
    expect(args.placeHint).toBe('杭州');
    expect(args.wishText).toContain('杭州');
    expect(args.wishText).toContain('咖啡');
  });

  it('人设没有任何兴趣标签 → 不编查询词', () => {
    const plain = buildRhythmProfile({
      personaText: '你叫小夏。',
      scheduleText: '',
      timezone: 'Asia/Shanghai',
      personaHash: 'h2',
      nowMs: Date.UTC(2026, 9, 24, 4, 0, 0),
    });
    const candidates = buildAmbientCandidates({
      profile: plain,
      externalReadAvailable: true,
      travelAvailable: true,
      city: '杭州',
    });
    expect(candidates).toEqual([]);
  });
});
