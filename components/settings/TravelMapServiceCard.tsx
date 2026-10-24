/**
 * 设置 · 实时感知 → 地图服务（唯一一处）
 *
 * 为什么只有这一处：高德 Web 服务 Key / JS Key / jscode / Mapbox 公钥以前分散在
 * 实时感知的 `RealtimeConfig.amapApiKey`（本机明文）与角色出行的「地图服务凭据」
 * （服务端按账号加密）。两份权威会打架：填了这份，地点搜索/天气城市/出行 provider
 * 读的却是另一份。现在统一走服务端加密单源，本组件是唯一填写入口：
 *
 * - 保存不发任何收费请求；「测试连接」是你点一次才打一次，有冷却；
 * - 空字段 = 保持原值；清除必须显式点；
 * - 本机旧 Key 不静默迁移：用户点「迁移本机旧 Key」才写入服务端，成功后清掉本地值；
 *   失败保留本地值，绝不空值覆盖；
 * - Web 服务 Key / jscode 只在服务端使用，永不回显；JS Key 是官方要浏览器持有的展示 Key。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Key, MapTrifold, ShieldCheck } from '@phosphor-icons/react';
import {
  getTravelRuntime,
  type TravelMapCredentialView,
  type TravelRuntime,
} from '../../utils/travel/runtime';
import {
  claimPairCode,
  readPairStatus,
  requestPairCode,
  type PairRequestState,
} from '../../utils/travel/pairingClient';
import { ensureTravelSession, readTravelOwnerCredential, saveTravelOwnerCredential } from '../../utils/travel/session';
import {
  getMapReadinessSnapshot,
  refreshMapReadiness,
  setMapPairPending,
  subscribeMapReadiness,
  type MapReadinessPhase,
} from '../../utils/travel/mapReadiness';

/** 当前站点域名：独立部署后就是用户自己的域名，文案不能写死任何人的家域名。 */
const useSiteHost = (): string => {
  try { return window.location.host || ''; } catch { return ''; }
};

const SITE_HOST_FALLBACK = '你的站点域名';

const PHASE_TEXT: Record<MapReadinessPhase, string> = {
  'pending-approval': '等待批准',
  unconnected: '未连接',
  error: '读取失败',
  unconfigured: '未配置',
  partial: '部分就绪',
  ready: '已加密保存',
};

export interface TravelMapServiceCardProps {
  runtime?: TravelRuntime;
  /** 本机实时感知里遗留的 Web 服务 Key（只用于用户显式迁移，不自动写入）。 */
  legacyKey?: string;
  onLegacyMigrated?: () => void;
  className?: string;
}

/**
 * 官方入口（只放这一组，别处不要重复加外站）：
 * 2026-10-24 公开读回核实——控制台「我的应用」页、Web 服务 Key 说明页（"使用本组服务之前，需要申请应用Key"）、
 * JS API 准备页（"申请 web 平台（JS API）的 key 和安全密钥"）、Mapbox access tokens 页。
 */
export const TRAVEL_MAP_HELP_LINKS = {
  /** 高德控制台 · 应用管理 · 我的应用（建应用、加 Key、看服务平台下拉） */
  amapConsole: 'https://console.amap.com/dev/key/app',
  /** 官方：Web 服务 API 需要单独申请应用 Key */
  amapWebServiceDoc: 'https://lbs.amap.com/api/webservice/get-key',
  /** 官方：JS API 的 key 与安全密钥（jscode / securityJsCode） */
  amapJsApiPrepare: 'https://lbs.amap.com/api/javascript-api-v2/guide/abc/prepare',
  /** Mapbox 公共 access token（pk.） */
  mapboxTokens: 'https://account.mapbox.com/access-tokens/',
} as const;

const HelpLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="block text-[9px] leading-relaxed text-teal-700 underline break-all"
  >{children}</a>
);

const MapHelp: React.FC<{
  testid: string;
  steps: React.ReactNode[];
  links: { href: string; label: string }[];
}> = ({ testid, steps, links }) => (
  <details data-testid={testid} className="mt-0.5">
    <summary className="cursor-pointer text-[9px] font-medium text-teal-700">不会填？查看步骤</summary>
    <div className="mt-0.5 rounded-lg bg-white/70 px-1.5 py-1">
      <ol className="list-decimal space-y-0.5 pl-3.5 text-[9px] leading-relaxed text-slate-600">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {links.map((l) => <HelpLink key={l.href} href={l.href}>{l.label}</HelpLink>)}
    </div>
  </details>
);

