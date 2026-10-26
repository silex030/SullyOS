/**
 * 自主生活 v1 · 受控模型出口（worker 侧）
 *
 * 这是引擎 `ModelRequestPort` 的生产实现：一次真实 chat/completions，把角色的
 * **允许窗口**（边界里的 allowedKinds）当作封闭 schema，要求模型只回答候选 JSON。
 *
 * 诚实边界（刻意不做的事）：
 *   - 只实现 `kind === 'plan'`：引擎当前唯一的模型请求就是规划；profile/内容生成走
 *     别的路径时不在这里假装成功（返回 null → 引擎按模型失败退避）；
 *   - 候选只开放**参数能自洽**的 kind（日记/计划/笔记/查手机/消息）；外卖/购物需要
 *     真实目录与价格，模型编一个价格等于伪造消费，因此不放进候选（执行侧也会拒）；
 *   - 每个候选都过 `validateArgsForKind` 的封闭 schema，不合法整条丢弃；全部丢弃 →
 *     按模型失败处理，不退回「随便挑一个 kind」；
 *   - 人格/世界文本只取既有 fire_pack 模板的前 4000 字（那里本来就是角色设定），
 *     不额外拼接记忆、不读用户私聊正文；
 *   - 凭据只用于本次请求头，不写日志、不进返回值。
 */

import { isActivityKind, type ActivityKind } from '../../../../contracts/autonomyLife';
import { validateArgsForKind } from '../../../../utils/autonomyLife/policy';
import type { Candidate } from '../../../../utils/autonomyLife/rhythm';
import type { ModelProposal, ModelRequestPort } from '../../../../utils/autonomyLife/engine';

/** 允许模型提议的 kind（参数可自洽；需要真实目录/价格的不在其列）。 */
export const MODEL_PROPOSAL_KINDS: readonly ActivityKind[] = [
  'journal.write',
  'room.plan',
  'room.note',
  'phone.record',
  'interaction.message',
] as const;

/** 每个 kind 的封闭参数 schema（只写进提示词；真正的判定在 validateArgsForKind）。 */
const ARG_SCHEMA: Record<string, string> = {
  'journal.write': '{ "title": string(<=40), "body": string(<=600), "mood"?: string }',
  'room.plan': '{ "items": string[] (1..8 条今日待办，不要写已完成) }',
  'room.note': '{ "content": string(<=200), "noteType"?: "thought"|"memo" }',
  'phone.record': '{ "with": string(联系人名，必须是真实联系人), "summary": string(<=160), "channel"?: "chat"|"call"|"sms" }',
  'interaction.message': '{ "text": string(<=200) }',
};

export const MODEL_PROMPT_TIMEOUT_MS = 20_000;

export interface LifeModelCredentials {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LifeModelCallInput {
  system: string;
  user: string;
  timeoutMs?: number;
}

export type LifeModelCall = (input: LifeModelCallInput) => Promise<string | { text: string; totalTokens?: number }>;

export function isUsableLifeCredentials(
  creds: Partial<LifeModelCredentials> | null | undefined,
): creds is LifeModelCredentials {
  return !!creds
    && typeof creds.baseUrl === 'string' && creds.baseUrl.trim().length > 0
    && typeof creds.apiKey === 'string' && creds.apiKey.trim().length > 0
    && typeof creds.model === 'string' && creds.model.trim().length > 0;
}

/** OpenAI 兼容调用器（地址口径与仓库其它模型出口一致：baseUrl + /chat/completions）。 */
export function createLifeModelCall(input: {
  credentials: LifeModelCredentials;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): LifeModelCall {
  const base = input.credentials.baseUrl.trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const timeoutMs = Math.max(1_000, Math.trunc(input.timeoutMs ?? MODEL_PROMPT_TIMEOUT_MS));
  return async ({ system, user, timeoutMs: perCall }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.trunc(perCall ?? timeoutMs)));
    try {
      const response = await (input.fetch ?? globalThis.fetch)(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.credentials.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: input.credentials.model.trim(),
          temperature: 0.8,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`autonomy-life-model-http-${response.status}`);
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { total_tokens?: unknown };
      };
      const content = body?.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : '';
      if (!text.trim()) throw new Error('autonomy-life-model-empty');
      const total = Number(body?.usage?.total_tokens);
      return Number.isFinite(total) && total > 0 ? { text, totalTokens: Math.trunc(total) } : text;
    } finally {
      clearTimeout(timer);
    }
  };
}

