/**
 * 设置 · 角色自主出行
 *
 * 只做用户有权改的事：总开关、角色是否允许出行、地图预算上限、时区/保留期、
 * 固定地点、以及**一次性的配对码**（owner 密钥由运维经已鉴权通道签发，用户粘贴一次，
 * 之后短期会话自动续期，不需要每次输入 token）。
 *
 * 刻意不做：
 * - 没有「让 TA 去哪」「改心情」这类遥控入口 —— 目的地由角色自己决定；
 * - 不提供几何/底图许可开关 —— 那两样是服务端 env 里的合规授权，前端点了也不算；
 * - 读不到服务端设置时整块只读并写「未确认」，不用默认值覆盖。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowsClockwise, Key, MapTrifold, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import {
    getTravelRuntime,
    type TravelMapCredentialView,
    type TravelRuntime,
    type TravelSettings,
} from '../../utils/travel/runtime';
import { readTravelMapConfig, type TravelMapRuntimeConfig } from '../../utils/travel/worldMapAdapter';
import {
    ensureTravelSession,
    readTravelOwnerCredential,
    saveTravelOwnerCredential,
    travelSessionState,
} from '../../utils/travel/session';
import TravelAnchorCard from './TravelAnchorCard';

export interface TravelSettingsProps {
    runtime?: TravelRuntime;
    mapConfig?: TravelMapRuntimeConfig;
    className?: string;
}

interface Draft {
    enabled: boolean;
    budgetTz: string;
    tripRetentionDays: string;
    eventRetentionDays: string;
    mapCallsLimit: string;
}

const toDraft = (s: TravelSettings, mapCallsLimit: number | null): Draft => ({
    enabled: s.enabled,
    budgetTz: s.budgetTz,
    tripRetentionDays: String(s.tripRetentionDays),
    eventRetentionDays: String(s.eventRetentionDays),
    mapCallsLimit: mapCallsLimit === null ? '' : String(mapCallsLimit),
});

const Switch: React.FC<{ checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }> = ({
    checked,
    disabled,
    onChange,
    label,
}) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`w-9 h-5 rounded-full transition-colors duration-200 shrink-0 disabled:opacity-40 ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}
    >
        <span
            className="block w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200"
            style={{ transform: `translateX(${checked ? 18 : 2}px)`, marginTop: 2 }}
        />
    </button>
);

const SecretField: React.FC<{
    testid: string;
    label: string;
    hint: string;
    placeholder: string;
    value: string;
    has: boolean;
    disabled?: boolean;
    onChange: (v: string) => void;
    onClear: () => void;
}> = ({ testid, label, hint, placeholder, value, has, disabled, onChange, onClear }) => (
    <label className="block min-w-0">
        <span className="flex items-center gap-1 text-[9px] text-slate-500">
            <span className="flex-1">{label}</span>
            <span className={has ? 'text-emerald-600' : 'text-slate-400'}>{has ? '已保存' : '未保存'}</span>
            {has && (
                <button
                    type="button"
                    data-testid={`${testid}-clear`}
                    disabled={disabled}
                    onClick={(e) => {
                        e.preventDefault();
                        onClear();
                    }}
                    className="px-1 rounded-full text-[9px] text-rose-600 active:scale-95 transition-transform disabled:opacity-40"
                >
                    清除
                </button>
            )}
        </span>
        <input
            data-testid={testid}
            type="password"
            name={`travel-secret-${testid}`}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            className="mt-0.5 w-full rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500 disabled:opacity-50"
            style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
        />
        <span className="mt-0.5 block text-[9px] leading-relaxed text-slate-500">{hint}</span>
    </label>
);

const ReadinessRow: React.FC<{ ok: boolean; label: string; detail: string }> = ({ ok, label, detail }) => (
    <div className="flex items-start gap-1.5 text-[10px] leading-relaxed">
        {ok ? (
            <ShieldCheck size={12} weight="bold" className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
        ) : (
            <WarningCircle size={12} weight="bold" className="text-amber-500 mt-0.5 shrink-0" aria-hidden />
        )}
        <span className="text-slate-600">
            <span className="font-medium">{label}</span>
            <span className="text-slate-500"> · {detail}</span>
        </span>
    </div>
);

const TravelSettings: React.FC<TravelSettingsProps> = ({ runtime: injected, mapConfig, className = '' }) => {
    const runtime = injected ?? getTravelRuntime();
    const config = useMemo(() => mapConfig ?? readTravelMapConfig(), [mapConfig]);
    const [settings, setSettings] = useState<TravelSettings | null>(null);
    const [known, setKnown] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [mapUsed, setMapUsed] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [charId, setCharId] = useState('');
    const [charEnabled, setCharEnabled] = useState<boolean | null>(null);
    const [pairUser, setPairUser] = useState('');
    const [pairKey, setPairKey] = useState('');
    const [paired, setPaired] = useState(() => !!readTravelOwnerCredential());
    const [cred, setCred] = useState<TravelMapCredentialView | null>(null);
    const [credKnown, setCredKnown] = useState(false);
    const [credError, setCredError] = useState<string | null>(null);
    const [webKey, setWebKey] = useState('');
    const [jsKey, setJsKey] = useState('');
    const [jsCode, setJsCode] = useState('');
    const [mapbox, setMapbox] = useState('');
    const [testing, setTesting] = useState(false);

    const loadCredentials = useCallback(async () => {
        const res = await runtime.readMapCredentials();
        setCredKnown(res.known);
        setCred(res.known ? res.credentials : null);
        setCredError(res.known ? null : res.error ?? 'UNKNOWN');
    }, [runtime]);

    const load = useCallback(async () => {
        setBusy(true);
        const res = await runtime.readSettings();
        const budget = await runtime.readBudget();
        void loadCredentials();
        setBusy(false);
        if (!res.known || !res.settings) {
            setKnown(false);
            setSettings(null);
            setDraft(null);
            setError(res.error ?? 'UNKNOWN');
            setMapUsed(null);
            return;
        }
        const limit = budget.known ? budget.state?.mapCallsLimit ?? null : null;
        setKnown(true);
        setSettings(res.settings);
        setDraft(toDraft(res.settings, limit));
        setMapUsed(budget.known ? budget.state?.mapCallsUsed ?? null : null);
        setError(null);
    }, [runtime]);

    useEffect(() => {
        void load();
    }, [load]);

    const sessionState = travelSessionState();
    const dirty =
        !!draft &&
        !!settings &&
        (draft.enabled !== settings.enabled ||
            draft.budgetTz !== settings.budgetTz ||
            draft.tripRetentionDays !== String(settings.tripRetentionDays) ||
            draft.eventRetentionDays !== String(settings.eventRetentionDays));

    const handleSave = useCallback(async () => {
        if (!draft || !settings) return;
        const tripDays = Number(draft.tripRetentionDays);
        const eventDays = Number(draft.eventRetentionDays);
        if (!Number.isFinite(tripDays) || tripDays < 0 || !Number.isFinite(eventDays) || eventDays < 0) {
            setNote('保留天数要填 0 或正整数');
            return;
        }
        setBusy(true);
        const res = await runtime.saveSettings(
            {
                enabled: draft.enabled,
                budgetTz: draft.budgetTz,
                tripRetentionDays: Math.floor(tripDays),
                eventRetentionDays: Math.floor(eventDays),
            },
            settings.version,
        );
        setBusy(false);
        if (!res.ok) {
            setNote(res.code === 'VERSION_CONFLICT' ? '状态已被其他设备更新，已重新读取' : '保存失败，本机草稿未写回服务端');
            if (res.code === 'VERSION_CONFLICT') await load();
            return;
        }
        setNote('已保存到服务端');
        await load(); // 读回，不靠本地回执当权威
    }, [draft, settings, runtime, load]);

    const handleSaveBudget = useCallback(async () => {
        if (!draft) return;
        const limit = Number(draft.mapCallsLimit);
        if (!Number.isFinite(limit) || limit < 0) {
            setNote('地图额度要填 0 或正整数（0 = 暂停一切地图调用）');
            return;
        }
        setBusy(true);
        const res = await runtime.saveBudgetLimit(Math.floor(limit));
        setBusy(false);
        if (!res.ok) {
            setNote('额度没写进服务端（不会退化成默认值）');
            return;
        }
        setNote('地图额度已保存');
        await load();
    }, [draft, runtime, load]);

    const handleToggleChar = useCallback(async () => {
        const id = charId.trim();
        if (!id) return;
        const next = !(charEnabled === true);
        setBusy(true);
        const res = await runtime.saveCharEnabled(id, next);
        setBusy(false);
        if (!res.ok) {
            setNote('角色开关没写进服务端');
            return;
        }
        setCharEnabled(next);
        setNote(next ? '已允许这个角色自主出行' : '已暂停这个角色自主出行（不影响其它角色）');
    }, [charId, charEnabled, runtime]);

    const handlePair = useCallback(async () => {
        const saved = saveTravelOwnerCredential({ userId: pairUser.trim(), ownerKey: pairKey.trim() });
        if (!saved) {
            setNote('配对码格式不对（需要 userId 与至少 16 位的 owner 密钥）');
            return;
        }
        setPaired(true);
        setPairKey('');
        const ready = await ensureTravelSession({});
        setNote(ready ? '已配对，短期会话已自动换取' : '已保存配对码，但服务端没签发会话（检查 owner 是否已登记）');
        await load();
    }, [pairUser, pairKey, load]);

    /**
     * 地图凭据：空字段 = 保持不变（不把「没填」当清除）；清除必须点对应的按钮。
     * 前端只持有用户刚输入的草稿，成功保存后立刻清空输入并读回存在性。
     */
    const handleSaveCredentials = useCallback(async () => {
        const patch: {
            amapWebKey?: string;
            amapJsKey?: string;
            amapJsCode?: string;
            mapboxToken?: string;
        } = {};
        if (webKey.trim()) patch.amapWebKey = webKey.trim();
        if (jsKey.trim()) patch.amapJsKey = jsKey.trim();
        if (jsCode.trim()) patch.amapJsCode = jsCode.trim();
        if (mapbox.trim()) patch.mapboxToken = mapbox.trim();
        if (Object.keys(patch).length === 0) {
            setNote('没有新内容：已配置的会保持不变；要清除请点对应的「清除」');
            return;
        }
        setBusy(true);
        const res = await runtime.saveMapCredentials(patch);
        setBusy(false);
        if (!res.ok) {
            setNote(
                res.code === 'UNAUTHORIZED'
                    ? '没有写进服务端（登录已过期或服务端未配置加密主密钥）'
                    : res.code === 'INVALID_FIELD'
                        ? '有字段格式不对（不能带换行或控制字符）'
                        : '没写进服务端，原配置未被覆盖',
            );
            return;
        }
        setWebKey('');
        setJsKey('');
        setJsCode('');
        setMapbox('');
        setCred(res.credentials ?? null);
        setCredKnown(!!res.credentials);
        setNote('已加密保存到服务端 · 输入框已清空');
        await loadCredentials();
    }, [webKey, jsKey, jsCode, mapbox, runtime, loadCredentials]);

    const handleClearCredential = useCallback(
        async (field: 'amapWebKey' | 'amapJsKey' | 'amapJsCode' | 'mapboxToken') => {
            setBusy(true);
            const res = await runtime.saveMapCredentials({ clear: [field] });
            setBusy(false);
            if (!res.ok) {
                setNote('清除没生效（服务端拒绝了这次写入）');
                return;
            }
            if (field === 'amapWebKey') setWebKey('');
            if (field === 'amapJsKey') setJsKey('');
            if (field === 'amapJsCode') setJsCode('');
            if (field === 'mapboxToken') setMapbox('');
            setCred(res.credentials ?? null);
            setCredKnown(!!res.credentials);
            setNote('已清除该凭据');
            await loadCredentials();
        },
        [runtime, loadCredentials],
    );

    const handleTestConnection = useCallback(async () => {
        setTesting(true);
        const res = await runtime.testMapConnection();
        setTesting(false);
        if (res.ok) setNote('连接正常（高德 Web 服务 Key 可用）');
        else if (res.code === 'MAP_NOT_CONFIGURED') setNote('还没保存高德 Web 服务 Key');
        else if (res.code === 'TOO_MANY_REQUESTS') setNote('刚测过，30 秒后再试');
        else setNote('连接失败：Key 无效、未开通 Web 服务或额度受限（不会自动重试）');
    }, [runtime]);

    return (
        <section data-testid="travel-settings" className={className}>
            <div className="flex items-center gap-2 px-1">
                <MapTrifold size={14} weight="bold" className="text-slate-500" aria-hidden />
                <h3 className="text-[13px] font-medium text-slate-800">角色自主出行</h3>
                <span className="ml-auto text-[9px] text-slate-500">
                    {sessionState === 'ready' ? '已登录' : sessionState === 'expired' ? '登录已过期' : '未登录'}
                </span>
            </div>

            {!known && (
                <div
                    data-testid="travel-settings-unknown"
                    className="mt-2 flex items-start gap-1.5 rounded-2xl px-2.5 py-2 text-[10px] leading-relaxed text-amber-700"
                    style={{ background: 'rgba(254,243,199,0.85)', border: '1px solid rgba(245,158,11,0.35)' }}
                >
                    <WarningCircle size={12} weight="bold" className="mt-0.5 shrink-0" aria-hidden />
                    <span className="flex-1">
                        未确认：还没读到服务端设置（{error ?? '未登录或后端未就绪'}）。这里不会用默认值覆盖你的配置。
                    </span>
                    <button
                        onClick={() => void load()}
                        className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] active:scale-95 transition-transform"
                        style={{ background: 'rgba(255,255,255,0.9)' }}
                    >
                        重新读取
                    </button>
                </div>
            )}

            <div
                className="mt-2 rounded-2xl divide-y divide-slate-100"
                style={{ background: '#ffffff', border: '1px solid rgba(226,232,240,0.9)' }}
            >
                <div className="flex items-center gap-2 px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                        <div className="text-[11px] text-slate-700">允许角色自主出行</div>
                        <div className="text-[9px] text-slate-500">只管「能不能出门」；TA 想去哪、什么时候回仍由 TA 自己决定</div>
                    </div>
                    <Switch
                        label="允许角色自主出行"
                        checked={!!draft?.enabled}
                        disabled={!known || busy || !draft}
                        onChange={(v) => draft && setDraft({ ...draft, enabled: v })}
                    />
                </div>

                <div className="px-3 py-2.5">
                    <div className="text-[11px] text-slate-700">单个角色</div>
                    <div className="text-[9px] text-slate-500">总开关之外的第二道闸；缺省是「不允许」，不会因为总开关打开就自动放开</div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                        <input
                            data-testid="travel-char-id"
                            value={charId}
                            disabled={!known || busy}
                            placeholder="角色 ID"
                            onChange={(e) => {
                                setCharId(e.target.value);
                                setCharEnabled(null);
                            }}
                            className="flex-1 min-w-0 rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500"
                            style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                        />
                        <button
                            data-testid="travel-char-read"
                            onClick={() => {
                                void (async () => {
                                    const res = await runtime.readCharEnabled(charId.trim());
                                    setCharEnabled(res.known ? res.enabled : null);
                                    if (!res.known) setNote('读不到这个角色的开关');
                                })();
                            }}
                            disabled={!known || busy || !charId.trim()}
                            className="px-2 py-1 rounded-full text-[10px] disabled:opacity-100"
                            style={{
                                background: !known || busy || !charId.trim() ? 'rgba(148,163,184,0.18)' : 'rgba(241,245,249,0.95)',
                                color: '#475569',
                            }}
                        >
                            读取
                        </button>
                        <button
                            data-testid="travel-char-toggle"
                            onClick={() => void handleToggleChar()}
                            disabled={!known || busy || !charId.trim() || charEnabled === null}
                            className="px-2 py-1 rounded-full text-[10px] disabled:opacity-100"
                            style={{
                                background:
                                    !known || busy || !charId.trim() || charEnabled === null
                                        ? 'rgba(148,163,184,0.30)'
                                        : 'rgba(15,23,42,0.88)',
                                color:
                                    !known || busy || !charId.trim() || charEnabled === null ? '#475569' : '#ffffff',
                            }}
                        >
                            {charEnabled === true ? '暂停 TA 出行' : '允许 TA 出行'}
                        </button>
                    </div>
                </div>

                <div className="px-3 py-2.5">
                    <div className="text-[11px] text-slate-700">每日地图额度（账号级）</div>
                    <div className="mt-1.5 flex items-center gap-2">
                        <label className="flex-1 min-w-0">
                            <span className="block text-[9px] text-slate-500">地图请求上限（每次真实请求扣 1）</span>
                            <input
                                data-testid="travel-budget-map"
                                inputMode="numeric"
                                value={draft?.mapCallsLimit ?? ''}
                                disabled={!known || busy || !draft}
                                onChange={(e) => draft && setDraft({ ...draft, mapCallsLimit: e.target.value })}
                                className="mt-0.5 w-full rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500"
                                style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                            />
                        </label>
                        <button
                            data-testid="travel-budget-save"
                            onClick={() => void handleSaveBudget()}
                            disabled={!known || busy || !draft}
                            className="mt-3 px-2.5 py-1 rounded-full text-[10px] disabled:opacity-100"
                            style={{
                                background: !known || busy || !draft ? 'rgba(148,163,184,0.30)' : 'rgba(15,23,42,0.88)',
                                color: !known || busy || !draft ? '#475569' : '#ffffff',
                            }}
                        >
                            保存额度
                        </button>
                    </div>
                    <div className="mt-1 text-[9px] text-slate-500">
                        今日已用 {mapUsed === null ? '未知' : mapUsed} · 0 = 暂停一切地图调用（不会自动补默认额度）
                    </div>
                    <div className="mt-0.5 text-[9px] text-slate-500">
                        模型用量不在这里：走既有自主生活账本，不会因为这里填数字就提额
                    </div>
                </div>

                <div className="px-3 py-2.5">
                    <div className="text-[11px] text-slate-700">时区与保留期</div>
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                        <label className="min-w-0 col-span-2">
                            <span className="block text-[9px] text-slate-500">账号预算时区</span>
                            <input
                                data-testid="travel-budget-tz"
                                value={draft?.budgetTz ?? ''}
                                disabled={!known || busy || !draft}
                                onChange={(e) => draft && setDraft({ ...draft, budgetTz: e.target.value })}
                                className="mt-0.5 w-full rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500"
                                style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                            />
                        </label>
                        <label className="min-w-0">
                            <span className="block text-[9px] text-slate-500">行程保留（天）</span>
                            <input
                                data-testid="travel-retention-trip"
                                inputMode="numeric"
                                value={draft?.tripRetentionDays ?? ''}
                                disabled={!known || busy || !draft}
                                onChange={(e) => draft && setDraft({ ...draft, tripRetentionDays: e.target.value })}
                                className="mt-0.5 w-full rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500"
                                style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                            />
                        </label>
                        <label className="min-w-0">
                            <span className="block text-[9px] text-slate-500">事件保留（天）</span>
                            <input
                                data-testid="travel-retention-event"
                                inputMode="numeric"
                                value={draft?.eventRetentionDays ?? ''}
                                disabled={!known || busy || !draft}
                                onChange={(e) => draft && setDraft({ ...draft, eventRetentionDays: e.target.value })}
                                className="mt-0.5 w-full rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500"
                                style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                            />
                        </label>
                    </div>
                </div>

                <div className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <Key size={11} weight="bold" className="text-slate-500" aria-hidden />
                        <div className="text-[11px] text-slate-700">配对码（一次性）</div>
                        <span className="ml-auto text-[9px] text-slate-500">{paired ? '已保存' : '未配对'}</span>
                    </div>
                    <div className="text-[9px] text-slate-500">
                        由运维在服务端签发；只粘一次，短期会话到期会自动续期，不需要每次输入 token。配对码只存在本机，不进备份。
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <input
                            data-testid="travel-pair-user"
                            value={pairUser}
                            onChange={(e) => setPairUser(e.target.value)}
                            placeholder="账号 ID（服务端主体）"
                            className="flex-1 min-w-[132px] rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500"
                            style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                        />
                        <input
                            data-testid="travel-pair-key"
                            value={pairKey}
                            onChange={(e) => setPairKey(e.target.value)}
                            placeholder="配对码"
                            type="password"
                            autoComplete="off"
                            className="flex-1 min-w-0 rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500"
                            style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                        />
                        <button
                            data-testid="travel-pair-save"
                            onClick={() => void handlePair()}
                            disabled={busy || !pairUser.trim() || !pairKey.trim()}
                            className="px-2.5 py-1 rounded-full text-[10px] disabled:opacity-100"
                            style={{
                                background:
                                    busy || !pairUser.trim() || !pairKey.trim()
                                        ? 'rgba(148,163,184,0.30)'
                                        : 'rgba(15,23,42,0.88)',
                                color: busy || !pairUser.trim() || !pairKey.trim() ? '#475569' : '#ffffff',
                            }}
                        >
                            配对
                        </button>
                    </div>
                </div>
                <div className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <MapTrifold size={11} weight="bold" className="text-slate-500" aria-hidden />
                        <div className="text-[11px] text-slate-700">地图服务凭据</div>
                        <span className="ml-auto text-[9px] text-slate-500">
                            {!credKnown ? '未确认' : cred?.configured ? '已加密保存' : '未配置'}
                        </span>
                    </div>
                    <div className="text-[9px] leading-relaxed text-slate-500">
                        填一次即可，后台按你的账号加密保存；刷新、换设备都不需要重填，也不会写进备份或网址。
                        Web 服务 Key 与安全密钥只在服务端使用，不会回到浏览器；JS API Key 是官方要求浏览器持有的展示 Key。
                    </div>
                    {!credKnown && (
                        <div data-testid="travel-map-credentials-unknown" className="mt-1 text-[9px] text-amber-700">
                            未确认：还没读到服务端凭据状态（{credError ?? '未登录或后端未就绪'}）。这里不会用空值覆盖已存配置。
                        </div>
                    )}
                    {credKnown && cred?.unreadable && (
                        <div data-testid="travel-map-credentials-unreadable" className="mt-1 text-[9px] text-rose-700">
                            服务端有记录但解不开（主密钥变更过）。为避免覆盖，保存已被拒绝，请联系运维。
                        </div>
                    )}
                    <div className="mt-1.5 grid grid-cols-1 gap-1.5">
                        <SecretField
                            testid="travel-map-web-key"
                            label="高德 Web 服务 Key"
                            hint="地理编码 / 地点检索 / 路线与静态图，只在服务端使用"
                            placeholder="粘贴 Web 服务 Key"
                            value={webKey}
                            has={!!cred?.has.amapWebKey}
                            disabled={!credKnown || busy}
                            onChange={setWebKey}
                            onClear={() => void handleClearCredential('amapWebKey')}
                        />
                        <SecretField
                            testid="travel-map-js-key"
                            label="高德 JS API Key（展示用）"
                            hint="浏览器必需的公开展示 Key；请在高德控制台配置域名白名单"
                            placeholder="粘贴 JS API Key"
                            value={jsKey}
                            has={!!cred?.has.amapJsKey}
                            disabled={!credKnown || busy}
                            onChange={setJsKey}
                            onClear={() => void handleClearCredential('amapJsKey')}
                        />
                        <SecretField
                            testid="travel-map-js-code"
                            label="高德安全密钥 jscode"
                            hint="只在服务端代理里注入；不会出现在页面、网址或日志里"
                            placeholder="粘贴安全密钥"
                            value={jsCode}
                            has={!!cred?.has.amapJsCode}
                            disabled={!credKnown || busy}
                            onChange={setJsCode}
                            onClear={() => void handleClearCredential('amapJsCode')}
                        />
                        <SecretField
                            testid="travel-map-mapbox"
                            label="Mapbox 公钥（可选，国外）"
                            hint="pk. 开头的公钥；没有就不接国外底图，也不代为注册账号"
                            placeholder="pk.…"
                            value={mapbox}
                            has={!!cred?.has.mapboxToken}
                            disabled={!credKnown || busy}
                            onChange={setMapbox}
                            onClear={() => void handleClearCredential('mapboxToken')}
                        />
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                            data-testid="travel-map-save"
                            onClick={() => void handleSaveCredentials()}
                            disabled={!credKnown || busy}
                            className="px-2.5 py-1 rounded-full text-[10px] active:scale-95 transition-transform disabled:opacity-100"
                            style={{
                                background: !credKnown || busy ? 'rgba(148,163,184,0.30)' : 'rgba(15,23,42,0.88)',
                                color: !credKnown || busy ? '#475569' : '#ffffff',
                            }}
                        >
                            保存地图凭据
                        </button>
                        <button
                            data-testid="travel-map-test"
                            onClick={() => void handleTestConnection()}
                            disabled={!credKnown || busy || testing}
                            className="px-2.5 py-1 rounded-full text-[10px] active:scale-95 transition-transform disabled:opacity-100"
                            style={{
                                background: !credKnown || busy || testing ? 'rgba(148,163,184,0.18)' : 'rgba(241,245,249,0.95)',
                                color: '#475569',
                            }}
                        >
                            {testing ? '测试中…' : '测试连接（1 次）'}
                        </button>
                        <span className="ml-auto text-[9px] text-slate-500">
                            {cred?.updatedAt ? `更新于 ${new Date(cred.updatedAt).toLocaleString()}` : ''}
                        </span>
                    </div>
                    <div className="mt-0.5 text-[9px] text-slate-500">
                        保存本身不会发起任何真实地图请求；「测试连接」是你点一次才打一次，有 30 秒冷却，不扣出行额度。
                    </div>
                </div>
            </div>

            <div className="mt-2">
                <TravelAnchorCard runtime={runtime} disabled={!known || busy} onConfirmed={() => setNote('固定地点已更新')} />
            </div>

            {note && (
                <div data-testid="travel-settings-note" className="mt-1.5 px-1 text-[10px] text-slate-500">
                    {note}
                </div>
            )}

            <div className="mt-2 flex items-center gap-2">
                <button
                    data-testid="travel-settings-save"
                    onClick={() => void handleSave()}
                    disabled={!known || busy || !dirty}
                    className="px-3 py-1 rounded-full text-[10px] font-medium active:scale-95 transition-transform disabled:opacity-100"
                    style={{
                        background: !known || busy || !dirty ? 'rgba(148,163,184,0.30)' : 'rgba(15,23,42,0.88)',
                        color: !known || busy || !dirty ? '#475569' : '#ffffff',
                    }}
                >
                    保存设置
                </button>
                <button
                    onClick={() => void load()}
                    disabled={busy}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] active:scale-95 transition-transform disabled:opacity-100"
                    style={{
                        background: busy ? 'rgba(148,163,184,0.18)' : 'rgba(241,245,249,0.95)',
                        color: busy ? '#64748b' : '#475569',
                    }}
                >
                    <ArrowsClockwise size={10} weight="bold" aria-hidden />
                    重新读取
                </button>
            </div>

            <div
                className="mt-2 rounded-2xl px-3 py-2.5 space-y-1"
                style={{ background: '#ffffff', border: '1px solid rgba(226,232,240,0.9)' }}
            >
                <div className="text-[11px] text-slate-700">地图与登录就绪状态</div>
                <ReadinessRow
                    ok={credKnown ? !!cred?.has.amapJsKey : !!config.amapJsKey}
                    label="高德 JS 地图 Key"
                    detail={
                        credKnown
                            ? cred?.has.amapJsKey ? '已保存（服务端）· 面板可出图' : '未配置 · 面板显示地图暂不可用，不画假地图'
                            : '未确认 · 未确认前不画假地图，也不把构建期兜底值当已配置'
                    }
                />
                <ReadinessRow
                    ok={credKnown ? !!cred?.serviceHost : !!config.amapServiceHost}
                    label="jscode 安全代理"
                    detail={
                        credKnown
                            ? cred?.serviceHost ? '已签发短期会话 · jscode 只在服务端注入' : '未配置 · 需要同时保存 JS Key 与安全密钥'
                            : '未确认 · jscode 只能由服务端注入，不能进前端'
                    }
                />
                <ReadinessRow
                    ok={credKnown ? !!cred?.has.mapboxToken : !!config.world}
                    label="国外地图（Mapbox）"
                    detail={
                        credKnown
                            ? cred?.has.mapboxToken ? '已保存凭证 · 还需要样式地址' : '未配置凭证 · 国外暂不接图，也不代为注册付费账号'
                            : '未确认 · 构建期兜底值不代表服务端配置'
                    }
                />
                <ReadinessRow
                    ok={sessionState === 'ready'}
                    label="短期登录会话"
                    detail={sessionState === 'ready' ? '已就绪' : '未就绪 · 出行接口不会在无会话时发请求'}
                />
                <ReadinessRow
                    ok={config.licensedGeometry}
                    label="路线几何展示许可"
                    detail={config.licensedGeometry ? '已取得' : '未取得 · 只在内存画线，不落盘'}
                />
            </div>
        </section>
    );
};

export default TravelSettings;