const SecretRow: React.FC<{
  testid: string;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  has: boolean;
  disabled?: boolean;
  help?: React.ReactNode;
  onChange: (v: string) => void;
  onClear: () => void;
}> = ({ testid, label, hint, placeholder, value, has, disabled, help, onChange, onClear }) => (
  <div className="block min-w-0">
    <label className="block min-w-0">
      <span className="flex items-center gap-1 text-[9px] text-slate-500">
        <span className="flex-1">{label}</span>
        <span className={has ? 'text-emerald-600' : 'text-slate-400'}>{has ? '已保存' : '未保存'}</span>
        {has && (
          <button
            type="button"
            data-testid={`${testid}-clear`}
            disabled={disabled}
            onClick={(e) => { e.preventDefault(); onClear(); }}
            className="px-1 rounded-full text-[9px] text-rose-600 disabled:opacity-40"
          >清除</button>
        )}
      </span>
      <input
        data-testid={testid}
        type="password"
        name={`map-secret-${testid}`}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="new-password"
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded-xl px-2 py-1 text-[11px] text-slate-700 outline-none placeholder:text-slate-500 disabled:opacity-50"
        style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
      />
      <span className="mt-0.5 block text-[9px] leading-relaxed text-slate-500">{hint}</span>
    </label>
    {help}
  </div>
);

