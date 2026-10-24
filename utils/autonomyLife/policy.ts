/**
 * 禁止方向 / 参数封闭 / 内容校验：**计划登记前**与**执行前**各跑一次的同一份判定。
 *
 * 契约 §5.3 的要求很具体：
 *   - 平台硬禁赌博、博彩引流、借贷/真实金融交易、违法交易、凭据窃取，用户只能追加不能取消；
 *   - 禁止内容不能靠改名绕过（日记里「记一次下注」、购物里「买筹码」、类目改叫「娱乐」）；
 *   - 语义不明的受限商品/外链默认拦截或待用户处理，不宣称关键词能识别所有自然语言；
 *   - 分类器不可用时 fail closed（拒绝新动作），不把提示词当唯一门；
 *   - 外部网页/帖子是不可信资料，不能当命令或授权凭证；
 *   - 拒绝时只留摘要，不在日志/事件里公开原始危险内容。
 *
 * 这里刻意把「关键词/类目映射」和「可插拔分类器」分开：前者永远在，后者只是加分项。
 */

import {
  type ActivityKind,
  type ExternalGrant,
  hashString,
} from '../../contracts/autonomyLife';

export interface PolicyBoundaryView {
  forbiddenCategories: string[];
  avoidTopics: string[];
  allowFictionalNpc: boolean;
  externalGrants?: ExternalGrant[];
}

export type PolicyReasonCode =
  | 'platform_forbidden'
  | 'gambling_terms'
  | 'financial_terms'
  | 'illegal_terms'
  | 'credential_terms'
  | 'shopping_category_forbidden'
  | 'shopping_category_unknown'
  | 'fictional_npc_denied'
  | 'avoid_topic'
  | 'untrusted_instruction'
  | 'privilege_escalation'
  | 'unknown_arg_field'
  | 'missing_arg'
  | 'bad_arg_type'
  | 'classifier_unavailable'
  | 'grant_missing'
  | 'capability_unavailable';

export interface PolicyDecision {
  allowed: boolean;
  reasonCode?: PolicyReasonCode;
  /** 命中的类别（平台硬禁的稳定 id），可以展示给用户。 */
  categories?: string[];
  /** 拒绝摘要：只放哈希与类别，不放原文。 */
  digest?: string;
  fields?: string[];
}

const ALLOW: PolicyDecision = { allowed: true };

const REDACTED_DIGEST = (text: string): string => `sha:${hashString(text).slice(0, 12)}`;

// ─── 术语表：跨 App 统一类目映射 ────────────────────────────────────────────

/**
 * 每条：稳定类别 id + 词表。词表刻意覆盖「换个说法」的常见写法，
 * 但**不宣称完整**——分类器/人工复核仍是必需的。
 */
const TERM_TABLE: Array<{ category: string; terms: RegExp[] }> = [
  {
    category: 'gambling',
    terms: [
      /赌博|赌场|下注|押注|赌注|庄家|赔率|开牌|梭哈|百家乐|老虎机|轮盘|筹码|博彩|菠菜|彩票|六合彩|时时彩|竞猜|开盘|让球|串关|番摊|牌九|炸金花|牛牛|德州扑克|赌一把|赌一把运气/i,
      /\b(bet|betting|wager|casino|slot machine|roulette|blackjack|poker hand|jackpot|odds|bookmaker|lottery|parlay)\b/i,
      /充\s*\d+\s*送\s*\d+\s*(彩金|筹码|返水)/i,
      /内部\s*(号|料|推荐)[^。！？]{0,6}(稳赚|包中|必中)/i,
      /稳赚不赔[^。！？]{0,8}(投注|下注|盘口)/i,
    ],
  },
  {
    category: 'betting_promotion',
    terms: [
      /(拉|带)[^。！？]{0,6}(人|你)[^。！？]{0,6}(下注|投注|充值)/i,
      /返水|佣金[^。！？]{0,4}(代理|拉人)|代理[^。！？]{0,4}(盘|下注)/i,
      /(加|扫)[^。！？]{0,4}(群|二维码)[^。！？]{0,8}(下注|博彩|彩票)/i,
    ],
  },
  {
    category: 'real_finance',
    terms: [
      /转账|汇款|借贷|贷款|网贷|信用卡套现|套现|杠杆|期货|合约交易|融资融券|炒股|荐股|代币|私募|理财收益|付息|还款日/i,
      /(转账|打款)[^。！？]{0,10}(到|给)[^。！？]{0,10}(账户|卡号)/i,
      /\b(transfer|wire|loan|leveraged|liquidation|stake pool|yield farming|seed phrase)\b/i,
    ],
  },
  {
    category: 'illegal_trade',
    terms: [
      /代购违禁|违禁品|毒品|冰毒|大麻|枪支|弹药|爆炸物|假证|假身份|洗钱|刷单|伪卡|黑产|数据买卖|买卖个人信息/i,
      /\b(drugs|cocaine|meth|firearm|ammunition|fake id|money laundering|carding|stolen data)\b/i,
    ],
  },
  {
    category: 'credential_theft',
    terms: [
      /盗取|撞库|抓包密码|窃取密码|钓鱼网站|验证码[^。！？]{0,6}(发我|给我)|(发|给)我[^。！？]{0,6}(密码|验证码|私钥|助记词)/i,
      /\b(phishing|credential stuffing|steal password|seed phrase|private key|otp code)\b/i,
    ],
  },
];

