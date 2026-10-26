/**
 * 受控外部窗口的「自主候选」：由人设兴趣 + 真实城市确定性生成，零 IO、零模型。
 *
 * 为什么不用模型编：外部只读（小红书式搜索 / 出行愿望）不需要价格也不需要正文生成，
 * 需要的只是「想了解什么」这个人设信号。用 profile.interestTags 直接拼查询词，
 * 模型就没有机会编造「我刷到了什么」（编造阅读结果 = 伪造经历）。
 *
 * 硬前置（任何一条不满足就不生成候选，不靠下游拒绝兜底）：
 *   - external.read：运营侧配了端点 + 主机白名单、且用户当前有未过期的 xhs 授权；
 *   - travel.wish：地图侧配好且用户当前有未过期的 amap 授权，并且角色有真实城市。
 */

import type { Candidate, RhythmProfile } from './rhythm';

export interface AmbientCandidateInput {
  profile: RhythmProfile;
  /** 外部只读窗口当前是否可用（配置 + 可达 + 授权，由能力探测给出）。 */
  externalReadAvailable: boolean;
  /** 出行窗口当前是否可用（地图配置 + 可达 + 授权）。 */
  travelAvailable: boolean;
  /** 角色真实城市（来自 fire_pack scene.charCity）；空 = 不生成出行愿望。 */
  city?: string;
  /** 最多生成几条（默认 2）。 */
  maxCandidates?: number;
}

/** 查询词只允许人设里的兴趣标签本身（不拼私聊正文/地址/联系方式）。 */
const isSafeQuery = (text: string): boolean =>
  text.length >= 2 && text.length <= 24 && !/(https?:\/\/|@|地址|电话|身份证|密码|token)/i.test(text);

export function buildAmbientCandidates(input: AmbientCandidateInput): Candidate[] {
  const limit = Math.max(0, Math.trunc(input.maxCandidates ?? 2));
  if (limit === 0) return [];
  const interests = input.profile.interestTags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && isSafeQuery(tag))
    .slice(0, 4);
  const candidates: Candidate[] = [];

  if (input.externalReadAvailable) {
    for (const tag of interests) {
      if (candidates.length >= limit) break;
      candidates.push({
        kind: 'external.read',
        semanticPurpose: `external_interest:${tag}`,
        contentFingerprint: `external:${tag}`,
        interestTags: [tag],
        args: { query: tag, fields: ['title', 'excerpt', 'url'] },
      });
    }
  }

  const city = (input.city ?? '').trim();
  if (input.travelAvailable && city && city.length <= 20 && interests.length > 0 && candidates.length < limit) {
    const tag = interests[0];
    candidates.push({
      kind: 'travel.wish',
      semanticPurpose: `travel_wish:${tag}`,
      contentFingerprint: `travel:${city}:${tag}`,
      interestTags: [tag],
      args: { wishText: `想去${city}的${tag}相关的地方看看`, placeHint: city },
    });
  }

  return candidates;
}
