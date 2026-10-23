import React, { useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { getCurrentPositionSmart } from '../../utils/geo';
import {
    fetchInputTips,
    geocodeCity,
    isAmapAuthReady,
    regeoCity,
    type AmapAuth,
    type AmapInputTip,
} from '../../utils/amapCore';
import { resolveAmapAuth } from '../../utils/cityPlaces';

/**
 * 用户档案「所在城市」卡。
 *
 * 隐私只到城市级：GPS 定位回来经逆地理只取省/市（区县街道直接丢弃），
 * prompt 里的「用户那边」段也只出现城市名 + 城市级天气。
 */
const UserCityCard: React.FC = () => {
    const { userProfile, updateUserProfile, addToast } = useOS();
    const [locating, setLocating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [input, setInput] = useState('');
    const [tips, setTips] = useState<AmapInputTip[]>([]);
    const [tipOpen, setTipOpen] = useState(false);
    const debounceRef = useRef<number | null>(null);

    const loc = userProfile.location;
    // 凭证唯一来源：服务端加密保存的 Web 服务 Key，经出行会话的 REST 中转取数。
    // 本机 localStorage 旧 Key 不再是消费来源（只作设置页的迁移输入）。
    const [auth, setAuth] = useState<AmapAuth | null>(null);
    useEffect(() => {
        let alive = true;
        void resolveAmapAuth()
            .then((a) => { if (alive) setAuth(a); })
            .catch(() => { if (alive) setAuth(null); });
        return () => { alive = false; };
    }, []);
    const ready = isAmapAuthReady(auth);

    const saveCity = (province: string | undefined, city: string, source: 'gps' | 'user') => {
        updateUserProfile({
            location: {
                ...(province && province !== city ? { province } : {}),
                city,
                source,
                updatedAt: Date.now(),
            },
        });
    };

    // GPS → 逆地理 → 只留省市
    const handleGps = async () => {
        if (!ready || !auth) {
            addToast('先去「设置 → 实时感知」完成地图服务连接，定位才能解析成城市', 'error');
            return;
        }
        setLocating(true);
        try {
            const pos = await getCurrentPositionSmart();
            const place = await regeoCity(pos.latitude, pos.longitude, auth);
            if (!place) {
                addToast('定位成功，但没能解析出城市', 'error');
                return;
            }
            saveCity(place.province, place.city, 'gps');
            setInput('');
            addToast(`已定位到${place.province && place.province !== place.city ? `${place.province} ` : ''}${place.city}（只记城市）`, 'success');
        } catch (e: any) {
            addToast(e?.message || '定位失败', 'error');
        } finally {
            setLocating(false);
        }
    };

    const confirmInput = async () => {
        const name = input.trim();
        if (!name) return;
        // 没有可用凭证：原样存城市名；有凭证：地理编码验成标准省市
        if (!ready || !auth) {
            saveCity(undefined, name, 'user');
            setInput('');
            setTipOpen(false);
            addToast(`所在城市已设为${name}`, 'success');
            return;
        }
        setSaving(true);
        try {
            const place = await geocodeCity(name, auth);
            if (!place) {
                addToast(`高德找不到「${name}」，换个写法试试`, 'error');
                return;
            }
            saveCity(place.province, place.city, 'user');
            setInput('');
            setTips([]);
            setTipOpen(false);
            addToast(`所在城市已设为${place.province && place.province !== place.city ? `${place.province} ` : ''}${place.city}`, 'success');
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        } finally {
            setSaving(false);
        }
    };

    const onInputChange = (v: string) => {
        setInput(v);
        setTipOpen(true);
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        if (!ready || !auth || v.trim().length < 1) {
            setTips([]);
            return;
        }
        debounceRef.current = window.setTimeout(async () => {
            try {
                setTips(await fetchInputTips(v.trim(), auth));
            } catch {
                setTips([]);
            }
        }, 350);
    };

    // 选中联想项：用它的坐标反查出所在城市（联想项本身可能是具体 POI）
    const pickTip = async (t: AmapInputTip) => {
        setTipOpen(false);
        setTips([]);
        if (t.lat == null || t.lng == null || !auth) {
            setInput(t.name);
            return;
        }
        setSaving(true);
        try {
            const place = await regeoCity(t.lat, t.lng, auth);
            if (!place) {
                setInput(t.name);
                return;
            }
            saveCity(place.province, place.city, 'user');
            setInput('');
            addToast(`所在城市已设为${place.province && place.province !== place.city ? `${place.province} ` : ''}${place.city}`, 'success');
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        } finally {
            setSaving(false);
        }
    };

    const clearCity = () => {
        updateUserProfile({ location: undefined });
        addToast('已清除所在城市，角色不再感知「用户那边」', 'success');
    };

    return (
        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5">
            <div className="flex items-center gap-2 mb-1">
                <span className="w-7 h-7 rounded-xl bg-teal-100 text-teal-600 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                    </svg>
                </span>
                <h2 className="text-sm font-bold text-slate-700">所在城市</h2>
                {loc && (
                    <span className="ml-auto text-[10px] font-bold text-teal-600 bg-teal-50 rounded-full px-2 py-0.5 shrink-0">
                        {loc.source === 'gps' ? 'GPS 定位' : '手动填写'}
                    </span>
                )}
            </div>
            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                {loc
                    ? `当前：${loc.province ? `${loc.province} ` : ''}${loc.city}。角色能在聊天里感知到你那边的天气（只到城市级）。`
                    : '还没设置。角色需要知道你在哪座城市，才能感知「用户那边」的天气。只记城市，不存精确位置。'}
            </p>
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <input
                        value={input}
                        onChange={(e) => onInputChange(e.target.value)}
                        onFocus={() => { if (tips.length > 0) setTipOpen(true); }}
                        onBlur={() => window.setTimeout(() => setTipOpen(false), 150)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void confirmInput(); }}
                        className="w-full bg-slate-50 focus:bg-white border border-slate-100 focus:border-teal-300 rounded-2xl px-4 py-2.5 text-sm text-slate-700 outline-none transition-all placeholder:text-slate-300"
                        placeholder="如：上海"
                    />
                    {tipOpen && tips.length > 0 && (
                        <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-100 rounded-2xl shadow-lg overflow-hidden z-10 max-h-44 overflow-y-auto">
                            {tips.slice(0, 6).map((t, i) => (
                                <button
                                    key={`${t.name}-${i}`}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => void pickTip(t)}
                                    className="w-full text-left px-4 py-2 text-xs text-slate-600 hover:bg-teal-50 active:bg-teal-100 transition-colors"
                                >
                                    <span className="font-bold">{t.name}</span>
                                    {t.district && <span className="text-slate-400 ml-1">{t.district}</span>}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                <button
                    onClick={() => void confirmInput()}
                    disabled={saving || !input.trim()}
                    className="px-4 py-2.5 bg-teal-500 text-white text-xs font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40 shrink-0"
                >
                    {saving ? '保存中…' : '设为所在城市'}
                </button>
            </div>
            <div className="flex gap-2 mt-2">
                <button
                    onClick={() => void handleGps()}
                    disabled={locating}
                    className="flex-1 py-2.5 bg-teal-100 text-teal-600 text-xs font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40"
                >
                    {locating ? '定位中…' : 'GPS 定位（只记城市）'}
                </button>
                {loc && (
                    <button
                        onClick={clearCity}
                        className="px-4 py-2.5 bg-slate-100 text-slate-400 text-xs font-bold rounded-2xl active:scale-95 transition-transform shrink-0"
                    >
                        清除
                    </button>
                )}
            </div>
            {!ready && (
                <p className="text-[10px] text-amber-500 mt-2 leading-relaxed">地图服务未连接：可手填城市名，GPS 定位与联想不可用（去「设置 → 实时感知」完成连接）。</p>
            )}
        </div>
    );
};

export default UserCityCard;
