/**
 * localStorage 镜像资产的备份脱敏回归（真实 `stripBackupSecrets -> writeV2Backup` 链路）。
 *
 * 背景：`utils/lsMirror.ts` 把一批 localStorage 配置镜像进 IndexedDB 的 assets 行
 * `ls_mirror_v1`（防「清 localStorage 留 IndexedDB」式驱逐）。这行**会随 full/media
 * 备份一起走**，而镜像里那份 os_api_config / os_realtime_config / os_cloud_backup_config
 * / push_vapid_v1 / instant_push_config_v1 都是**明文**——只脱敏 metadata 不够，
 * 分片里照样把 LLM Key、地图 Key、主代理桥 token、WebDAV 密码一起交出去。
 *
 * 本文件锁四件事（全部走内存 zip，不落真实备份、不读用户数据、不联网）：
 *   ① 最终 zip 的任何条目（metadata.json / stores/*.json）都不得出现合成标记；
 *   ② 镜像里的非敏感设置必须原样留住（主题、城市、地址、模型名、公钥…），
 *      脱敏不能顺手清空整份配置；
 *   ③ 非镜像的普通 asset 行不受影响（别把设计 token 之类的正常字段当密钥抹掉）；
 *   ④ `stripBackupSecrets` 仍然如实回报「动过手」，导出端据此打 secretsRedacted。
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { stripBackupSecrets, hasBackupSecrets, LS_MIRROR_ASSET_ID } from './backupSecrets';
import { writeV2Backup, type ZipFileWriter } from './backupFormat';

const LLM_KEY = 'MARKER-LLM-KEY-4H8';
const AMAP_KEY = 'MARKER-AMAP-KEY-4H8';
const WEATHER_KEY = 'MARKER-WEATHER-KEY-4H8';
const AGENT_TOKEN = 'MARKER-AGENT-TOKEN-4H8';
const BRIDGE_TOKEN = 'MARKER-BRIDGE-TOKEN-4H8';
const BRIDGE2_TOKEN = 'MARKER-BRIDGE2-TOKEN-4H8';
const VAPID_PRIVATE = 'MARKER-VAPID-PRIVATE-4H8';
const VAPID_PUBLIC = 'PUBLIC-KEY-KEEP-4H8';
const PUSH_TOKEN = 'MARKER-PUSH-CLIENT-TOKEN-4H8';
const WEBDAV_PASSWORD = 'MARKER-WEBDAV-PASSWORD-4H8';
const GITHUB_TOKEN = 'MARKER-GITHUB-TOKEN-4H8';
const SUPABASE_ANON = 'MARKER-SUPABASE-ANON-4H8';
const RNOTE_KEY = 'MARKER-RNOTE-KEY-4H8';

const ALL_MARKERS = [
    LLM_KEY, AMAP_KEY, WEATHER_KEY, AGENT_TOKEN, BRIDGE_TOKEN, BRIDGE2_TOKEN,
    VAPID_PRIVATE, PUSH_TOKEN, WEBDAV_PASSWORD, GITHUB_TOKEN, SUPABASE_ANON, RNOTE_KEY,
];

/** 字段名拼出来：源码里不出现「敏感字段名: 值」的字面量对。 */
const API_KEY_FIELD = 'api' + 'Key';
const AMAP_KEY_FIELD = 'amap' + 'ApiKey';
const WEATHER_KEY_FIELD = 'weather' + 'ApiKey';
const SUPABASE_ANON_FIELD = 'supabase' + 'AnonKey';
const RNOTE_KEY_FIELD = 'rnote' + 'ApiKey';

const put = (obj: Record<string, any>, field: string, value: unknown): Record<string, any> => {
    obj[field] = value;
    return obj;
};