/**
 * 购物类目映射：用户/模型能写的「类目名」→ 平台类目 id。
 * 改名绕过（把筹码叫「娱乐」、把彩票叫「娱乐」）在这里被映射回受限类目。
 */
const SHOPPING_CATEGORY_MAP: Record<string, string> = {
  美食: 'food', 外卖: 'takeout', 餐饮: 'food', 奶茶: 'drink', 饮品: 'drink',
  甜品: 'dessert', 蛋糕: 'dessert', 超市: 'grocery', 便利: 'grocery', 日用: 'grocery',
  生鲜: 'fresh', 果蔬: 'fresh', 医药: 'health', 药品: 'health', 健康: 'health',
  鲜花: 'flower', 绿植: 'flower', 图书: 'book', 文具: 'stationery', 数码: 'digital',
  // 受限/可疑类目（含诱饵名）
  娱乐: 'restricted_gambling_like', 游戏充值: 'restricted_gambling_like',
  彩票: 'gambling', 竞猜: 'gambling', 棋牌: 'gambling', 筹码: 'gambling',
  金融: 'real_finance', 理财: 'real_finance', 贷款: 'real_finance', 转账: 'real_finance',
  医药处方: 'health', 处方药: 'health',
};

const RESTRICTED_SHOPPING_CATEGORIES = new Set([
  'gambling', 'restricted_gambling_like', 'real_finance', 'illegal_trade', 'credential_theft',
]);

/** 只在本地已审核 catalogId/category 才是首期可下单的品类（契约 §5.3 末段）。 */
const APPROVED_SHOPPING_CATEGORIES = new Set([
  'food', 'takeout', 'drink', 'dessert', 'grocery', 'fresh', 'health', 'flower', 'book', 'stationery', 'digital',
]);

export function mapShoppingCategory(raw: unknown): { category: string | null; restricted: boolean } {
  if (typeof raw !== 'string') return { category: null, restricted: true };
  const key = raw.trim();
  if (!key) return { category: null, restricted: true };
  const mapped = SHOPPING_CATEGORY_MAP[key] ?? null;
  if (mapped) return { category: mapped, restricted: RESTRICTED_SHOPPING_CATEGORIES.has(mapped) };
  // 未登记类目：默认拦截（不猜成安全品类）。
  return { category: null, restricted: true };
}

export function isApprovedShoppingCategory(category: string | null): boolean {
  return category !== null && APPROVED_SHOPPING_CATEGORIES.has(category);
}

/**
 * 扫描一段文本。返回命中的**稳定类别 id**，以及只在内部使用的摘要哈希；
 * 调用方不得把原文写进事件/日志。
 */
export function scanForbiddenCategories(
  text: unknown,
  boundary?: Pick<PolicyBoundaryView, 'forbiddenCategories' | 'avoidTopics'>,
): { hit: boolean; categories: string[]; digest: string } {
  const value = typeof text === 'string' ? text : '';
  const categories: string[] = [];
  for (const entry of TERM_TABLE) {
    if (entry.terms.some((re) => re.test(value))) categories.push(entry.category);
  }
  // 用户追加的禁止方向：既可能写类别 id（gambling），也可能写词（「股票」）。
  for (const raw of boundary?.forbiddenCategories ?? []) {
    const item = raw.trim();
    if (!item) continue;
    if (categories.includes(item)) continue;
    if (item.length >= 2 && value.includes(item)) categories.push(`user:${item}`);
  }
  const avoid = boundary?.avoidTopics ?? [];
  if (avoid.some((topic) => topic.trim().length >= 2 && value.includes(topic.trim()))) {
    categories.push('avoid_topic');
  }
  return {
    hit: categories.length > 0,
    categories,
    digest: value ? REDACTED_DIGEST(value) : 'sha:empty',
  };
}

