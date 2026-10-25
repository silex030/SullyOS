/**
 * 真实感知能力注册表 —— 设置页「实时感知」区块的单一事实源。
 *
 * 新增能力（如透视窗）在这里登记一行，宫格与简介文案自动渲染，不再往
 * Settings.tsx 硬拷 UI：有则显示，无则不体现；已启用但没配好凭据时灰态
 * 显示「未配置」而不是装作正常。
 *
 * 宫格不渲染任何图标（iconKey 已废弃，仅保留字段避免老引用报错）；
 * 颜色高亮只在「启用且已配置」时出现，停用/未配置统一灰态（tintIdle），
 * 不得给停用项留彩色底（透视窗曾因 tintIdle 带青色调被误读为已启用）。
 */
import type { RealtimeConfig } from '../types';
import { bleEngine } from './bleEngine';

export interface PerceptionCapability {
    id: string;
    label: string;
    /** 一句话说明（宫格 title 与状态摘要共用） */
    description: string;
    /** 启用且配置好时的配色（Tailwind class 串） */
    tint: string;
    /** 停用/未配置时的灰态配色 */
    tintIdle: string;
    enabled: (rc: RealtimeConfig) => boolean;
    /** 必备凭据/参数是否已填齐（开着但没填齐 => pending 灰态） */
    configured: (rc: RealtimeConfig) => boolean;
    /**
     * 该能力的就绪不来自 RealtimeConfig，而由调用方注入（地图：凭据在服务端按账号加密）。
     * 有这一项的能力，`enabled/configured` 不参与判定，必须传 readiness。
     */
    externalReadiness?: 'map';
    iconKey?: 'binoculars';
}

export const PERCEPTION_CAPABILITIES: PerceptionCapability[] = [
    {
        id: 'weather',
        label: '天气',
        description: '角色所在城市的实时天气（Open-Meteo / OpenWeatherMap）',
        tint: 'bg-emerald-50 text-emerald-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        enabled: (rc) => !!rc.weatherEnabled,
        configured: (rc) => !!(rc.weatherCity && rc.weatherCity.trim()),
    },
    {
        // 地图以前不在这张表里 —— 宫格物理上不可能出现它，所以「灰态缺失」不是样式问题，
        // 是登记缺失：设置页只能看到卡片，看不到父层任何状态。
        id: 'map',
        label: '地图',
        description: '真实地点与地图底图（高德 amap / Mapbox；凭据存服务端，不存本机）',
        tint: 'bg-teal-50 text-teal-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        // 账号级服务：没有「角色级开关」这种真实语义，不造假开关；恒为可进入配置。
        enabled: () => true,
        // 就绪恒为 false —— 唯一权威是注入的 externalReadiness（见 utils/travel/mapReadiness.ts）。
        configured: () => false,
        externalReadiness: 'map',
    },
    {
        id: 'news',
        label: '新闻',
        description: '全网新闻热搜热点（多平台聚合）',
        tint: 'bg-blue-50 text-blue-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        enabled: (rc) => !!rc.newsEnabled,
        configured: () => true, // 免 key 可用
    },
    {
        id: 'notion',
        label: 'Notion',
        description: 'Notion 日记本（读取日记与笔记）',
        tint: 'bg-orange-50 text-orange-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        enabled: (rc) => !!rc.notionEnabled,
        configured: (rc) => !!(rc.notionApiKey?.trim() && rc.notionDatabaseId?.trim()),
    },
    {
        id: 'feishu',
        label: '飞书',
        description: '飞书多维表格（日程与记录同步）',
        tint: 'bg-indigo-50 text-indigo-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        enabled: (rc) => !!rc.feishuEnabled,
        configured: (rc) => !!(rc.feishuAppId?.trim() && rc.feishuAppSecret?.trim() && rc.feishuBaseId?.trim()),
    },
    {
        id: 'xhs',
        label: '小红书',
        description: '小红书搜索（Lite 桥 / 自建 MCP）',
        tint: 'bg-red-50 text-red-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        enabled: (rc) => !!rc.xhsEnabled,
        configured: () => true, // Lite 模式无需额外配置
    },
    {
        id: 'perspective',
        label: '透视窗',
        description: '角色查看你的真实操作轨迹（Supabase 事件流）',
        tint: 'bg-cyan-50 text-cyan-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        enabled: (rc) => !!rc.perspectiveEnabled,
        configured: (rc) => !!(rc.perspectiveSupabaseUrl?.trim() && rc.perspectiveSupabaseAnonKey?.trim()),
        iconKey: 'binoculars',
    },
    {
        id: 'bluetooth',
        label: '蓝牙设备',
        description: '手机蓝牙连接的外设与可用指令（Web Bluetooth）',
        tint: 'bg-sky-50 text-sky-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        enabled: (rc) => rc.bluetoothEnabled !== false,
        configured: () => bleEngine.hasConnectedDevice(),
    },
    {
        id: 'google',
        label: 'Google 日历',
        description: 'Google 日历事件、待办与节假日（char 可感知与主动创建）',
        tint: 'bg-sky-50 text-sky-600',
        tintIdle: 'bg-slate-50 text-slate-400',
        // Google 的配置存在 localStorage（aetheros.google.*），不进 realtimeConfig：
        // 凭据由 VPS 桥保管，前端只存开关与勾选的日历。
        enabled: () => {
            try { return localStorage.getItem('aetheros.google.enabled') === '1'; } catch { return false; }
        },
        configured: () => {
            try {
                const selected = JSON.parse(localStorage.getItem('aetheros.google.selectedCalendars') || '[]');
                return Array.isArray(selected) && selected.length > 0;
            } catch { return false; }
        },
    },
];

/** 宫格渲染态：on=启用且已配置；off=停用；pending=开着但没配好（灰态提示「未配置」） */
export type PerceptionRenderState = 'on' | 'off' | 'pending';

/** 外部就绪注入（地图专用）：known=false 表示「没读到」，不能算就绪也不能算未配置。 */
export interface PerceptionExternalReadiness {
    known: boolean;
    ready: boolean;
}

export const perceptionRenderState = (
    cap: PerceptionCapability,
    rc: RealtimeConfig,
    readiness?: PerceptionExternalReadiness,
): PerceptionRenderState => {
    if (cap.externalReadiness) {
        // 读不到 / 部分就绪 / 未配置一律灰态；只有两类凭据都齐才是 on。
        return readiness?.known === true && readiness.ready === true ? 'on' : 'pending';
    }
    return !cap.enabled(rc) ? 'off' : cap.configured(rc) ? 'on' : 'pending';
};