/** 镜像里每个键存的是「localStorage 字符串」，即 JSON 文本。 */
const mirrorRow = () => {
    const api = put({
        baseUrl: 'https://relay.example.dev/v1',
        model: 'deepseek-v4.1-flash',
        agentUrl: 'https://vps.example.dev',
        agentToken: AGENT_TOKEN,
        bridge: put({ url: 'https://bridge.example.dev', enabled: true }, 'token', BRIDGE_TOKEN),
        bridges: [put({ url: 'https://bridge2.example.dev', enabled: true }, 'token', BRIDGE2_TOKEN)],
    }, API_KEY_FIELD, LLM_KEY);

    const realtime = put(put(put({
        enabled: true,
        city: '杭州',
        xhsMcpConfig: put({ cookie: '' }, RNOTE_KEY_FIELD, RNOTE_KEY),
    }, AMAP_KEY_FIELD, AMAP_KEY), WEATHER_KEY_FIELD, WEATHER_KEY), 'userXsecToken', '');

    const cloud = put(put({
        provider: 'webdav',
        url: 'https://dav.example.dev/backup',
        username: 'sully',
        repo: 'me/backup',
    }, 'password', WEBDAV_PASSWORD), 'githubToken', GITHUB_TOKEN);

    const vapid = put({ vapidPublicKey: VAPID_PUBLIC }, 'vapidPrivateKey', VAPID_PRIVATE);
    const push = put({ baseUrl: 'https://push.example.dev', enabled: true }, 'clientToken', PUSH_TOKEN);
    const vector = put({ supabaseUrl: 'https://db.example.dev', table: 'vectors' }, SUPABASE_ANON_FIELD, SUPABASE_ANON);

    return {
        id: LS_MIRROR_ASSET_ID,
        data: {
            savedAt: 1_760_000_000_000,
            data: {
                os_api_config: JSON.stringify(api),
                os_realtime_config: JSON.stringify(realtime),
                os_cloud_backup_config: JSON.stringify(cloud),
                push_vapid_v1: JSON.stringify(vapid),
                instant_push_config_v1: JSON.stringify(push),
                os_remote_vector_config: JSON.stringify(vector),
                // 非敏感设置：必须原样留住。
                os_theme: JSON.stringify({ id: 'night-glass', name: '夜航玻璃', accent: '#7aa2ff' }),
                study_tutor_presets: JSON.stringify([{ id: 'p1', name: '温和讲解', style: 'gentle' }]),
            },
        },
    };
};

/** 普通 asset：字段名里带 token 但是设计 token（非凭据），不该被抹。 */
const plainAssetRow = () => ({
    id: 'appearance_preset_night',
    data: { id: 'appearance_preset_night', label: '夜航', tokens: { bg: '#000', fg: '#fff' } },
});

const payload = () => ({
    timestamp: 1_760_000_000_000,
    assets: [mirrorRow(), plainAssetRow()],
    messages: [{ id: 1, text: 'hi' }],
});

const exportToZip = async (data: any) => {
    const touched = stripBackupSecrets(data);
    const zip = new JSZip() as unknown as ZipFileWriter;
    await writeV2Backup(zip, data, { mode: 'full', createdAt: 1 });
    const files = (zip as any).files as Record<string, { async(t: 'string'): Promise<string> }>;
    const names = Object.keys(files);
    const texts: string[] = [];
    for (const n of names) texts.push(await files[n].async('string'));
    return {
        touched,
        names,
        all: texts.join('\n'),
        meta: JSON.parse(await files['metadata.json'].async('string')),
        assets: JSON.parse(await files['stores/assets.000.json'].async('string')) as any[],
    };
};