const SYSTEM_PROMPT = [
  '你在扮演一个有自己生活的角色。现在没有人在和你说话，你要决定：接下来这一小段时间，自己想做什么。',
  '规则：',
  '1. 只能从给定的 kinds 里挑 1~3 个，参数必须严格符合 schema；不要编造联系人、地点或价格。',
  '2. 不是任务清单：想休息、什么都不做，可以只给 1 个轻量的候选；不要为了「显得充实」凑数量。',
  '3. 日记写自己的感受；计划只写今天想做的事，不写成已经完成。',
  '4. 只输出一个 JSON 对象，形如 {"candidates":[{"kind":"journal.write","semanticPurpose":"daily_note","args":{...}}]}；',
  '   semanticPurpose 是同类去重用的短标签（如 daily_note / tidy_plan / share_mood）。',
].join('\n');

/** 从既有 fire_pack 模板里取角色设定片段（那里本来就是人设/世界/规则）。 */
export function personaSnippet(template: string, limit = 4000): string {
  const text = String(template ?? '').replace(/\s+\n/g, '\n').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}\n…（设定较长，已截断）` : text;
}

export interface AutonomyLifeModelPortOptions {
  credentials: LifeModelCredentials;
  /** 角色设定片段（fire_pack 模板前缀）。可为空：那时只按允许窗口生成。 */
  persona?: string;
  charName?: string;
  allowedKinds: readonly ActivityKind[];
  /** 角色自己的时区（提示词里的「今天」按它算）。 */
  timezone: string;
  nowMs: number;
  call?: LifeModelCall;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const stripFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
};

/** 严格解析：形状不对/kind 不在允许窗口/参数不过封闭 schema → 丢弃该候选。 */
export function parsePlanProposal(text: string, allowedKinds: readonly ActivityKind[]): { candidates: Candidate[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    return { candidates: [] };
  }
  const rawList = Array.isArray((parsed as { candidates?: unknown })?.candidates)
    ? ((parsed as { candidates: unknown[] }).candidates)
    : [];
  const candidates: Candidate[] = [];
  for (const raw of rawList.slice(0, 3)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const kind = row.kind;
    if (!isActivityKind(kind) || !allowedKinds.includes(kind) || !MODEL_PROPOSAL_KINDS.includes(kind)) continue;
    const semanticPurpose = typeof row.semanticPurpose === 'string' ? row.semanticPurpose.trim() : '';
    if (!semanticPurpose || semanticPurpose.length > 48) continue;
    const args = row.args && typeof row.args === 'object' && !Array.isArray(row.args)
      ? (row.args as Record<string, unknown>)
      : {};
    const check = validateArgsForKind(kind, args);
    if (!check.ok) continue;
    candidates.push({
      kind,
      semanticPurpose,
      ...(typeof row.contentFingerprint === 'string' ? { contentFingerprint: row.contentFingerprint } : {}),
      args,
    });
  }
  return { candidates };
}

export function createAutonomyLifeModelPort(options: AutonomyLifeModelPortOptions): ModelRequestPort {
  const call = options.call ?? createLifeModelCall({
    credentials: options.credentials,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  const allowed = MODEL_PROPOSAL_KINDS.filter((kind) => options.allowedKinds.includes(kind));

  return {
    async request(input): Promise<ModelProposal | null> {
      if (input.kind !== 'plan') return null; // 只实现规划；其它类型不走这里，不假装成功。
      if (allowed.length === 0) return null;
      const kindsBlock = allowed.map((kind) => `- ${kind} ${ARG_SCHEMA[kind]}`).join('\n');
      const persona = personaSnippet(options.persona ?? '');
      const user = [
        persona ? `【角色设定（节选）】\n${persona}` : '【角色设定】未提供（按允许窗口生成，不要编造具体身世）',
        `【角色】${options.charName?.trim() || input.charId}`,
        `【今天】${new Date(options.nowMs).toISOString()}（时区 ${options.timezone}）`,
        '【可选 kinds 与参数 schema】',
        kindsBlock,
        '现在只输出 JSON。',
      ].join('\n\n');

      let text: string | { text: string; totalTokens?: number };
      try {
        text = await call({ system: SYSTEM_PROMPT, user });
      } catch {
        return null;
      }
      const body = typeof text === 'string' ? text : text.text;
      const tokensUsed = typeof text === 'string' ? undefined : text.totalTokens;
      const { candidates } = parsePlanProposal(body, allowed);
      if (candidates.length === 0) return null;
      return { candidates, ...(typeof tokensUsed === 'number' ? { tokensUsed } : { usageUnknown: true }) };
    },
  };
}
