import React, { useMemo, useState } from 'react';
import {
  DEFAULT_ACCOUNT_LIMITS,
  LIMIT_KEYS,
  PLATFORM_FORBIDDEN_CATEGORIES,
  type ActivityKind,
  type BoundaryScope,
  type LimitKey,
} from '../../contracts/autonomyLife';
import type { AutonomyLifeSnapshot } from '../../utils/autonomyLife/store';
import {
  BOUNDARY_QUICK_LINKS,
  FORBIDDEN_CATEGORY_LABELS,
  KIND_APP,
  KIND_LABELS,
  UI_PLATFORM_FORBIDDEN,
  capabilityStatusText,
  describeError,
  formatMinor,
  formatWhen,
  sortCapabilities,
} from '../../utils/autonomyLife/view';
import {
  Badge,
  BoundaryNumberInput,
  Card,
  ChipsEditor,
  ClockInput,
  InlineButton,
  Notice,
  Row,
  SectionTitle,
  StatusDot,
  Toggle,
} from './AutonomyLifeUi';

export interface BoundaryTabProps {
  snapshot: AutonomyLifeSnapshot;
  scope: BoundaryScope;
  charName: string;
  saving: boolean;
  onSave: (changes: Record<string, unknown>, scope: BoundaryScope) => void;
  onPause: (paused: boolean, scope: BoundaryScope) => void;
  onOpenApp: (appId: string, context?: Record<string, unknown>) => void;
  onDismissNotice: () => void;
  onRetry: () => void;
  now: number;
}

const LIMIT_LABELS: Record<LimitKey, { label: string; hint: string }> = {
  accountModelCallsPerDay: { label: '账号每天模型调用', hint: '所有角色合计；一次请求算一次调用' },
  charModelCallsPerDay: { label: '每个角色每天调用', hint: '角色层留空 = 跟随账号' },
  accountTokensPerDay: { label: '账号每天 token', hint: '按真实用量结算，用量不明时保留上界' },
  charTokensPerDay: { label: '每个角色每天 token', hint: '角色层留空 = 跟随账号' },
  notificationsPerDay: { label: '每天通知条数', hint: '通知关闭只影响提醒，不停止私人活动' },
  perKindActionsPerDay: { label: '每类动作每天次数', hint: '日记/外卖等各自计数' },
  virtualSpendPerDayMinor: { label: '每天模拟消费（分）', hint: 'OS 内模拟余额，不是真实支付' },
  virtualOrderMaxMinor: { label: '单笔模拟订单上限（分）', hint: '含配送费' },
};

const isLimitKey = (key: string): key is LimitKey => (LIMIT_KEYS as readonly string[]).includes(key);

/**
 * 边界：用户唯一能改的地方 —— 总暂停、参与、允许窗口、禁止方向、上限、免打扰、外部授权。
 * 这里**没有**任何频率/周期/活跃度/同类冷却输入；那些属于人设节奏与部署内安全常量。
 */
