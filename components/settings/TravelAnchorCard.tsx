/**
 * 固定地点确认卡（B6）
 *
 * 两个地址必须分清，不能混成"当前位置"：
 * - **用户固定住处 / 常去地点**：在本卡里手动确认，落服务端锚点（小区级 `precision:'area'`）；
 * - **角色当前模拟位置**：只由行程状态机推进，本卡不写、不取。
 *
 * 硬约束：不读 `navigator.geolocation`、不要门牌/楼栋/单元/房号（输入侧用契约的
 * `sanitizeAnchorLabel` 先拦），搜索与落库都走服务端（地图 Web 服务 Key 不下发前端）。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { CheckCircle, MagnifyingGlass, MapPin } from '@phosphor-icons/react';
import { sanitizeAnchorLabel } from '../../utils/travel/core';
import type { TravelAnchorCandidate, TravelRuntime } from '../../utils/travel/runtime';

export interface TravelAnchorCardProps {
    runtime: TravelRuntime;
    disabled?: boolean;
    onConfirmed?: () => void;
    className?: string;
}

const TravelAnchorCard: React.FC<TravelAnchorCardProps> = ({ runtime, disabled = false, onConfirmed, className = '' }) => {
    const [label, setLabel] = useState('');
    const [city, setCity] = useState('');
    const [district, setDistrict] = useState('');
    const [results, setResults] = useState<TravelAnchorCandidate[] | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const labelCheck = useMemo(() => (label.trim() ? sanitizeAnchorLabel(label.trim()) : null), [label]);

    const handleSearch = useCallback(async () => {
        const check = sanitizeAnchorLabel(label.trim());
        if (!check.ok) {
            setMessage('只填到小区或公共地点名，不要写楼栋、单元、房号');
            setResults(null);
            return;
        }
        setBusy(true);
        setMessage(null);
        // 文本检索是城市内检索：带上用户填的城市，服务端不会用城市中心冒充结果。
        if (!city.trim()) {
            setResults(null);
            setMessage('先填城市，再搜索公共地点');
            return;
        }
        const res = await runtime.searchAnchor(check.label, city.trim());
        setBusy(false);
        if (!res.ok) {
            // 搜索服务未就绪（后端 / 地图 Web 服务 Key 在服务端）——如实说，不编候选。
            setResults(null);
            setMessage(res.code === 'UNAUTHORIZED' ? '登录已失效，先重新登录' : '地址搜索暂不可用，稍后再试');
            return;
        }
        setResults(res.data ?? []);
        if ((res.data ?? []).length === 0) setMessage('没搜到公共地点，换个说法试试');
    }, [runtime, label, city]);

    const handleConfirm = useCallback(
        async (candidate: TravelAnchorCandidate) => {
            if (!candidate.placeId) {
                setMessage('这个候选缺少服务端地点标识，不能确认');
                return;
            }
            setBusy(true);
            const res = await runtime.confirmAnchorCandidate(candidate.placeId, {
                label: candidate.label,
                city: candidate.city,
                district: candidate.district,
            });
            setBusy(false);
            if (!res.ok) {
                setMessage(res.code === 'VERSION_CONFLICT' ? '状态已被其他设备更新，刷新后再试' : '确认失败，稍后再试');
                return;
            }
            setMessage('已确认这个固定地点');
            setResults(null);
            onConfirmed?.();
        },
        [runtime, onConfirmed],
    );

    return (
        <div
            data-testid="travel-anchor-card"
            className={`rounded-2xl px-3 py-3 ${className}`}
            style={{ background: '#ffffff', border: '1px solid rgba(226,232,240,0.9)' }}
        >
            <div className="flex items-center gap-1.5">
                <MapPin size={13} weight="bold" className="text-slate-500" aria-hidden />
                <span className="text-[12px] font-medium text-slate-800">固定地点（用户住处 / 常去地点）</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                先填城市，再搜小区或公共地点并点「确认」；只填到小区或公共地点名，不填门牌、楼栋、单元、房号。这是你确认的固定地址，不是设备定位，也不是角色当前在哪。
            </p>

            <div className="mt-2 space-y-1.5">
                <input
                    data-testid="travel-anchor-label"
                    value={label}
                    disabled={disabled || busy}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="小区 / 公共地点名，例如 阳光花园"
                    className="w-full rounded-xl px-2.5 py-1.5 text-[11px] text-slate-700 outline-none"
                    style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                />
                <div className="flex gap-1.5">
                    <input
                        data-testid="travel-anchor-city"
                        value={city}
                        disabled={disabled || busy}
                        onChange={(e) => setCity(e.target.value)}
                        placeholder="城市"
                        className="flex-1 rounded-xl px-2.5 py-1.5 text-[11px] text-slate-700 outline-none"
                        style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                    />
                    <input
                        data-testid="travel-anchor-district"
                        value={district}
                        disabled={disabled || busy}
                        onChange={(e) => setDistrict(e.target.value)}
                        placeholder="区（可选）"
                        className="flex-1 rounded-xl px-2.5 py-1.5 text-[11px] text-slate-700 outline-none"
                        style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.9)' }}
                    />
                </div>
                {labelCheck && !labelCheck.ok && (
                    <div data-testid="travel-anchor-rejected" className="text-[10px] text-rose-600">
                        {labelCheck.message}
                    </div>
                )}
            </div>

            <button
                data-testid="travel-anchor-search"
                disabled={disabled || busy || !label.trim()}
                onClick={() => void handleSearch()}
                className="mt-2 flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium text-slate-700 active:scale-95 transition-transform disabled:opacity-50"
                style={{ background: 'rgba(241,245,249,0.95)', border: '1px solid rgba(226,232,240,0.9)' }}
            >
                <MagnifyingGlass size={11} weight="bold" aria-hidden />
                搜索公共地点
            </button>

            {message && (
                <div data-testid="travel-anchor-message" className="mt-1.5 text-[10px] text-slate-500">
                    {message}
                </div>
            )}

            {results && results.length > 0 && (
                <ul className="mt-2 space-y-1">
                    {results.map((c, i) => (
                        <li
                            key={`${c.placeId ?? c.label}-${i}`}
                            className="flex items-center gap-1.5 rounded-xl px-2 py-1.5"
                            style={{ background: '#f8fafc', border: '1px solid rgba(226,232,240,0.7)' }}
                        >
                            <span className="flex-1 min-w-0 text-[11px] text-slate-700 truncate">
                                {c.label}
                                <span className="ml-1 text-[9px] text-slate-500">
                                    {[c.city, c.district].filter(Boolean).join(' · ')}
                                </span>
                            </span>
                            <button
                                data-testid="travel-anchor-confirm"
                                onClick={() => void handleConfirm(c)}
                                className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] text-emerald-700 active:scale-95 transition-transform"
                                style={{ background: 'rgba(16,185,129,0.12)' }}
                            >
                                <CheckCircle size={9} weight="bold" aria-hidden />
                                确认
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default TravelAnchorCard;
