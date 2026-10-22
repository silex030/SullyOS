import React, { useEffect, useMemo, useState } from 'react';
import { MoonStars, Plus, WarningCircle, Wrench, X } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import { AUTONOMY_DAILY_TOKEN_BUDGET, mergeAutonomySettings } from '../../utils/airp/autonomySettings';
import { AUTONOMY_GUARDRAIL_DEFAULTS, type AirpAutonomyGuardrails } from '../../utils/airp/autonomyGuardrails';
import {
  clearCharGuardrails,
  getGlobalGuardrailsSnapshot,
  hoursToMinutes,
  minutesToHours,
  readCharGuardrailsUi,
  subscribeGlobalGuardrails,
  withCharGuardrails,
  type GlobalGuardrailsSnapshot,
} from '../../utils/airp/autonomyGuardrailsClient';
import {
  AutonomyGuardrailsFields,
  GuardrailPauseNote,
  type CharGuardrailFormKey,
  type CharGuardrailFormValue,
} from './AutonomyGuardrailsFields';
import type {
  AirpAutonomyConfig,
  AirpAutonomyOverrides,
  AirpAutonomyTemplateId,
  AirpSettings,
  RetellStyle,
} from '../../utils/airp/settings';
import { DB, openDB } from '../../utils/db';
import type { AutonomyWorkflowPlanRecord } from '../../types';
import { getEnabledMcpServers } from '../../utils/mcpClient';

/**
 * 自主背景生活（AIRP autonomy）的角色面板。
 *
 * 数据契约：只写 char.airp 这一块，落库走 apps/Character.tsx 的既有自动保存链路
 * （formData 一变 → updateCharacter → DB.saveCharacter + markAmsgStateDirty 重传 fire_pack），
 * 这里不新增任何同步代码。写回用 buildAirpSettings() 保留面板不管的字段（导演模型 /
 * 能力白名单 / 权限档位）——注意不能用 mergeAirpSettings() 回写，它不带 autonomy。
 *
 * 面板只存「模板 id + 与模板的 diff（overrides）」，终值一律由 mergeAutonomySettings()
 * 归并（override → 模板 → 常量兜底），所以这里显示的是终值、写的是 diff。
 *
 * 风格：外壳用角色编辑页的卡片语言（bg-white rounded-3xl + shadow-sm + border-slate-100），
 * 控件形态抄 apps/Settings.tsx 的开关 / 数字输入（:345-377）与本页既有的滑杆
 * （apps/Character.tsx 语速一排：w-full accent-primary）。不引入新视觉语言、不用动画库。
 */

// ── 纯逻辑（无 DOM，单测覆盖 utils/airp/autonomyPanelLogic.test.ts）──────────

/** 节奏滑杆的合理区间（小时）。 */
export const CADENCE_MIN_HOURS = 1;
export const CADENCE_MAX_HOURS = 12;

/** 「一键清除静默段」用的兜底一对，仅在用户只改了一头时补齐。 */
const QUIET_FALLBACK = { start: '23:00', end: '06:00' };

export const AUTONOMY_TEMPLATE_LABELS: Record<AirpAutonomyTemplateId, string> = {
  night_player: '深夜玩家',
  morning_brief: '情报早报',
  surf_share: '冲浪分享',
  custom: '自定义',
};

/** 模板卡片的展示顺序与一句话说明（预填数值在 utils/airp/autonomySettings.ts）。 */
export const AUTONOMY_TEMPLATE_CARDS: readonly { id: AirpAutonomyTemplateId; name: string; desc: string }[] = [
  { id: 'night_player', name: '深夜玩家', desc: '深夜活跃，打得凶、说得糙，爱跟你分享战况' },
  { id: 'morning_brief', name: '情报早报', desc: '夜里安静，清晨带回来一两条正事' },
  { id: 'surf_share', name: '冲浪分享', desc: '不打扰、不推送，随手存点好玩的' },
  { id: 'custom', name: '自定义', desc: '全部手调，保留当前设置' },
];

/** 转述语气 7 格 + 自定义（映射集中在执行层，这里只出 id）。 */
export const RETELL_STYLE_OPTIONS: readonly { id: RetellStyle; label: string }[] = [
  { id: 'plain', label: '平铺直叙' },
  { id: 'battle', label: '战况播报' },
  { id: 'brief', label: '简报' },
  { id: 'casual', label: '随口一说' },
  { id: 'coquettish', label: '撒娇' },
  { id: 'diary', label: '日记体' },
  { id: 'teaser', label: '只吊胃口' },
  { id: 'custom', label: '自定义' },
];

const TEMPLATE_IDS: readonly AirpAutonomyTemplateId[] = ['night_player', 'morning_brief', 'surf_share', 'custom'];

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 持久化里的脏 templateId 一律回落 custom（与 mergeAutonomySettings 同口径）。 */
export const normalizeTemplateId = (value: unknown): AirpAutonomyTemplateId =>
  typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value)
    ? (value as AirpAutonomyTemplateId)
    : 'custom';