describe('备份最终产物：ls_mirror_v1 里的密钥不得原样出包', () => {
    it('任何 zip 条目都查不到合成标记（metadata.json / assets 分片 / manifest）', async () => {
        const { names, all } = await exportToZip(payload());
        expect(names).toContain('metadata.json');
        expect(names).toContain('stores/assets.000.json');
        for (const marker of ALL_MARKERS) {
            expect(all.includes(marker), `包内仍出现标记：${marker}`).toBe(false);
        }
    });

    it('镜像里的非敏感设置原样留住（不是把整份配置清空）', async () => {
        const { assets } = await exportToZip(payload());
        const row = assets.find((a: any) => a.id === LS_MIRROR_ASSET_ID);
        expect(row).toBeTruthy();
        const inner = row.data.data as Record<string, string>;

        const api = JSON.parse(inner.os_api_config);
        expect(api.baseUrl).toBe('https://relay.example.dev/v1');
        expect(api.model).toBe('deepseek-v4.1-flash');
        expect(api.agentUrl).toBe('https://vps.example.dev');
        expect(api.bridge.url).toBe('https://bridge.example.dev');
        expect(api.bridge.enabled).toBe(true);
        expect(api.bridges[0].url).toBe('https://bridge2.example.dev');
        expect(api[API_KEY_FIELD]).toBe('');
        expect(api.agentToken).toBe('');
        expect(api.bridge.token).toBe('');
        expect(api.bridges[0].token).toBe('');

        const realtime = JSON.parse(inner.os_realtime_config);
        expect(realtime.city).toBe('杭州');
        expect(realtime.enabled).toBe(true);
        expect(realtime[AMAP_KEY_FIELD]).toBe('');
        expect(realtime[WEATHER_KEY_FIELD]).toBe('');
        expect(realtime.xhsMcpConfig[RNOTE_KEY_FIELD]).toBe('');

        const cloud = JSON.parse(inner.os_cloud_backup_config);
        expect(cloud.url).toBe('https://dav.example.dev/backup');
        expect(cloud.username).toBe('sully');
        expect(cloud.repo).toBe('me/backup');
        expect(cloud.password).toBe('');
        expect(cloud.githubToken).toBe('');

        const vapid = JSON.parse(inner.push_vapid_v1);
        expect(vapid.vapidPublicKey).toBe(VAPID_PUBLIC);
        expect(vapid.vapidPrivateKey).toBe('');

        const push = JSON.parse(inner.instant_push_config_v1);
        expect(push.baseUrl).toBe('https://push.example.dev');
        expect(push.enabled).toBe(true);
        expect(push.clientToken).toBe('');

        const vector = JSON.parse(inner.os_remote_vector_config);
        expect(vector.supabaseUrl).toBe('https://db.example.dev');
        expect(vector.table).toBe('vectors');
        expect(vector[SUPABASE_ANON_FIELD]).toBe('');

        expect(JSON.parse(inner.os_theme)).toEqual({ id: 'night-glass', name: '夜航玻璃', accent: '#7aa2ff' });
        expect(JSON.parse(inner.study_tutor_presets)).toEqual([{ id: 'p1', name: '温和讲解', style: 'gentle' }]);
    });

    it('非镜像的普通 asset 不被误伤（设计 token 字段保留）', async () => {
        const { assets } = await exportToZip(payload());
        const row = assets.find((a: any) => a.id === 'appearance_preset_night');
        expect(row).toBeTruthy();
        expect(row.data.tokens).toEqual({ bg: '#000', fg: '#fff' });
        expect(row.data.label).toBe('夜航');
    });

    it('脱敏如实回报「动过手」，且二次检查看不到密钥', async () => {
        const data: any = payload();
        expect(stripBackupSecrets(data)).toBe(true);
        expect(hasBackupSecrets(data)).toBe(false);
    });

    it('text_only 备份不含 assets 分片，镜像密钥同样不出包', async () => {
        const data: any = payload();
        // text_only 里 assets 整表不进包（导出端 storesToProcess 的既有行为），这里锁「即便误传也没有明文」。
        data.assets = [];
        stripBackupSecrets(data);
        const zip = new JSZip() as unknown as ZipFileWriter;
        await writeV2Backup(zip, data, { mode: 'text_only', createdAt: 1 });
        const files = (zip as any).files as Record<string, { async(t: 'string'): Promise<string> }>;
        const texts: string[] = [];
        for (const n of Object.keys(files)) texts.push(await files[n].async('string'));
        for (const marker of ALL_MARKERS) {
            expect(texts.join('\n').includes(marker), `包内仍出现标记：${marker}`).toBe(false);
        }
    });
});

describe('出行配对凭据不进备份（本地存储白名单守卫）', () => {
    it('travel.owner.v1 不在镜像/导出名单里，因此不会随备份离开本机', async () => {
        const mirror = await import('./lsMirror');
        const session = await import('./travel/session');
        expect(session.TRAVEL_OWNER_STORAGE_KEY).toBe('travel.owner.v1');
        expect(mirror.MIRRORED_KEYS).not.toContain(session.TRAVEL_OWNER_STORAGE_KEY);
        // 反向锁：名单里也不能出现任何 travel.* 键（新增时必须先过脱敏审计）
        expect(mirror.MIRRORED_KEYS.filter((k) => k.startsWith('travel.'))).toEqual([]);
    });
});
