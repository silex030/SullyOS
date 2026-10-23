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

export interface TravelMapServiceCardProps {
  runtime?: TravelRuntime;
  /** 本机实时感知里遗留的 Web 服务 Key（只用于用户显式迁移，不自动写入）。 */
  legacyKey?: string;
  onLegacyMigrated?: () => void;
  className?: string;
}

const SecretRow: React.FC<{
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
);

const TravelMapServiceCard: React.FC<TravelMapServiceCardProps> = ({
  runtime: injected,
  legacyKey = '',
  onLegacyMigrated,
  className = '',
}) => {
  const runtime = injected ?? getTravelRuntime();
  const [cred, setCred] = useState<TravelMapCredentialView | null>(null);
  const [known, setKnown] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
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
    const res = await runtime.readMapCredentials();
    setKnown(res.known);
    setCred(res.known ? res.credentials : null);
    setCredError(res.known ? null : res.error ?? 'UNKNOWN');
  }, [runtime]);

  useEffect(() => { void loadCredentials(); }, [loadCredentials]);

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
    setCred(res.credentials ?? null);
    setKnown(!!res.credentials);
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
        <span className="ml-auto text-[9px] text-slate-500">
          {!known ? '未确认' : cred?.configured ? '已加密保存' : '未配置'}
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
            <span className="text-[10px] font-medium text-teal-800">首次连接</span>
            <span className="ml-auto text-[9px] text-teal-700">{pair ? '等待管理员批准' : '未连接'}</span>
          </div>
          {pair ? (
            <div className="mt-1" data-testid="pair-pending">
              <div className="text-[10px] text-slate-600">把短码发给已授权管理员批准（10 分钟内有效）：</div>
              <div data-testid="pair-code" className="mt-1 font-mono text-lg font-bold tracking-[0.2em] text-teal-800">{pair.code}</div>
              <div className="text-[9px] text-slate-500">批准前不会注册任何账号，也不需要你登录服务器或找文件。</div>
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

      <div className="mt-2 grid grid-cols-1 gap-1.5">
        <SecretRow testid="map-web-key" label="高德 Web 服务 Key" hint="地理编码 / POI / 路线 / 静态图，只在服务端使用"
          placeholder="粘贴 Web 服务 Key" value={webKey} has={!!cred?.has.amapWebKey}
          disabled={!known || busy} onChange={setWebKey} onClear={() => void writeCredentials({}, ['amapWebKey'])} />
        <SecretRow testid="map-js-key" label="高德 JS API Key（展示用）" hint="浏览器必需的公开展示 Key；记得在高德控制台配域名白名单"
          placeholder="粘贴 JS API Key" value={jsKey} has={!!cred?.has.amapJsKey}
          disabled={!known || busy} onChange={setJsKey} onClear={() => void writeCredentials({}, ['amapJsKey'])} />
        <SecretRow testid="map-js-code" label="高德安全密钥 jscode" hint="只在服务端代理里注入；不会出现在页面、网址或日志里"
          placeholder="粘贴安全密钥" value={jsCode} has={!!cred?.has.amapJsCode}
          disabled={!known || busy} onChange={setJsCode} onClear={() => void writeCredentials({}, ['amapJsCode'])} />
        <SecretRow testid="map-mapbox" label="Mapbox 公钥（可选，国外）" hint="pk. 开头的公钥；没有就不接国外底图"
          placeholder="pk.…" value={mapbox} has={!!cred?.has.mapboxToken}
          disabled={!known || busy} onChange={setMapbox} onClear={() => void writeCredentials({}, ['mapboxToken'])} />
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
        保存本身不发起真实地图请求；「测试连接」每次点击只打一次（30 秒冷却），不扣出行额度。
      </div>
      {note && <div data-testid="map-service-note" className="mt-1 text-[9px] text-slate-600">{note}</div>}
    </div>
  );
};

export default TravelMapServiceCard;