/**
 * 点模板卡片：换模板 = 干净的 diff（overrides 清空，用户之后再微调）。
 * custom 例外——保留现有 overrides（回不去模板预填，所以不能清）。
 */
export const applyAutonomyTemplate = (
  templateId: AirpAutonomyTemplateId,
  current?: { overrides?: AirpAutonomyOverrides } | null,
): { templateId: AirpAutonomyTemplateId; overrides: AirpAutonomyOverrides } => ({
  templateId,
  overrides: templateId === 'custom' ? { ...(current?.overrides ?? {}) } : {},
});

/** 有没有手工覆盖：任何一项（含显式空数组）都算「自定义」。 */
export const isAutonomyCustomized = (overrides?: AirpAutonomyOverrides | null): boolean =>
  isPlainRecord(overrides) && Object.keys(overrides).length > 0;

/** 标题：模板预设：XX / 基于 XX 模板的自定义 / 自定义。 */
export const autonomyTitle = (
  templateId: AirpAutonomyTemplateId,
  overrides?: AirpAutonomyOverrides | null,
): string => {
  if (templateId === 'custom') return AUTONOMY_TEMPLATE_LABELS.custom;
  const label = AUTONOMY_TEMPLATE_LABELS[templateId];
  return isAutonomyCustomized(overrides) ? `基于${label}模板的自定义` : `模板预设：${label}`;
};

/** 夹到 [min, max] 并取整；NaN 落回 min。 */
export const clampInt = (value: number, min: number, max: number): number => {
  const base = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, base));
};

export type NumberFieldParse =
  | { kind: 'clear' }
  | { kind: 'keep' }
  | { kind: 'set'; value: number };

/**
 * 数字输入框的提交语义：空 → 清掉覆盖（回落模板 / 常量默认）；
 * 非数字 → 不提交（保留原值）；数字 → 夹到区间（0 会被抬到下限，永远不提交 0）。
 */
export const parseNumberField = (raw: string, min: number, max: number): NumberFieldParse => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'clear' };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { kind: 'keep' };
  return { kind: 'set', value: clampInt(parsed, min, max) };
};

export const clampCadenceHours = (value: number): number =>
  clampInt(value, CADENCE_MIN_HOURS, CADENCE_MAX_HOURS);

/** 拖滑杆的那一头夹到 1–12h，并以另一头为界 → 永不出现 min > max。 */
export const clampCadencePart = (
  part: 'minHours' | 'maxHours',
  value: number,
  otherValue: number,
): number => {
  const other = clampCadenceHours(otherValue);
  const self = clampCadenceHours(value);
  return part === 'minHours' ? Math.min(self, other) : Math.max(self, other);
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 静默段形状：只认 00:00–23:59 的 HH:mm（与 mergeAutonomySettings 同一张正则）。 */
export const isValidHhmm = (value: string): boolean => HHMM.test(value);

/** 加 chip：去空白、去重、空串忽略；没变化时原样返回同一个数组（调用方可据此跳过写盘）。 */
export const addChip = (list: string[], raw: string): string[] => {
  const value = raw.trim();
  if (value.length === 0 || list.includes(value)) return list;
  return [...list, value];
};

export const removeChip = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((item) => item !== value) : list;

/**
 * 面板写回 char.airp 的完整形态：默认值打底 → 现有字段 → patch。
 * 保留面板不管的字段（enabled / autonomyLevel / directorModel / capabilities），
 * 不改写别处写进去的 airp 配置。
 */
export const buildAirpSettings = (current: AirpSettings | undefined, patch: Partial<AirpSettings>): AirpSettings => ({
  enabled: false,
  autonomyLevel: 2,
  capabilities: [],
  mcpAllow: [],
  writable: false,
  ...(current ?? {}),
  ...patch,
  version: 1,
});

/** 门禁：自主经历要靠主动消息 2.0 生成与送达，角色的 2.0 总开关没开就不让开自主。 */
export const autonomyGateOpen = (
  char: { activeMsg2Config?: { enabled: boolean } } | null | undefined,
): boolean => char?.activeMsg2Config?.enabled === true;

// ── 只读状态（读 autonomous_heartbeats）─────────────────────────────────

const HEARTBEAT_STORE = 'autonomous_heartbeats';

interface AutonomyHeartbeatRow {
  charId: string;
  ts: number;
  wokeAt?: number;
  did?: string;
  toolsUsed?: string[];
  usage?: { prompt?: number; completion?: number; total?: number };
  pushed?: number | boolean;
  outboxed?: number;
}

const DID_LABELS: Record<string, string> = {
  surf: '网上冲浪',
  game: '打游戏',
  forum: '逛论坛',
  rest: '歇着',
  mixed: '混着来',
};

/**
 * 最近一条心跳。store 由 Task 19 才建，现在必然读不到——所以不 import 任何
 * store 模块，只用 openDB() + objectStoreNames.contains 守卫 + try/catch 兜底，
 * 读不到就回 null（面板显示「暂无记录」）。
 */
const loadLatestHeartbeat = async (charId: string): Promise<AutonomyHeartbeatRow | null> => {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(HEARTBEAT_STORE)) return null;
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(HEARTBEAT_STORE, 'readonly').objectStore(HEARTBEAT_STORE).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error);
    });
    const mine = rows
      .filter((row): row is AutonomyHeartbeatRow => isPlainRecord(row) && row.charId === charId)
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    return mine[0] ?? null;
  } catch {
    return null;
  }
};