const TravelMapServiceCard: React.FC<TravelMapServiceCardProps> = ({
  runtime: injected,
  legacyKey = '',
  onLegacyMigrated,
  className = '',
}) => {
  const runtime = injected ?? getTravelRuntime();
  // 就绪只有一份权威：父宫格与这张卡订阅同一份快照（utils/travel/mapReadiness），
  // 卡片自己不再另发一次后端读回，也不会出现「宫格就绪、卡片未配置」。
  const snapshot = React.useSyncExternalStore(subscribeMapReadiness, getMapReadinessSnapshot, getMapReadinessSnapshot);
  const cred: TravelMapCredentialView | null = snapshot.credentials;
  const known = snapshot.known;
  const credError = snapshot.error;
  const siteHost = useSiteHost();
  const [webKey, setWebKey] = useState('');
  const [jsKey, setJsKey] = useState('');
  const [jsCode, setJsCode] = useState('');
  const [mapbox, setMapbox] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [killLegacyAfterWrite, setKillLegacyAfterWrite] = useState(false);
  const [pair, setPair] = useState<PairRequestState | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [paired, setPaired] = useState(() => !!readTravelOwnerCredential());

  const loadCredentials = useCallback(async () => {
    await refreshMapReadiness(runtime);
  }, [runtime]);

  useEffect(() => {
    // 父层首屏已读过就复用（30 秒内不重复打后端）；只有读不到时才补一次。
    const current = getMapReadinessSnapshot();
    if (!current.refreshedAt || Date.now() - current.refreshedAt > 30_000) void loadCredentials();
  }, [loadCredentials]);

  const writeCredentials = useCallback(async (patch: Record<string, string>, clear?: string[]) => {
    setBusy(true);
    const res = await runtime.saveMapCredentials({
      ...(patch as Record<string, string>),
      ...(clear?.length ? { clear: clear as never } : {}),
    } as never);
    setBusy(false);
    if (!res.ok) {
      setNote(res.code === 'UNAUTHORIZED'
        ? '没有写进服务端（先完成「申请连接」，或服务端未配置加密主密钥）'
        : '没写进服务端，原配置未被覆盖');
      return false;
    }
    await loadCredentials();
    return true;
  }, [runtime, loadCredentials]);

  const handleSave = useCallback(async () => {
    const patch: Record<string, string> = {};
    if (webKey.trim()) patch.amapWebKey = webKey.trim();
    if (jsKey.trim()) patch.amapJsKey = jsKey.trim();
    if (jsCode.trim()) patch.amapJsCode = jsCode.trim();
    if (mapbox.trim()) patch.mapboxToken = mapbox.trim();
    if (!Object.keys(patch).length) {
      setNote('没有新内容：已配置的保持不变；要清除请点对应「清除」');
      return;
    }
    const ok = await writeCredentials(patch);
    if (!ok) return;
    setWebKey(''); setJsKey(''); setJsCode(''); setMapbox('');
    setNote('已加密保存到服务端 · 输入框已清空');
    if (killLegacyAfterWrite && onLegacyMigrated && patch.amapWebKey) {
      // 严格读回：只有服务端**再次 GET 就报 has.amapWebKey=true** 才删本机旧值。
      // 保存响应乐观、网络/解密/版本冲突等都可能让写入实际没落地——那时必须保留旧 Key，
      // 否则用户既没迁成功也丢了本地唯一一份。
      const readback = await runtime.readMapCredentials().catch(() => null);
      const confirmed = !!readback?.known && readback.credentials?.has?.amapWebKey === true;
      setKillLegacyAfterWrite(false);
      if (!confirmed) {
        setNote('服务端没确认这条 Web 服务 Key：本机旧 Key 已保留，可重试「保存地图凭据」');
        return;
      }
      onLegacyMigrated();
      setNote('已迁移本机旧 Key 并清掉本地明文');
    }
  }, [webKey, jsKey, jsCode, mapbox, writeCredentials, killLegacyAfterWrite, onLegacyMigrated, runtime]);

  const handleMigrateLegacy = useCallback(async () => {
    const key = legacyKey.trim();
    if (!key) { setNote('本机没有可迁移的旧 Key'); return; }
    setKillLegacyAfterWrite(true);
    setWebKey(key);
    setNote('已填入本机旧 Key：点「保存地图凭据」确认迁移；失败会保留本地值');
  }, [legacyKey]);

  const handleClaim = useCallback(async (state: PairRequestState) => {
    setPairBusy(true);
    const claimed = await claimPairCode(state);
    if (!claimed.ok) {
      setPairBusy(false);
      setNote(claimed.code === 'NOT_APPROVED'
        ? '管理员还没批准这次申请；批准后这页会自动完成'
        : claimed.code === 'EXPIRED'
          ? '申请已过期，请重新申请连接'
          : `认领失败：${claimed.code}`);
      return;
    }
    saveTravelOwnerCredential({ userId: claimed.userId, ownerKey: claimed.ownerKey });
    setPaired(true);
    setMapPairPending(false);
    await ensureTravelSession({});
    setPair(null);
    setPairBusy(false);
    await loadCredentials();
    setNote('已连接：本浏览器已与本账号绑定，之后不需要再输入配对码');
  }, [loadCredentials]);

  const handlePairRequest = useCallback(async () => {
    setPairBusy(true);
    const created = await requestPairCode();
    setPairBusy(false);
    if (!created.ok) {
      setNote(created.code === 'RATE_LIMITED' ? '申请太频繁，请 10 分钟后再试' : '申请连接失败，请稍后重试');
      return;
    }
    setPair(created.state);
    // 父宫格同步显示「待批准」，不必等卡片回传或刷新。
    setMapPairPending(true);
    setNote('把下面的短码交给已授权管理员批准；批准前这里不会变成已连接');
  }, []);

  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const status = await readPairStatus(pair);
      if (cancelled) return;
      if (status.status === 'approved') { void handleClaim(pair); return; }
      if (status.status === 'expired' || status.status === 'invalid') {
        setPair(null);
        setMapPairPending(false);
        setNote('申请已过期或被撤销，请重新申请连接');
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pair, handleClaim]);

  return (
    <div data-testid="travel-map-service" className={className}>
      <div className="flex items-center gap-1.5">
        <MapTrifold size={12} weight="bold" className="text-teal-600" aria-hidden />
        <div className="text-[11px] font-medium text-slate-700">地图服务（高德 / Mapbox）</div>
        <span data-testid="map-service-status" className="ml-auto text-[9px] text-slate-500">
          {PHASE_TEXT[snapshot.phase] ?? '未确认'}
        </span>
      </div>
      <p className="mt-0.5 text-[9px] leading-relaxed text-slate-500">
        全系统只有这一处地图凭据：地点搜索、天气城市地理、出行的路线与静态图都读这一份，后台按账号加密。
        浏览器不会拿到 Web 服务 Key 与安全密钥，也不会写进备份或网址。
      </p>

      {!known && (
        <div data-testid="map-service-unknown" className="mt-1 text-[9px] text-amber-700">
          未确认：还没读到服务端状态（{credError ?? '尚未连接'}）。这里不会用空值覆盖已存配置。
        </div>
      )}
      {known && cred?.unreadable && (
        <div className="mt-1 text-[9px] text-rose-700">服务端有记录但解不开（主密钥变更过），保存已被拒绝。</div>
      )}

      {!paired && (
        <div className="mt-2 rounded-xl bg-teal-50/70 p-2">
          <div className="flex items-center gap-1.5">
            <Key size={11} weight="bold" className="text-teal-700" aria-hidden />
            <span className="text-[10px] font-medium text-teal-800">连接本实例</span>
            <span className="ml-auto text-[9px] text-teal-700">{pair ? '等待批准' : '未连接'}</span>
          </div>
          {pair ? (
            <div className="mt-1" data-testid="pair-pending">
              <div className="text-[10px] text-slate-600">把短码发给已授权管理员批准（10 分钟内有效）：</div>
              <div data-testid="pair-code" className="mt-1 font-mono text-lg font-bold tracking-[0.2em] text-teal-800">{pair.code}</div>
              <div className="text-[9px] text-slate-500">批准前不会注册任何账号；批准这一步由部署这个实例的人（你本人）在服务器本机点一次，见下方「本人独立部署」。</div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="pair-request"
              onClick={() => void handlePairRequest()}
              disabled={pairBusy}
              className="mt-1 w-full rounded-xl bg-teal-600 py-1.5 text-[10px] font-bold text-white disabled:opacity-50"
            >申请连接</button>
          )}
        </div>
      )}

      {/* 独立部署：这是用户自己的实例，owner 在本机初始化；不引导去找原作者或第三方。 */}
      <details data-testid="map-self-host" className="mt-2 rounded-xl bg-slate-50 px-2 py-1.5">
        <summary className="cursor-pointer text-[10px] font-bold text-slate-700">本人独立部署（这是你自己的实例）</summary>
        <div className="mt-1 space-y-1 text-[9px] leading-relaxed text-slate-600">
          <p>
            这个站点跑在你自己的机器或服务器上（当前域名 <span className="font-mono">{siteHost || SITE_HOST_FALLBACK}</span>），
            没有人替你托管，也不需要联系别人：地图凭据、本机连接和 owner 密钥都只属于这个实例。
          </p>
          <p>
            上面的「申请连接」同时是<b>多设备 / 新浏览器</b>的次入口。第一台设备由你（或帮你部署的 AI）在
            <b>服务器本机</b>批准一次，用的就是仓库里现成的脚本，不用装新东西：
          </p>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>在仓库目录看有哪些申请：<code className="font-mono">node scripts/travel-pair-admin.mjs list</code>（只输出 requestId 短前缀、状态、时间）。</li>
            <li>批准这次申请：<code className="font-mono">node scripts/travel-pair-admin.mjs approve &lt;requestId&gt; &lt;userId&gt;</code>；userId 就是本卡片展示的账号 ID，不是密钥；短码也别发到群里。</li>
            <li>批准后回到本页，几秒内自动连接（服务端只存 owner 密钥的哈希，认领时才在你浏览器里生成）。</li>
          </ol>
          <p>
            脚本只读本机数据库，没有公网入口，也不提供匿名自助注册；需要清理过期申请时用
            <code className="font-mono">purge</code>。完整步骤（主密钥、数据库路径、迁移旧 Key）见仓库文档
            <code className="font-mono">docs/travel-map-credentials.md</code> 的「本人独立部署」一节。
          </p>
        </div>
      </details>

      {/* 第一次填写顺序：用户「不会填」时的总入口。申请连接是本站自己的按钮，和高德无关。 */}
      <details data-testid="map-help-order" className="mt-2 rounded-xl bg-white/70 px-2 py-1.5">
        <summary className="cursor-pointer text-[10px] font-bold text-teal-800">第一次填写顺序（照着点就行）</summary>
        <ol className="mt-1 list-decimal space-y-1 pl-4 text-[9px] leading-relaxed text-slate-600">
          <li>
            <b>先点上面的「申请连接」</b>——这是本站自己的按钮，不用去高德找配对码。点完页面会出现一串
            <span className="font-mono"> XXXX-XXXX </span>短码，把这个短码连同页面已有的 userId 一起交给管理员批准。
          </li>
          <li>
            管理员批准一次即可；批准后<b>本浏览器会自动连接</b>，以后不用再输短码。短码过期就回来重新申请。
            <b> clientSecret、ownerKey、任何 API Key 都不要发到聊天、截图或群里。</b>
          </li>
          <li>
            填<b>「高德 Web 服务 Key」</b>：你之前做地点搜索用的那个 key 就是它，<b>已经有就直接复用，不用重新申请</b>。
            在高德控制台里，这个 key 所属应用的「服务平台」必须是<b>「Web服务」</b>；它负责地点搜索、地理编码、路线和静态图。
          </li>
          <li>
            填<b>「JS API Key」和「安全密钥 jscode」</b>：在<b>同一个应用</b>里再添加一个 key，服务平台选
            <b>「Web端(JS API)」</b>（官方文档写作 web 平台（JS API）），添加后把 key 和安全密钥（jscode）一起复制过来。
            正式域名白名单填 <span className="font-mono">{siteHost || SITE_HOST_FALLBACK}</span>（就是你此刻访问的这个域名，换域名后要回来改一次）。
          </li>
          <li>
            <b>Mapbox 只给国外用</b>：不做国外就留空，不影响国内。它不是必须项，也不用为了它去付费。
          </li>
          <li>填完点<b>「保存地图凭据」</b>。保存只写入、不发地图请求；要验证 key 是否能用，再点一次「测试连接（1 次）」。</li>
        </ol>
        <div className="mt-1 border-t border-slate-200/70 pt-1">
          <HelpLink href={TRAVEL_MAP_HELP_LINKS.amapConsole}>高德开放平台控制台 · 应用管理 → 我的应用（建应用、加 Key 都在这里）</HelpLink>
        </div>
      </details>

      <div className="mt-2 grid grid-cols-1 gap-1.5">
        <SecretRow testid="map-web-key" label="高德 Web 服务 Key" hint="地理编码 / POI / 路线 / 静态图，只在服务端使用"
          placeholder="粘贴 Web 服务 Key" value={webKey} has={!!cred?.has.amapWebKey}
          disabled={!known || busy} onChange={setWebKey} onClear={() => void writeCredentials({}, ['amapWebKey'])}
          help={(
            <MapHelp
              testid="map-web-key-help"
              steps={[
                <>你<b>已经有</b>这个 key 的话，直接粘它，<b>不用重新申请</b>（地点搜索/路线一直用的就是这把）。</>,
                <>控制台里这个 key 的「服务平台」要显示 <b>Web服务</b>；建 key 时下拉选错成 JS API 的，另建一个选「Web服务」即可。</>,
                <>输入框里<b>只粘贴 key 本身</b>（那串字母数字）：不要粘网站链接、应用名、整个 JSON 或带 <span className="font-mono">key=</span> 的地址。</>,
                <>也别把浏览器用的 JS Key 粘到这里——两种 Key 类型不能混用。</>,
                <>只用这一把 Key：地点搜索、地理编码、路线能用；地图画面还要下面两项。</>,
              ]}
              links={[
                { href: TRAVEL_MAP_HELP_LINKS.amapConsole, label: '打开高德控制台（我的应用）' },
                { href: TRAVEL_MAP_HELP_LINKS.amapWebServiceDoc, label: '官方说明：Web 服务 API 需要申请应用 Key' },
              ]}
            />
          )} />
        <SecretRow testid="map-js-key" label="高德 JS API Key（展示用）" hint="浏览器必需的公开展示 Key；记得在高德控制台配域名白名单"
          placeholder="粘贴 JS API Key" value={jsKey} has={!!cred?.has.amapJsKey}
          disabled={!known || busy} onChange={setJsKey} onClear={() => void writeCredentials({}, ['amapJsKey'])}
          help={(
            <MapHelp
              testid="map-js-key-help"
              steps={[
                <>在<b>同一个应用</b>里点「添加」新建一个 Key，「服务平台」选 <b>Web端(JS API)</b>（官方原文：web 平台（JS API））。</>,
                <>域名白名单填 <span className="font-mono">{siteHost || SITE_HOST_FALLBACK}</span>（当前访问的域名）；不要用 <span className="font-mono">*</span> 当正式配置。</>,
                <>复制的是这个 Key 本身，<b>不是</b>安全密钥、不是应用名、不是链接。</>,
                <>这个 Key 是<b>公开配置</b>：浏览器本来就要拿到它；真正需要保密的是下面的安全密钥。</>,
              ]}
              links={[
                { href: TRAVEL_MAP_HELP_LINKS.amapConsole, label: '打开高德控制台（我的应用 → 添加 Key）' },
                { href: TRAVEL_MAP_HELP_LINKS.amapJsApiPrepare, label: '官方教程：JS API 的 key 与安全密钥' },
              ]}
            />
          )} />
        <SecretRow testid="map-js-code" label="高德安全密钥 jscode" hint="只在服务端代理里注入；不会出现在页面、网址或日志里"
          placeholder="粘贴安全密钥" value={jsCode} has={!!cred?.has.amapJsCode}
          disabled={!known || busy} onChange={setJsCode} onClear={() => void writeCredentials({}, ['amapJsCode'])}
          help={(
            <MapHelp
              testid="map-js-code-help"
              steps={[
                <>在刚建好的 <b>Web端(JS API)</b> Key 同一行点「安全密钥」，复制 <span className="font-mono">jscode</span> 那串（控制台给的一次性密钥）。</>,
                <>官方要求它<b>配合同一个 JS API Key</b> 使用；填错 Key 的行就会对不上。</>,
                <>这里<b>保存在服务端</b>，由服务器代理注入，页面、网址、日志和备份里都看不到；它不是给浏览器公开的配置。</>,
                <>它和上面的 JS Key 是<b>两样东西</b>：Key 公开、jscode 保密，不要互相粘贴，也不要发到聊天里让人「帮你看」。</>,
              ]}
              links={[
                { href: TRAVEL_MAP_HELP_LINKS.amapConsole, label: '打开高德控制台（Key 同一行的「安全密钥」）' },
                { href: TRAVEL_MAP_HELP_LINKS.amapJsApiPrepare, label: '官方教程：安全密钥怎么用' },
              ]}
            />
          )} />
        <SecretRow testid="map-mapbox" label="Mapbox 公钥（可选，国外）" hint="pk. 开头的公钥；没有就不接国外底图"
          placeholder="pk.…" value={mapbox} has={!!cred?.has.mapboxToken}
          disabled={!known || busy} onChange={setMapbox} onClear={() => void writeCredentials({}, ['mapboxToken'])}
          help={(
            <MapHelp
              testid="map-mapbox-help"
              steps={[
                <><b>可选，只影响国外</b>：不做国外场景就留空，国内地点与路线照样能用，不需要为它付费。</>,
                <>要填就填 <b>pk. 开头</b>的公共 token；以 <span className="font-mono">sk.</span> 开头的是服务端私钥，不要粘进来，也不特地为它花钱。</>,
                <>额度与免费范围以 Mapbox 控制台当时条款为准——这边不承诺永久免费。</>,
              ]}
              links={[
                { href: TRAVEL_MAP_HELP_LINKS.mapboxTokens, label: 'Mapbox 官网 · Access tokens（登录你自己的账号）' },
              ]}
            />
          )} />
      </div>

      {legacyKey.trim() && !cred?.has.amapWebKey && (
        <button
          type="button"
          data-testid="map-migrate-legacy"
          onClick={() => void handleMigrateLegacy()}
          disabled={busy}
          className="mt-1 text-[9px] font-bold text-amber-700 underline"
        >迁移本机旧 Key（成功后清掉本地明文）</button>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          data-testid="map-save"
          onClick={() => void handleSave()}
          disabled={!known || busy}
          className="px-2.5 py-1 rounded-full text-[10px] text-white disabled:opacity-40"
          style={{ background: '#0f172a' }}
        >保存地图凭据</button>
        <button
          type="button"
          data-testid="map-test"
          onClick={async () => {
            setTesting(true);
            const res = await runtime.testMapConnection();
            setTesting(false);
            setNote(res.ok ? '连接正常（只打了这一次）' : `连接失败：${res.code}`);
          }}
          disabled={!known || busy || testing}
          className="px-2.5 py-1 rounded-full bg-slate-100 text-[10px] text-slate-600 disabled:opacity-40"
        >{testing ? '测试中…' : '测试连接（1 次）'}</button>
        {paired && <span className="ml-auto inline-flex items-center gap-1 text-[9px] text-emerald-600"><ShieldCheck size={10} weight="bold" />本机已连接</span>}
      </div>
      <div className="mt-1 text-[9px] leading-relaxed text-slate-500">
        保存只把凭据写进服务端，不发起真实地图请求，也不代表地图已经出图、或高德后台已开通对应权限。
        「测试连接」每次点击会真的打一次（30 秒冷却），可能消耗高德额度，但不扣出行额度。
        只填 Web 服务 Key 时：地点搜索、地理编码、路线可用；地图画面还缺 JS Key 与安全密钥，会提示。
      </div>
      {note && <div data-testid="map-service-note" className="mt-1 text-[9px] text-slate-600">{note}</div>}
    </div>
  );
};

export default TravelMapServiceCard;