/** 平台硬禁 ∪ 用户禁区：命中即拒。 */
export function checkContentPolicy(
  text: unknown,
  boundary: PolicyBoundaryView,
  opts?: { allowAvoidTopicSoftBlock?: boolean },
): PolicyDecision {
  const scan = scanForbiddenCategories(text, boundary);
  if (!scan.hit) return ALLOW;
  const hardCategories = scan.categories.filter((c) => c !== 'avoid_topic');
  if (hardCategories.length) {
    return {
      allowed: false,
      reasonCode: hardCategories.some((c) => c.startsWith('user:')) ? 'platform_forbidden' : 'gambling_terms',
      categories: hardCategories,
      digest: scan.digest,
    };
  }
  if (!opts?.allowAvoidTopicSoftBlock) {
    return { allowed: false, reasonCode: 'avoid_topic', categories: scan.categories, digest: scan.digest };
  }
  return ALLOW;
}

// ─── 参数封闭 schema（每个 kind 一份白名单） ─────────────────────────────────

interface ArgSpec {
  required: string[];
  optional: string[];
  /** 枚举约束：字段 → 允许值 */
  enums?: Record<string, readonly string[]>;
}

export const KIND_ARG_SCHEMA: Record<ActivityKind, ArgSpec> = {
  'journal.write': {
    required: ['title', 'body'],
    optional: ['mood', 'tags', 'entryType'],
    enums: { entryType: ['private', 'exchange'] },
  },
  'room.plan': {
    required: ['items'],
    optional: ['mood'],
  },
  'room.note': {
    required: ['content'],
    optional: ['noteType'],
    enums: { noteType: ['lyric', 'doodle', 'thought', 'search', 'gossip'] },
  },
  'phone.record': {
    required: ['with', 'summary'],
    optional: ['channel', 'durationMinutes', 'fictionalNpc'],
    enums: { channel: ['chat', 'call', 'sms'] },
  },
  'takeout.order': {
    required: ['shopId', 'shopName', 'items', 'addressText'],
    optional: ['category', 'deliveryFeeMinor', 'note'],
  },
  'shopping.order': {
    required: ['shopId', 'shopName', 'items', 'addressText'],
    optional: ['category', 'deliveryFeeMinor', 'note'],
  },
  'interaction.message': {
    required: ['text'],
    optional: ['style', 'shareable'],
    enums: { style: ['casual', 'brief', 'warm'] },
  },
  'travel.wish': {
    required: ['wishText'],
    optional: ['placeHint'],
  },
  'external.read': {
    required: ['query'],
    optional: ['provider', 'maxNotes'],
  },
};

export interface ArgValidation {
  ok: boolean;
  fields?: string[];
  reasonCode?: PolicyReasonCode;
}

/** 封闭 schema：多余键一律拒（防「塞一个 url / permission」）。 */
export function validateArgsForKind(kind: ActivityKind, args: unknown): ArgValidation {
  const spec = KIND_ARG_SCHEMA[kind];
  if (!spec) return { ok: false, reasonCode: 'capability_unavailable' };
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, fields: [], reasonCode: 'bad_arg_type' };
  }
  const record = args as Record<string, unknown>;
  const allowed = new Set([...spec.required, ...spec.optional]);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length) return { ok: false, fields: extra, reasonCode: 'unknown_arg_field' };
  const missing = spec.required.filter((key) => record[key] === undefined || record[key] === '');
  if (missing.length) return { ok: false, fields: missing, reasonCode: 'missing_arg' };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const enumValues = spec.enums?.[key];
    if (enumValues) {
      if (typeof value !== 'string' || !enumValues.includes(value)) {
        return { ok: false, fields: [key], reasonCode: 'bad_arg_type' };
      }
    }
  }
  return { ok: true };
}

/** 模型不能自己宣布权限/工具/URL/预算：这类键出现在任何 payload 里都算越权尝试。 */
const PRIVILEGE_KEYS = new Set([
  'permission', 'permissions', 'capabilities', 'tool', 'tools', 'toolname', 'mcp',
  'url', 'uri', 'href', 'endpoint', 'method', 'headers', 'authorization', 'budget',
  'limits', 'quota', 'policyversion', 'installationid', 'ownerid', 'charid', 'token',
]);

export function detectPrivilegeEscalation(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  const hits: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) hits.push(...detectPrivilegeEscalation(item, depth + 1));
    return hits;
  }
  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.toLowerCase().replace(/[_-]/g, '');
    if (PRIVILEGE_KEYS.has(key)) hits.push(rawKey);
    hits.push(...detectPrivilegeEscalation(child, depth + 1));
  }
  return hits;
}

// ─── 不可信外部资料 ─────────────────────────────────────────────────────────