const BoundaryTab: React.FC<BoundaryTabProps> = ({
  snapshot,
  scope,
  charName,
  saving,
  onSave,
  onPause,
  onOpenApp,
  onDismissNotice,
  onRetry,
  now,
}) => {
  const { boundary, boundaryStatus, boundaryError, state, capabilities, writeError, notice } = snapshot;
  const [draftKinds, setDraftKinds] = useState<ActivityKind[] | null>(null);

  const effective = boundary?.effective;
  const account = boundary?.account;
  const characterOverrides = boundary?.characterOverrides;
  const maximums = boundary?.maximums ?? DEFAULT_ACCOUNT_LIMITS;
  const defaults = boundary?.defaults ?? DEFAULT_ACCOUNT_LIMITS;
  const timezone = effective?.timezone;

  const capabilitiesSorted = useMemo(() => sortCapabilities(capabilities), [capabilities]);
  const allowedKinds = useMemo<ActivityKind[]>(
    () => draftKinds ?? effective?.allowedKinds ?? [],
    [draftKinds, effective?.allowedKinds],
  );

  if (!boundary || !effective || !account) {
    const copy = boundaryError ? describeError(boundaryError.code) : { title: '还没读到边界', hint: '点下面的按钮重新读取。', retryable: true };
    return (
      <Notice
        tone={boundaryStatus === 'error' ? 'bad' : 'warn'}
        title={copy.title}
        detail={copy.hint}
        action={<InlineButton onClick={onRetry}>重新读取</InlineButton>}
        role="alert"
      />
    );
  }

  const sourceLimits = scope === 'account' ? account.limits : (characterOverrides?.limits ?? effective.limits);
  const paused = Boolean(effective.globalPaused);
  const participating = scope === 'account' ? Boolean(effective.enabled) : Boolean(effective.charEnabled);

  const saveLimits = (key: LimitKey, next: number | null) => {
    const value = scope === 'account' ? Math.max(0, next ?? 0) : next;
    onSave({ limits: { [key]: value } }, scope);
  };

  const toggleKind = (kind: ActivityKind, next: boolean) => {
    const base = new Set(allowedKinds);
    if (next) base.add(kind);
    else base.delete(kind);
    const list = [...base];
    setDraftKinds(list);
    onSave({ allowedKinds: list }, scope);
  };

  return (
    <div className="space-y-3">
      {notice && (
        <Notice
          tone="ok"
          title={notice}
          action={<InlineButton onClick={onDismissNotice}>知道了</InlineButton>}
        />
      )}
      {writeError && (
        <Notice
          tone="bad"
          title={describeError(writeError.code).title}
          detail={describeError(writeError.code).hint}
          role="alert"
          action={
            writeError.code === 'REVISION_CONFLICT' ? (
              <InlineButton onClick={onRetry}>刷新</InlineButton>
            ) : undefined
          }
        />
      )}

      <Card>
        <SectionTitle hint="急停开关：暂停后不再发新的执行许可；已经在做的动作会收尾，不会假装撤销既成事实。">
          总暂停
        </SectionTitle>
        <Row
          label={paused ? '已暂停' : '允许自主生活'}
          hint={
            snapshot.pause.phase !== 'idle'
              ? '正在等云端确认…'
              : paused
                ? '恢复后不会补跑过期计划'
                : '什么时候做什么仍由 TA 的人设和当下情境决定'
          }
        >
          <Toggle
            checked={!paused}
            disabled={saving}
            label="总暂停"
            onChange={(next) => onPause(!next, 'account')}
          />
        </Row>
        <Row
          label={scope === 'account' ? '账号允许自主生活' : `${charName} 参与自主生活`}
          hint={scope === 'account' ? '关闭后所有角色都停下' : '只影响这个角色'}
        >
          <Toggle
            checked={participating}
            disabled={saving}
            label="参与自主生活"
            onChange={(next) => onSave({ [scope === 'account' ? 'enabled' : 'charEnabled']: next }, scope)}
          />
        </Row>
        {state && state.availability === 'pausing' && (
          <Badge tone="warn">正在停止：还有动作在收尾</Badge>
        )}
      </Card>

      <Card>
        <SectionTitle hint="只决定允许的范围；具体挑哪一件事、什么时候做，由人设与情境决定。">
          允许的活动窗口
        </SectionTitle>
        <div className="space-y-1.5">
          {capabilitiesSorted.map((cap) => {
            const checked = scope === 'account'
              ? allowedKinds.includes(cap.kind)
              : (characterOverrides?.allowedKinds ?? effective.allowedKinds).includes(cap.kind);
            const unavailable = !cap.available;
            return (
              <div key={cap.kind} className="flex items-center justify-between gap-2 rounded-2xl bg-slate-50/70 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    {KIND_LABELS[cap.kind]}
                    {cap.executionMode === 'local' ? <Badge tone="idle">本机执行</Badge> : <Badge tone="idle">云端</Badge>}
                  </p>
                  <p className={`text-[10px] mt-0.5 ${unavailable ? 'text-rose-600' : 'text-slate-400'}`}>
                    {capabilityStatusText(cap)}
                  </p>
                </div>
                <Toggle
                  checked={checked}
                  disabled={saving || unavailable}
                  label={`允许${KIND_LABELS[cap.kind]}`}
                  onChange={(next) => toggleKind(cap.kind, next)}
                />
              </div>
            );
          })}
          {capabilitiesSorted.length === 0 && (
            <p className="text-[11px] text-slate-400">服务端还没报告任何可用能力</p>
          )}
        </div>
        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          未通过能力门槛的窗口只能保持不可用，不用故事替代执行；真实支付与外部发布本期一律不开放。
        </p>
      </Card>

      <Card>
        <SectionTitle hint="平台硬禁不能取消；你追加的方向只会让范围更窄。">禁止方向</SectionTitle>
        <ChipsEditor
          items={scope === 'account' ? account.forbiddenCategories.filter((c) => !(PLATFORM_FORBIDDEN_CATEGORIES as readonly string[]).includes(c)) : (characterOverrides?.forbiddenCategories ?? effective.forbiddenCategories).filter((c) => !(PLATFORM_FORBIDDEN_CATEGORIES as readonly string[]).includes(c))}
          locked={UI_PLATFORM_FORBIDDEN as unknown as string[]}
          labelOf={(value) => FORBIDDEN_CATEGORY_LABELS[value] ?? value}
          addPlaceholder="追加禁止方向（例如：亲密付费内容）"
          ariaLabel="添加禁止方向"
          disabled={saving}
          onAdd={(value) => {
            const current = scope === 'account' ? account.forbiddenCategories : (characterOverrides?.forbiddenCategories ?? effective.forbiddenCategories);
            onSave({ forbiddenCategories: [...new Set([...current, value])] }, scope);
          }}
          onRemove={(value) => {
            const current = scope === 'account' ? account.forbiddenCategories : (characterOverrides?.forbiddenCategories ?? effective.forbiddenCategories);
            onSave({ forbiddenCategories: current.filter((item) => item !== value) }, scope);
          }}
        />
        <div className="mt-3">
          <SectionTitle hint="回避的话题：写进日记/消息的内容不会碰这些。">回避话题</SectionTitle>
          <ChipsEditor
            items={scope === 'account' ? account.avoidTopics : (characterOverrides?.avoidTopics ?? effective.avoidTopics)}
            addPlaceholder="添加回避话题"
            ariaLabel="添加回避话题"
            disabled={saving}
            onAdd={(value) => {
              const current = scope === 'account' ? account.avoidTopics : (characterOverrides?.avoidTopics ?? effective.avoidTopics);
              onSave({ avoidTopics: [...new Set([...current, value])] }, scope);
            }}
            onRemove={(value) => {
              const current = scope === 'account' ? account.avoidTopics : (characterOverrides?.avoidTopics ?? effective.avoidTopics);
              onSave({ avoidTopics: current.filter((item) => item !== value) }, scope);
            }}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle hint="上限只是天花板，不要求用满；0 = 明确禁止。留空（角色层）= 跟随账号。">
          调用与消费上限
        </SectionTitle>
        <div className="space-y-0.5">
          {LIMIT_KEYS.map((key) => {
            const raw = sourceLimits[key];
            const effectiveValue = effective.limits[key];
            const meta = LIMIT_LABELS[key];
            return (
              <Row key={key} label={meta.label} hint={`${meta.hint}（结构上限 ${formatLimit(key, maximums[key])}）`}>
                <div className="text-right">
                  <BoundaryNumberInput
                    ariaLabel={meta.label}
                    value={typeof raw === 'number' ? raw : null}
                    min={0}
                    max={typeof maximums[key] === 'number' ? maximums[key] : 0}
                    inheritedText={scope === 'account' ? '必填' : '跟随账号'}
                    disabled={saving}
                    onCommit={(next) => saveLimits(key, next)}
                  />
                  {scope === 'character' && raw === null && typeof effectiveValue === 'number' && (
                    <span className="text-[9px] text-slate-400">当前生效 {formatLimit(key, effectiveValue)}</span>
                  )}
                </div>
              </Row>
            );
          })}
        </div>
        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          账号默认：{LIMIT_KEYS.map((key) => `${LIMIT_LABELS[key].label} ${formatLimit(key, defaults[key])}`).join('｜')}
        </p>
        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
          旧版「每天几次 / 同类冷却 / 预留 token / 活跃度」已退役：不再作为用户配置，也不参与调度。
        </p>
      </Card>

      <Card>
        <SectionTitle hint="免打扰只决定「什么时候不打扰你」，不决定角色什么时候睡觉。">免打扰</SectionTitle>
        <Row label="使用时区" hint="按角色所在时区计算日期与时段">
          <span className="text-[11px] font-mono font-bold text-slate-600">{effective.timezone}</span>
        </Row>
        <div className="flex items-center justify-between gap-3 py-1.5">
          <div>
            <p className="text-xs font-bold text-slate-700">静默时段</p>
            <p className="text-[10px] text-slate-400 mt-0.5">这个时段不推送通知；私人日记等内部活动照常</p>
          </div>
          <div className="flex items-center gap-1.5">
            <ClockInput
              ariaLabel="静默开始时间"
              value={effective.doNotDisturb?.start ?? '23:00'}
              disabled={saving}
              onCommit={(next) =>
                onSave(
                  {
                    doNotDisturb: {
                      timezone: effective.doNotDisturb?.timezone ?? effective.timezone,
                      start: next,
                      end: effective.doNotDisturb?.end ?? '08:00',
                    },
                  },
                  scope,
                )
              }
            />
            <span className="text-[10px] text-slate-400">—</span>
            <ClockInput
              ariaLabel="静默结束时间"
              value={effective.doNotDisturb?.end ?? '08:00'}
              disabled={saving}
              onCommit={(next) =>
                onSave(
                  {
                    doNotDisturb: {
                      timezone: effective.doNotDisturb?.timezone ?? effective.timezone,
                      start: effective.doNotDisturb?.start ?? '23:00',
                      end: next,
                    },
                  },
                  scope,
                )
              }
            />
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="默认没有任何外部权限；只读也不等于不发送，第一次授权时会展示会发哪些字段。">
          外部只读授权
        </SectionTitle>
        {effective.externalGrants.length === 0 ? (
          <p className="text-[11px] text-slate-400">没有外部授权（小红书 / 地图类窗口保持不可用）</p>
        ) : (
          <div className="space-y-1.5">
            {effective.externalGrants.map((grant) => (
              <div key={`${grant.provider}-${grant.purpose}`} className="rounded-2xl bg-slate-50/70 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-700">{grant.provider === 'xhs' ? '小红书' : '地图服务'}</span>
                  <InlineButton
                    tone="danger"
                    disabled={saving}
                    onClick={() =>
                      onSave(
                        { externalGrants: effective.externalGrants.filter((item) => item !== grant) },
                        'account',
                      )
                    }
                  >
                    撤销
                  </InlineButton>
                </div>
                <p className="text-[10px] text-slate-500 mt-0.5">{grant.purpose}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  scope: {grant.scopes.join('、') || '—'}｜域名: {grant.allowedHosts.join('、') || '—'}
                </p>
                <p className="text-[10px] text-slate-400">
                  会发送字段: {grant.allowedFieldKeys.join('、') || '—'}｜每日配额 {grant.dailyQuota}
                </p>
                {grant.expiresAt > 0 && (
                  <p className="text-[10px] text-slate-400">到期 {formatWhen(grant.expiresAt, timezone, now)}</p>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2">
          <p className="text-[10px] font-bold text-slate-500">本期未开放</p>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
            真实支付/下单、自动发帖评论私信、任意网页抓取：没有假确认按钮，调用会直接返回能力不可用。
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="部署内安全常量，界面只读，不提供人工频率输入。">运行保护（只读）</SectionTitle>
        <ul className="text-[10px] text-slate-500 space-y-1 leading-relaxed list-disc pl-4">
          <li>每个角色同时最多一个运行中的动作</li>
          <li>两次自主模型请求间隔至少 30 分钟</li>
          <li>同类动作基础冷却：日记 6 小时、整理 2 小时、记录 2 小时、消息 1 小时</li>
          <li>模型连续失败后退避 30 分钟 → 2 小时 → 8 小时，再失败进入保护性暂停</li>
          <li>睡眠优先休息；没有合适活动就自然休息，不补「任务量」</li>
        </ul>
      </Card>

      <Card>
        <SectionTitle hint="保留手动入口；快捷跳转只负责打开 App，不在各处重复设周期。">就地入口</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {BOUNDARY_QUICK_LINKS.map((link) => (
            <InlineButton key={link.appId} onClick={() => onOpenApp(link.appId, { charId: snapshot.charId })}>
              {link.label}
            </InlineButton>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          活动记录的跳转目标：{Object.entries(KIND_APP).map(([kind, app]) => `${KIND_LABELS[kind as ActivityKind]}→${app.label}`).join('、')}
        </p>
      </Card>

      {state?.reasonCodes?.includes('GRANT_REQUIRED') && (
        <Notice tone="warn" title="有窗口在等授权" detail="授权前这些窗口保持不可用；不会用故事替代执行。" />
      )}
      {state?.reasonCodes?.includes('CIRCUIT_OPEN') && (
        <Notice tone="warn" title="模型连续失败后进入保护性暂停" detail="恢复后只探测一次，不会持续轮询模型。" />
      )}
      {state?.reasonCodes?.includes('CAPABILITY_UNAVAILABLE') && (
        <Notice tone="warn" title="有窗口能力不可用" detail="可能是缺凭据、地图未配置或服务不可达，不是 TA 改变心意。" />
      )}
      {saving && (
        <p className="text-[10px] text-slate-400 flex items-center gap-1">
          <StatusDot tone="warn" /> 正在保存，服务端确认后才算生效
        </p>
      )}
    </div>
  );
};

function formatLimit(key: LimitKey, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (key === 'virtualSpendPerDayMinor' || key === 'virtualOrderMaxMinor') return formatMinor(value);
  if (key === 'accountTokensPerDay' || key === 'charTokensPerDay') return `${value} token`;
  return `${value} 次`;
}

export default BoundaryTab;