// ── 生活工作流记录（airp_workflow_plans，v79）────────────────────────────
// 只读：角色想过/做过什么。结果正文是 TA 自己的虚拟经历，面板上明确标出来，
// 不往「现实里发生过」的方向说；失败/未知不展示成完成。

const WORKFLOW_KIND_LABELS: Record<string, string> = {
  diary: '写点东西',
  plan: '调自己的计划',
  interest_note: '记点兴趣',
};

const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  proposed: '想做',
  scheduled: '等着做',
  running: '在做',
  completed: '做完了',
  cancelled: '不做了',
  failed: '没做成',
  unknown: '不确定做完没有',
};

const WORKFLOW_VISIBLE_MAX = 4;

const loadWorkflowPlans = async (charId: string): Promise<AutonomyWorkflowPlanRecord[]> => {
  try {
    return await DB.getWorkflowPlansByChar(charId, WORKFLOW_VISIBLE_MAX);
  } catch {
    return [];
  }
};

const formatStamp = (ts: unknown): string => {
  const time = Number(ts);
  if (!Number.isFinite(time)) return '—';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// ── 小控件（形态抄 apps/Settings.tsx，颜色沿用本页 violet）────────────────

const Switch: React.FC<{ checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }> = ({
  checked,
  disabled,
  onChange,
}) => (
  <label className={`relative inline-flex items-center shrink-0 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
    <input
      type="checkbox"
      className="sr-only peer"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
  </label>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex items-center justify-between gap-3">
    <div className="min-w-0">
      <div className="text-xs font-bold text-slate-700">{label}</div>
      {hint && <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{hint}</p>}
    </div>
    <div className="shrink-0 flex items-center gap-2">{children}</div>
  </div>
);

const Group: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">{label}</p>
    <div className="bg-slate-50/70 rounded-2xl px-3 py-2.5 space-y-2.5">{children}</div>
    {hint && <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">{hint}</p>}
  </div>
);

/**
 * 数字输入：改字只动本地 draft，失焦 / 回车才提交（逐字提交会一边夹紧一边把用户的手指顶回去）。
 * allowEmpty 只给「留空 = 用默认」的字段（每日预算）用；其余字段清空即还原成当前生效值。
 */
const NumberField: React.FC<{
  value: number | undefined;
  placeholder?: string;
  min: number;
  max: number;
  allowEmpty?: boolean;
  onCommit: (next: number | undefined) => void;
}> = ({ value, placeholder, min, max, allowEmpty, onCommit }) => {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));

  useEffect(() => {
    setDraft(value === undefined ? '' : String(value));
  }, [value]);

  const commit = () => {
    const parsed = parseNumberField(draft, min, max);
    if (parsed.kind === 'clear') {
      if (allowEmpty) {
        setDraft('');
        if (value !== undefined) onCommit(undefined);
      } else {
        setDraft(value === undefined ? '' : String(value));
      }
      return;
    }
    if (parsed.kind === 'keep') {
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    setDraft(String(parsed.value));
    if (parsed.value !== value) onCommit(parsed.value);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      className="w-16 shrink-0 bg-white border border-violet-200 rounded-xl px-2 py-1.5 text-sm text-center font-bold text-violet-700 outline-none placeholder:text-slate-300 placeholder:font-normal focus:ring-1 focus:ring-violet-300"
    />
  );
};

/** 兴趣词 / 避开词：单行输入回车入库，chip 点 × 删。 */
const ChipEditor: React.FC<{
  items: string[];
  placeholder: string;
  accent: 'violet' | 'slate';
  onAdd: (raw: string) => void;
  onRemove: (value: string) => void;
}> = ({ items, placeholder, accent, onAdd, onRemove }) => {
  const [draft, setDraft] = useState('');
  const commit = () => {
    if (draft.trim().length === 0) return;
    onAdd(draft);
    setDraft('');
  };
  const chipClass =
    accent === 'violet'
      ? 'border-violet-200 bg-violet-50 text-violet-600'
      : 'border-slate-200 bg-white text-slate-500';
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="flex-1 min-w-0 bg-white rounded-xl px-3 py-1.5 text-xs border border-slate-200 outline-none focus:ring-1 focus:ring-violet-300"
        />
        <button
          type="button"
          onClick={commit}
          className="shrink-0 px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-white border border-violet-200 text-violet-600 active:scale-95 transition-transform"
        >
          <Plus size={11} weight="bold" className="inline -mt-0.5" /> 添加
        </button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span
              key={item}
              className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-bold ${chipClass}`}
            >
              {item}
              <button type="button" onClick={() => onRemove(item)} className="active:scale-90 transition-transform" title="删除">
                <X size={9} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

// ── 主面板 ────────────────────────────────────────────────────────────────

interface AutonomyPanelProps {
  char: CharacterProfile;
  /** 写回整块 char.airp（宿主直接 handleChange('airp', next)）。 */
  onChange: (next: AirpSettings) => void;
}

const AutonomyPanel: React.FC<AutonomyPanelProps> = ({ char, onChange }) => {
  const airp = char.airp;
  const rawAutonomy = airp?.autonomy;

  const autonomy = useMemo<AirpAutonomyConfig>(() => ({
    enabled: rawAutonomy?.enabled === true,
    templateId: normalizeTemplateId(rawAutonomy?.templateId),
    overrides: isPlainRecord(rawAutonomy?.overrides) ? (rawAutonomy!.overrides as AirpAutonomyOverrides) : {},
    version: 1,
  }), [rawAutonomy]);

  const overrides = autonomy.overrides;
  // 终值：显示用（覆盖里没写的字段显示模板 / 常量兜底值）。
  const merged = useMemo(() => mergeAutonomySettings(char), [char]);
  const gateOpen = autonomyGateOpen(char);
  const title = autonomyTitle(autonomy.templateId, overrides);

  const emit = (patch: Partial<AirpSettings>) => onChange(buildAirpSettings(airp, patch));
  const emitAutonomy = (patch: Partial<AirpAutonomyConfig>) =>
    emit({ autonomy: { ...autonomy, ...patch } });
  const emitOverrides = (patch: Partial<AirpAutonomyOverrides>) =>
    emitAutonomy({ overrides: { ...overrides, ...patch } });

  // 节奏
  const cadence = overrides.cadence ?? merged.cadence;
  const setCadence = (part: 'minHours' | 'maxHours', value: number) => {
    const other = part === 'minHours' ? cadence.maxHours : cadence.minHours;
    const next = clampCadencePart(part, value, other);
    emitOverrides({ cadence: { minHours: part === 'minHours' ? next : cadence.minHours, maxHours: part === 'maxHours' ? next : cadence.maxHours } });
  };

  // 静默段（draft 态：只填了一头或形状不对都不提交）
  const quiet = overrides.quietHours ?? merged.quietHours;
  const [quietDraft, setQuietDraft] = useState({ start: quiet?.start ?? '', end: quiet?.end ?? '' });
  useEffect(() => {
    setQuietDraft({ start: quiet?.start ?? '', end: quiet?.end ?? '' });
  }, [quiet?.start, quiet?.end]);
  const setQuiet = (part: 'start' | 'end', value: string) => {
    const next = { ...quietDraft, [part]: value };
    setQuietDraft(next);
    if (isValidHhmm(next.start) && isValidHhmm(next.end)) emitOverrides({ quietHours: next });
  };
  const clearQuiet = () => {
    setQuietDraft({ start: '', end: '' });
    // null 是显式哨兵：连模板预填的静默段一起清掉（undefined 会被 merge 当成「跟随模板」）。
    emitOverrides({ quietHours: null });
  };

  // 兴趣词 / 避开词
  const interests = overrides.interests ?? merged.interests;
  const avoidTopics = overrides.avoidTopics ?? merged.avoidTopics;
  const addTo = (key: 'interests' | 'avoidTopics', raw: string) => {
    const current = key === 'interests' ? interests : avoidTopics;
    const next = addChip(current, raw);
    if (next !== current) emitOverrides({ [key]: next });
  };
  const removeFrom = (key: 'interests' | 'avoidTopics', value: string) => {
    const current = key === 'interests' ? interests : avoidTopics;
    const next = removeChip(current, value);
    if (next !== current) emitOverrides({ [key]: next });
  };

  // 转述
  const retell = merged.retell;
  const retellOverride = overrides.retell;
  const retellStyle = retellOverride?.style ?? retell.style;
  const retellItems = retellOverride?.maxItems ?? retell.maxItems;
  const retellChars = retellOverride?.maxChars ?? retell.maxChars;
  const retellOpener = retellOverride?.opener ?? retell.opener;
  const retellHint = retellOverride?.customHint ?? retell.customHint ?? '';
  type RetellOverride = NonNullable<AirpAutonomyOverrides['retell']>;
  // 写进去的是「终值打底 + 这一项」：retell 的子字段在类型上是必填，所以这里不写空值，
  // 空输入由 NumberField 还原成当前生效值（真值是模板 / 常量兜底，见 mergeRetell）。
  const setRetell = (patch: Partial<RetellOverride>) => {
    const next: RetellOverride = {
      style: patch.style ?? retellStyle,
      maxItems: patch.maxItems ?? retellItems,
      maxChars: patch.maxChars ?? retellChars,
      opener: patch.opener ?? retellOpener,
      ...('customHint' in patch ? (patch.customHint ? { customHint: patch.customHint } : {}) : retellHint ? { customHint: retellHint } : {}),
    };
    // 换回内置语气时丢掉自定义提示，免得执行层又把它拼进提示词。
    if (next.style !== 'custom') delete next.customHint;
    emitOverrides({ retell: next });
  };

  // 推送
  const push = overrides.push ?? merged.push;
  const setPush = (patch: Partial<NonNullable<AirpAutonomyOverrides['push']>>) =>
    emitOverrides({
      push: { mode: push.mode, maxPerDay: push.maxPerDay, cooldownMinutes: push.cooldownMinutes, ...patch },
    });

  // 生活护栏：每角色值写 char.airp.autonomy.guardrails（契约见 utils/airp/autonomyGuardrails.ts），
  // 全局共享行是权威后台值的本地草稿（可能待同步），这里只读来显示合计上限 / 暂停状态。
  //
  // **必须用权威快照**，不能用 `readGlobalGuardrails()` 那个展示兜底：它读不到云端真实值时
  // 会返回契约默认（6 次/天、未暂停），面板照着显示就等于告诉用户「暂停没关」。
  // 快照的 `value === null` 只表示「后台未确认」，界面就该说「未确认」而不是编一个数字。
  const [globalSnapshot, setGlobalSnapshot] = useState<GlobalGuardrailsSnapshot>(() => getGlobalGuardrailsSnapshot());
  useEffect(() => {
    const sync = () => setGlobalSnapshot(getGlobalGuardrailsSnapshot());
    sync();
    // 订阅回调给的是展示值（可能为空/默认），这里忽略它，统一回快照读——只有快照分得清
    // 「云端确认是 0/暂停」和「根本不知道云端是什么」。
    return subscribeGlobalGuardrails(sync);
  }, []);
  const globalGuardrails: AirpAutonomyGuardrails | null = globalSnapshot.value;
  const charGuardrails = readCharGuardrailsUi(char);
  const guardrailsValue: CharGuardrailFormValue = {
    maxRunsPerDay: charGuardrails.perCharPerDay,
    sameKindMinGapHours: charGuardrails.sameKindMinGapHours,
    reserveTokensPerRun: charGuardrails.reserveTokensPerRun,
  };
  const commitGuardrail = (key: CharGuardrailFormKey, next: number) => {
    const patch = key === 'maxRunsPerDay'
      ? { perCharPerDay: next }
      : key === 'sameKindMinGapHours'
        ? { sameKindMinGapMinutes: hoursToMinutes(next) }
        : { reserveTokensPerRun: next };
    onChange(withCharGuardrails(airp, patch));
  };
  // 契约不接受 0 次/天：面板的 0 落成「这个角色暂停」（autonomy.enabled = false）。
  const pausedByGuardrails = charGuardrails.hasOwn && charGuardrails.perCharPerDay === 0;

  // 工具：只列「已启用、已取到工具、对该角色可见」的 server
  const enabledServers = useMemo(() => getEnabledMcpServers(char.id), [char.id]);
  const mcpAllow = airp?.mcpAllow ?? [];
  const writable = airp?.writable === true;
  const toggleServer = (id: string) => {
    const next = mcpAllow.includes(id) ? mcpAllow.filter((item) => item !== id) : [...mcpAllow, id];
    emit({ mcpAllow: next });
  };

  // 状态读回（只读）
  const [heartbeat, setHeartbeat] = useState<AutonomyHeartbeatRow | null>(null);
  const [heartbeatChecked, setHeartbeatChecked] = useState(false);
  useEffect(() => {
    let alive = true;
    setHeartbeatChecked(false);
    void loadLatestHeartbeat(char.id).then((row) => {
      if (!alive) return;
      setHeartbeat(row);
      setHeartbeatChecked(true);
    });
    return () => {
      alive = false;
    };
  }, [char.id]);

  // 工作流记录（只读）：谈了来源与结果，但只是 TA 自己的私事
  const [workflowPlans, setWorkflowPlans] = useState<AutonomyWorkflowPlanRecord[]>([]);
  const [workflowChecked, setWorkflowChecked] = useState(false);
  useEffect(() => {
    let alive = true;
    setWorkflowChecked(false);
    void loadWorkflowPlans(char.id).then((rows) => {
      if (!alive) return;
      setWorkflowPlans(rows);
      setWorkflowChecked(true);
    });
    return () => {
      alive = false;
    };
  }, [char.id]);

  return (
    <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
      {/* 头部：标题 + 当前模板状态 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MoonStars size={16} weight="bold" className="text-violet-500 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-700">自主背景生活</h3>
            <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
              你不说话的时候，TA 也会自己上网逛逛、玩两把、记点东西，回头自然聊起。
            </p>
          </div>
        </div>
        <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-violet-200 bg-violet-50 text-violet-600 font-bold">
          {title}
        </span>
      </div>

      {/* AIRP 总闸：导演与自主背景生活都归它管 */}
      <div className="flex items-center justify-between gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-700">开启 AIRP 运行时</p>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
            总闸：后台导演和下面的自主背景生活都归它管，关掉后这个角色整体停用。
          </p>
        </div>
        <Switch checked={airp?.enabled === true} onChange={(next) => emit({ enabled: next })} />
      </div>

      {!gateOpen && (
        <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-2xl px-3 py-2">
          <WarningCircle size={14} weight="bold" className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-amber-700 leading-relaxed">
            自主经历要靠主动消息送回手机：先去聊天页给 TA 打开「主动消息 2.0」，这里才生效。
          </p>
        </div>
      )}

      {/* 总开关 */}
      <div className="flex items-center justify-between gap-3 bg-slate-50/70 rounded-2xl px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-700">开启自主背景生活</p>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
            {gateOpen ? '关掉后不再生成新的自主经历，已有的保留。' : '需要先打开「主动消息 2.0」。'}
          </p>
        </div>
        <Switch checked={autonomy.enabled} disabled={!gateOpen} onChange={(next) => emitAutonomy({ enabled: next })} />
      </div>

      {/* 模板 */}
      <div>
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">风格模板</p>
        <div className="grid grid-cols-2 gap-2">
          {AUTONOMY_TEMPLATE_CARDS.map((card) => {
            const active = autonomy.templateId === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => emitAutonomy(applyAutonomyTemplate(card.id, autonomy))}
                className={`text-left rounded-2xl border px-3 py-2.5 transition-all ${active ? 'border-violet-400 bg-violet-50' : 'border-slate-200 bg-white active:scale-[0.98]'}`}
              >
                <p className={`text-[11px] font-bold ${active ? 'text-violet-700' : 'text-slate-600'}`}>{card.name}</p>
                <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{card.desc}</p>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
          换模板会清掉下面手工微调过的项；选「自定义」则保留当前设置。
        </p>
      </div>

      {/* 五组自定义 */}
      <div className="space-y-3.5 border-t border-slate-100 pt-3">
        <Group label="节奏" hint={`按角色自己的时区算：距你最后一条消息 ${cadence.minHours}–${cadence.maxHours} 小时后才可能醒一次。`}>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-500">最短间隔</span>
              <span className="text-[11px] font-mono text-slate-500">{cadence.minHours}h</span>
            </div>
            <input
              type="range"
              min={CADENCE_MIN_HOURS}
              max={CADENCE_MAX_HOURS}
              step={1}
              value={cadence.minHours}
              onChange={(e) => setCadence('minHours', parseInt(e.target.value, 10))}
              className="w-full accent-primary"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-500">最长间隔</span>
              <span className="text-[11px] font-mono text-slate-500">{cadence.maxHours}h</span>
            </div>
            <input
              type="range"
              min={CADENCE_MIN_HOURS}
              max={CADENCE_MAX_HOURS}
              step={1}
              value={cadence.maxHours}
              onChange={(e) => setCadence('maxHours', parseInt(e.target.value, 10))}
              className="w-full accent-primary"
            />
          </div>
        </Group>

        <Group label="静默段" hint="落在这一段里不主动打扰（按角色时区）。两头都填好才生效；清除后不再设静默段。">
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={quietDraft.start}
              onChange={(e) => setQuiet('start', e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-mono w-24 outline-none focus:ring-1 focus:ring-violet-300"
            />
            <span className="text-[11px] text-slate-400">到</span>
            <input
              type="time"
              value={quietDraft.end}
              onChange={(e) => setQuiet('end', e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-mono w-24 outline-none focus:ring-1 focus:ring-violet-300"
            />
            {(overrides.quietHours || quietDraft.start || quietDraft.end) && (
              <button
                type="button"
                onClick={clearQuiet}
                className="ml-auto shrink-0 text-[10px] px-2 py-1 rounded-xl bg-white border border-slate-200 text-slate-500 font-bold active:scale-95 transition-transform"
              >
                清除
              </button>
            )}
          </div>
        </Group>

        <Group label="兴趣词 / 避开" hint={`没话头时的兜底选题来源：兴趣词${interests.length} 个、避开 ${avoidTopics.length} 个（回车添加）。`}>
          <ChipEditor
            items={interests}
            placeholder="兴趣词，如：独立游戏"
            accent="violet"
            onAdd={(raw) => addTo('interests', raw)}
            onRemove={(value) => removeFrom('interests', value)}
          />
          <ChipEditor
            items={avoidTopics}
            placeholder="避开的话题，如：工作"
            accent="slate"
            onAdd={(raw) => addTo('avoidTopics', raw)}
            onRemove={(value) => removeFrom('avoidTopics', value)}
          />
        </Group>

        <Group label="转述" hint="这条经历回到聊天里时怎么说：对话里凑到这茬才自然带一句，不报流水账。">
          <div className="flex flex-wrap gap-1.5">
            {RETELL_STYLE_OPTIONS.map((option) => {
              const active = retellStyle === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setRetell({ style: option.id })}
                  className={`px-2.5 py-1.5 rounded-xl text-[11px] font-bold transition-all ${active ? 'bg-violet-500 text-white shadow-sm' : 'bg-slate-100 text-slate-500 active:scale-95'}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {retellStyle === 'custom' && (
            <input
              value={retellHint}
              onChange={(e) => setRetell({ customHint: e.target.value })}
              placeholder="自定义语气，如：像转发段子一样，只留最离谱的一句"
              className="w-full bg-white rounded-xl px-3 py-1.5 text-xs border border-slate-200 outline-none focus:ring-1 focus:ring-violet-300"
            />
          )}
          <Row label="每次最多几条" hint="转述块里最多带几条经历">
            <NumberField value={retellItems} min={1} max={20} onCommit={(next) => { if (next !== undefined) setRetell({ maxItems: next }); }} />
          </Row>
          <Row label="每次最多多少字">
            <NumberField value={retellChars} min={1} max={5000} onCommit={(next) => { if (next !== undefined) setRetell({ maxChars: next }); }} />
          </Row>
          <Row label="允许 TA 主动先提起" hint="关着就等你聊到相关话头">
            <Switch checked={retellOpener} onChange={(next) => setRetell({ opener: next })} />
          </Row>
        </Group>

        <Group label="推送">
          <Row label="推送档位" hint="off = 完全不推，big = 只推值得打扰你的">
            <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
              {([['off', '不推'], ['big', '只推大的']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPush({ mode: value })}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${push.mode === value ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-500 active:bg-white/60'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="每天最多推几条">
            <NumberField value={push.maxPerDay} min={1} max={10} onCommit={(next) => { if (next !== undefined) setPush({ maxPerDay: next }); }} />
          </Row>
          <Row label="两次推送最少间隔" hint="分钟；0 = 不冷却">
            <NumberField
              value={push.cooldownMinutes}
              min={0}
              max={1440}
              onCommit={(next) => { if (next !== undefined) setPush({ cooldownMinutes: next }); }}
            />
          </Row>
        </Group>

        <Group
          label="生活护栏"
          hint={`默认每角色 ${AUTONOMY_GUARDRAIL_DEFAULTS.perCharPerDay} 次、同类间隔 ${minutesToHours(AUTONOMY_GUARDRAIL_DEFAULTS.sameKindMinGapMinutes)}h、每次预留 ${AUTONOMY_GUARDRAIL_DEFAULTS.reserveTokensPerRun} token；全部角色合计${globalGuardrails ? `每天最多 ${globalGuardrails.globalPerDay} 次` : '（后台未确认）'}。全局总开关与合计在 设置 → 自主生活护栏。`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-bold text-slate-700">这个角色的上限</div>
              <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                {charGuardrails.hasOwn ? '已单独设置，改一项存一项。' : '跟随契约默认；改一项就为这个角色单独存一份。'}
              </p>
            </div>
            {charGuardrails.hasOwn && (
              <button
                type="button"
                onClick={() => onChange(clearCharGuardrails(airp))}
                className="shrink-0 text-[10px] px-2 py-1 rounded-xl bg-white border border-slate-200 text-slate-500 font-bold active:scale-95 transition-transform"
              >
                恢复全局默认
              </button>
            )}
          </div>
          <AutonomyGuardrailsFields value={guardrailsValue} onCommit={commitGuardrail} />
          {pausedByGuardrails && (
            <GuardrailPauseNote>
              次数或预算是 0：这个角色的自主生活已暂停（上面「开启自主背景生活」也一起关掉了）。改回大于 0 后，再把那个开关打开。
            </GuardrailPauseNote>
          )}
          {globalGuardrails === null ? (
            <GuardrailPauseNote>
              后台的全局护栏现在读不出来（未确认）：不知道是否暂停，这里调多大都不代表能生成，先去 设置 → 自主生活护栏 重新同步。
            </GuardrailPauseNote>
          ) : globalGuardrails.paused && (
            <GuardrailPauseNote>
              全局护栏当前是暂停状态（设置 → 自主生活护栏），这里调多大都不会生成。
            </GuardrailPauseNote>
          )}
        </Group>

        <Group label="预算与文风" hint="超出当日 token 预算就当天不再醒。留空 = 用默认值。">
          <Row label="每天 token 预算" hint={`默认 ${AUTONOMY_DAILY_TOKEN_BUDGET.toLocaleString()}`}>
            <NumberField
              value={overrides.dailyTokenBudget}
              min={1}
              max={10000000}
              allowEmpty
              placeholder={String(AUTONOMY_DAILY_TOKEN_BUDGET)}
              onCommit={(next) => emitOverrides({ dailyTokenBudget: next })}
            />
          </Row>
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-slate-700">文风示例</div>
            <textarea
              value={overrides.noteStyleHint ?? ''}
              onChange={(e) => emitOverrides({ noteStyleHint: e.target.value || undefined })}
              rows={2}
              placeholder={merged.noteStyleHint ?? '例：口语、有画面感，像深夜随手记下的一条发现，别端着。'}
              className="w-full bg-white rounded-2xl px-3 py-2 text-xs leading-relaxed border border-slate-200 outline-none focus:ring-1 focus:ring-violet-300 resize-none"
            />
            <p className="text-[10px] text-slate-400 leading-relaxed">留空跟随模板；这里写的会当成语气示例带进提示词。</p>
          </div>
        </Group>

        <Group label="工具" hint="自主回合里能用哪些 MCP 工具。工具调用还没接进自主回合——这一版先保存你的勾选，等接上后按它生效；只列已启用、已取到工具的服务器。">
          {enabledServers.length === 0 ? (
            <div className="text-center py-3 bg-white rounded-2xl border border-dashed border-slate-200 text-[10px] text-slate-400">
              还没有可用的 MCP 服务器（设置 → MCP 里添加并启用）
            </div>
          ) : (
            <div className="space-y-1.5">
              {enabledServers.map((server) => {
                const checked = mcpAllow.includes(server.id);
                return (
                  <button
                    key={server.id}
                    type="button"
                    onClick={() => toggleServer(server.id)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-2xl border text-left transition-all ${checked ? 'border-violet-400 bg-violet-50' : 'border-slate-200 bg-white active:scale-[0.98]'}`}
                  >
                    <span className="min-w-0">
                      <span className="block text-[11px] font-bold text-slate-700 truncate">{server.name || '(未命名)'}</span>
                      <span className="block text-[10px] text-slate-400 truncate">{server.tools?.length ?? 0} 个工具</span>
                    </span>
                    <span className={`shrink-0 text-[10px] font-bold ${checked ? 'text-violet-600' : 'text-slate-300'}`}>
                      {checked ? '已允许' : '未允许'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="border-t border-slate-200/70 pt-2.5 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <Wrench size={13} weight="bold" className="text-violet-500 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-700">自主可写</div>
                  <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                    默认关。开启后 TA 在自主回合里才允许真的改数据（记一笔、发帖、存东西），不只是看。写入能力还没接进自主回合——这一版先保存你的选择。
                  </p>
                </div>
              </div>
              <Switch checked={writable} onChange={(next) => emit({ writable: next })} />
            </div>
            {writable && (
              <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-2xl px-3 py-2">
                <WarningCircle size={14} weight="bold" className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[10px] text-amber-700 leading-relaxed">
                  可写已开启：只勾了工具的服务器才可调用；写入权限档位仍受 AIRP 自主度限制。写入能力将在后续版本接入自主回合。
                </p>
              </div>
            )}
          </div>
        </Group>
      </div>

      {/* 状态（只读） */}
      <div className="border-t border-slate-100 pt-3">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">最近一次自主</p>
        {!heartbeatChecked ? (
          <p className="text-[11px] text-slate-400">读取中…</p>
        ) : heartbeat ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
            <div className="text-slate-400">醒来</div>
            <div className="text-slate-600 font-mono">{formatStamp(heartbeat.wokeAt ?? heartbeat.ts)}</div>
            <div className="text-slate-400">做了什么</div>
            <div className="text-slate-600">{DID_LABELS[String(heartbeat.did)] ?? heartbeat.did ?? '—'}</div>
            <div className="text-slate-400">用了工具</div>
            <div className="text-slate-600 truncate">{heartbeat.toolsUsed?.length ? heartbeat.toolsUsed.join('、') : '没用工具'}</div>
            <div className="text-slate-400">token</div>
            <div className="text-slate-600 font-mono">{Number(heartbeat.usage?.total) || 0}</div>
            <div className="text-slate-400">推送</div>
            <div className="text-slate-600">{heartbeat.pushed ? '推了' : '没推'}</div>
          </div>
        ) : (
          <p className="text-[11px] text-slate-400">暂无记录——开着的角色在云端醒过后会写在这里。</p>
        )}
      </div>

      {/* 生活工作流（只读）：TA 自己想做/做过的小事 */}
      <div className="border-t border-slate-100 pt-3">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">TA 自己的小事</p>
        {!workflowChecked ? (
          <p className="text-[11px] text-slate-400">读取中…</p>
        ) : workflowPlans.length === 0 ? (
          <p className="text-[11px] text-slate-400">还没有——TA 想到什么、或真做完了，才会记在这里。</p>
        ) : (
          <ul className="space-y-2">
            {workflowPlans.map((plan) => (
              <li key={plan.id} className="rounded-2xl bg-slate-50 border border-slate-100 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold text-slate-700 truncate">
                    {plan.title || WORKFLOW_KIND_LABELS[plan.kind] || plan.kind}
                  </span>
                  <span className="text-[10px] text-violet-500 shrink-0">
                    {WORKFLOW_STATUS_LABELS[plan.status] ?? plan.status}
                  </span>
                </div>
                {plan.purpose ? (
                  <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{plan.purpose}</p>
                ) : null}
                {plan.lastError === 'cannot-cancel' ? (
                  <p className="text-[10px] text-amber-600 mt-0.5 leading-relaxed">
                    撤不了：这条已经在做或者已经结束了（这里不会改写成「不做了」）。
                  </p>
                ) : null}
                {plan.resultText ? (
                  <p className="text-[10px] text-slate-600 mt-1 leading-relaxed line-clamp-3 whitespace-pre-wrap">{plan.resultText}</p>
                ) : null}
                <div className="flex items-center gap-2 mt-1 text-[9px] text-slate-400">
                  <span>{formatStamp(plan.createdAt)}</span>
                  <span>·</span>
                  <span>{WORKFLOW_KIND_LABELS[plan.kind] ?? plan.kind}</span>
                  <span>·</span>
                  {/* 认知档必须看得见：这些是 TA 自己的虚拟生活，不是现实观测 */}
                  <span>{plan.basis === 'virtual' ? 'TA 的私事（虚拟）' : 'TA 的推断'}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AutonomyPanel;