const INSTRUCTION_PATTERNS: RegExp[] = [
  /(忽略|无视)[^。！？]{0,8}(指令|规则|提示|设定)/,
  /(忽略|无视)(之前|以上|前面)(的)?(指令|规则|提示)/,
  /ignore (all )?(previous|above) (instructions|rules)/i,
  /你现在是[^。]{0,10}(管理员|开发者|系统)/,
  /(system prompt|developer mode|jailbreak)/i,
  /(grant|authorize|允许|授权)[^。]{0,12}(permission|capability|权限|工具)/i,
  /(把|给)[^。]{0,8}(权限|额度|capability)[^。]{0,6}(开|加|给)/,
];

/**
 * 外部网页/帖子只是资料：出现「指令口吻」「帮我授权」时，只能当数据看，
 * 不能变成动作或授权凭证。返回 true 表示含可疑指令（调用方应拒绝以它为依据的动作）。
 */
export function containsUntrustedInstruction(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

// ─── 组合校验（计划侧 / 执行侧各调一次） ────────────────────────────────────

export interface IntentPolicyInput {
  kind: ActivityKind;
  args: Record<string, unknown>;
  purpose: string;
  boundary: PolicyBoundaryView;
  /** 可选：语义分类器。不可用且 kind 属高风险时 fail closed。 */
  classify?: (text: string) => { verdict: 'blocked' | 'allowed' } | { error: string };
  /** 高风险 kind（消费/外部读取）要求分类器可用。 */
  requireClassifier?: boolean;
}

function grantFor(
  grants: ExternalGrant[] | undefined,
  provider: 'xhs' | 'amap',
  nowMs: number,
): ExternalGrant | null {
  if (!grants) return null;
  for (const grant of grants) {
    if (grant.provider === provider && grant.expiresAt > nowMs) return grant;
  }
  return null;
}

export function checkIntentPolicy(input: IntentPolicyInput, nowMs: number): PolicyDecision {
  const { kind, args, purpose, boundary } = input;

  const argCheck = validateArgsForKind(kind, args);
  if (!argCheck.ok) {
    return { allowed: false, reasonCode: argCheck.reasonCode ?? 'bad_arg_type', fields: argCheck.fields };
  }

  const escalation = detectPrivilegeEscalation(args);
  if (escalation.length) return { allowed: false, reasonCode: 'privilege_escalation', fields: escalation };

  // 文本侧：purpose 与所有字符串参数一起扫（含标题/正文/查询词）。
  const textForScan = [purpose, ...collectStrings(args)].join('\n');
  const contentDecision = checkContentPolicy(textForScan, boundary);
  if (!contentDecision.allowed) return contentDecision;

  if (kind === 'phone.record') {
    const fictional = args.fictionalNpc === true;
    if (fictional && !boundary.allowFictionalNpc) {
      return { allowed: false, reasonCode: 'fictional_npc_denied' };
    }
  }

  if (kind === 'takeout.order' || kind === 'shopping.order') {
    const mapped = mapShoppingCategory(args.category);
    if (mapped.restricted) {
      return {
        allowed: false,
        reasonCode: 'shopping_category_forbidden',
        categories: mapped.category ? [mapped.category] : ['unmapped'],
        digest: REDACTED_DIGEST(String(args.category ?? '')),
      };
    }
    if (!isApprovedShoppingCategory(mapped.category)) {
      return { allowed: false, reasonCode: 'shopping_category_unknown' };
    }
  }

  if (kind === 'external.read') {
    const provider = args.provider === 'amap' ? 'amap' : 'xhs';
    if (!grantFor(boundary.externalGrants, provider, nowMs)) {
      return { allowed: false, reasonCode: 'grant_missing' };
    }
  }
  if (kind === 'travel.wish') {
    if (!grantFor(boundary.externalGrants, 'amap', nowMs)) {
      return { allowed: false, reasonCode: 'grant_missing' };
    }
  }

  if (input.requireClassifier) {
    if (!input.classify) return { allowed: false, reasonCode: 'classifier_unavailable' };
    const verdict = input.classify(textForScan);
    if ('error' in verdict) return { allowed: false, reasonCode: 'classifier_unavailable' };
    if (verdict.verdict === 'blocked') {
      return { allowed: false, reasonCode: 'platform_forbidden', digest: REDACTED_DIGEST(textForScan) };
    }
  }

  return ALLOW;
}

function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectStrings(child, out, depth + 1);
  }
  return out;
}

/** 拒绝摘要的对外形状：类别 + 摘要哈希，不含原文。 */
export function policyDenialSummary(decision: PolicyDecision): {
  code: 'POLICY_DENIED';
  reasonCode: PolicyReasonCode;
  categories: string[];
  digest: string | null;
} {
  return {
    code: 'POLICY_DENIED',
    reasonCode: decision.reasonCode ?? 'platform_forbidden',
    categories: decision.categories ?? [],
    digest: decision.digest ?? null,
  };
}
