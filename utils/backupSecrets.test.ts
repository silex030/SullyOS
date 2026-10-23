import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { stripBackupSecrets, hasBackupSecrets, LS_MIRROR_ASSET_ID } from './backupSecrets';
import { writeV2Backup, type ZipFileWriter } from './backupFormat';

const apiConfig = () => ({
  baseUrl: 'https://api.example.dev/v1',
  apiKey: 'sk-live',
  model: 'm',
  minimaxApiKey: 'mm-live',
  fishAudioApiKey: 'fish-live',
  elevenLabsApiKey: 'el-live',
  aceStepApiKey: 'r8-live',
  latentImageKey: 'lat-live',
  visionApi: { enabled: true, baseUrl: 'https://v.example.dev', apiKey: 'v-live', model: 'vm' },
});

describe('backup secrets redaction', () => {
  it('blanks keys in apiConfig/checkPhoneApi/presets but keeps the rest', () => {
    const data: any = {
      apiConfig: apiConfig(),
      checkPhoneApi: apiConfig(),
      apiPresets: [{ id: 'p1', name: 'P', config: apiConfig() }],
    };
    expect(hasBackupSecrets(data)).toBe(true);
    const redacted = stripBackupSecrets(data);
    expect(redacted).toBe(true);
    for (const cfg of [data.apiConfig, data.checkPhoneApi, data.apiPresets[0].config]) {
      expect(cfg.apiKey).toBe('');
      expect(cfg.minimaxApiKey).toBe('');
      expect(cfg.fishAudioApiKey).toBe('');
      expect(cfg.elevenLabsApiKey).toBe('');
      expect(cfg.aceStepApiKey).toBe('');
      expect(cfg.latentImageKey).toBe('');
      expect(cfg.visionApi.apiKey).toBe('');
      // 非密钥字段原样保留，恢复后不用重填地址模型
      expect(cfg.baseUrl).toBe('https://api.example.dev/v1');
      expect(cfg.model).toBe('m');
    }
    expect(hasBackupSecrets(data)).toBe(false);
  });

  it('blanks per-character secondary/emotion keys and service configs', () => {
    const data: any = {
      characters: [{
        id: 'c1',
        proactiveConfig: { enabled: true, secondaryApi: { baseUrl: 'u', apiKey: 'sk-c', model: 'm' } },
        emotionConfig: { enabled: true, api: { baseUrl: 'u', apiKey: 'sk-e', model: 'm' } },
      }],
      pushVapid: { vapidPublicKey: 'pub', vapidPrivateKey: 'PRIV', vapidEmail: 'a@b.c' },
      instantPushConfig: { enabled: true, workerUrl: 'w', clientToken: 'tok' },
      cloudBackupConfig: { enabled: true, username: 'u', password: 'pw', githubToken: 'gh' },
      remoteVectorConfig: { enabled: true, supabaseUrl: 'u', supabaseAnonKey: 'anon' },
      memoryPalaceConfig: {
        embedding: { baseUrl: 'u', apiKey: 'emb', model: 'm' },
        lightLLM: { baseUrl: 'u', apiKey: 'llm', model: 'm' },
      },
      amsg2GlobalConfig: { userId: 'u', workerUrl: 'w', serverToken: 'st', masterKey: 'mk' },
      studyApiConfig: { baseUrl: 'u', apiKey: 'sk-s', model: 'm' },
    };
    expect(stripBackupSecrets(data)).toBe(true);
    expect(data.characters[0].proactiveConfig.secondaryApi.apiKey).toBe('');
    expect(data.characters[0].emotionConfig.api.apiKey).toBe('');
    expect(data.pushVapid.vapidPrivateKey).toBe('');
    expect(data.pushVapid.vapidPublicKey).toBe('pub');
    expect(data.instantPushConfig.clientToken).toBe('');
    expect(data.cloudBackupConfig.password).toBe('');
    expect(data.cloudBackupConfig.githubToken).toBe('');
    expect(data.cloudBackupConfig.username).toBe('u');
    expect(data.remoteVectorConfig.supabaseAnonKey).toBe('');
    expect(data.memoryPalaceConfig.embedding.apiKey).toBe('');
    expect(data.memoryPalaceConfig.lightLLM.apiKey).toBe('');
    expect(data.amsg2GlobalConfig.serverToken).toBe('');
    expect(data.amsg2GlobalConfig.masterKey).toBe('');
    expect(data.amsg2GlobalConfig.workerUrl).toBe('w');
    expect(data.studyApiConfig.apiKey).toBe('');
  });

  it('blanks secret-looking keys in opaque local maps, keeps the rest', () => {
    // opencodeLocal 已随「外部 agent 整体退役」删除（字段不再导出），这里不再造它：
    // 旧包里的该字段由 runSection 静默忽略，不需要脱敏断言。
    const data: any = {
      worldHomeLocal: { world_home_api: '{"apiKey":"sk-w"}', world_custom_styles: '[]' },
      mcpLocal: { servers: '[]' },
    };
    expect(stripBackupSecrets(data)).toBe(true);
    expect(data.mcpLocal).toEqual({ servers: '[]' });
    // world_home_api 整段 JSON 含 key：整值清空比留下半截安全
    expect(data.worldHomeLocal.world_home_api).toBe('');
    expect(data.worldHomeLocal.world_custom_styles).toBe('[]');
  });

  it('blanks realtimeConfig keys and browser braveKey but keeps non-secret config', () => {
    const data: any = {
      realtimeConfig: {
        weatherEnabled: true,
        weatherApiKey: 'owm-live',
        weatherCity: 'Beijing',
        amapApiKey: 'amap-live',
        userPerceptionEnabled: true,
        newsEnabled: true,
        newsApiKey: 'brave-live',
        newsPlatforms: ['weibo'],
        notionEnabled: true,
        notionApiKey: 'notion-live',
        notionDatabaseId: 'db-live',
        notionNotesDatabaseId: 'notes-live',
        feishuEnabled: true,
        feishuAppId: 'app-live',
        feishuAppSecret: 'sec-live',
        feishuBaseId: 'base-live',
        feishuTableId: 'tbl-live',
        xhsEnabled: true,
        xhsMcpConfig: {
          enabled: true,
          mode: 'lite',
          serverUrl: 'https://xhs-lite.xxx.workers.dev/api',
          cookie: 'a1=xxx; web_session=yyy',
          platform: 'xhs',
          rnoteApiKey: 'rnote-live',
          loggedInNickname: 'nick',
          loggedInUserId: 'uid123',
          userXsecToken: 'xsec-live',
        },
        cacheMinutes: 30,
        perspectiveEnabled: true,
        perspectiveSupabaseUrl: 'https://xxx.supabase.co',
        perspectiveSupabaseAnonKey: 'anon-live',
        perspectiveDays: 7,
        perspectiveMinIntervalSec: 60,
        perspectiveSummaryEnabled: true,
        perspectiveSummaryThreshold: 500,
      },
      browserConfig: { braveKey: 'brave-search-live', useRealSearch: true },
    };
    expect(hasBackupSecrets(data)).toBe(true);
    expect(stripBackupSecrets(data)).toBe(true);
    expect(data.realtimeConfig.weatherApiKey).toBe('');
    expect(data.realtimeConfig.amapApiKey).toBe('');
    expect(data.realtimeConfig.newsApiKey).toBe('');
    expect(data.realtimeConfig.notionApiKey).toBe('');
    expect(data.realtimeConfig.notionDatabaseId).toBe('');
    expect(data.realtimeConfig.notionNotesDatabaseId).toBe('');
    expect(data.realtimeConfig.feishuAppId).toBe('');
    expect(data.realtimeConfig.feishuAppSecret).toBe('');
    expect(data.realtimeConfig.feishuBaseId).toBe('');
    expect(data.realtimeConfig.feishuTableId).toBe('');
    expect(data.realtimeConfig.xhsMcpConfig.cookie).toBe('');
    expect(data.realtimeConfig.xhsMcpConfig.rnoteApiKey).toBe('');
    expect(data.realtimeConfig.xhsMcpConfig.userXsecToken).toBe('');
    expect(data.realtimeConfig.perspectiveSupabaseAnonKey).toBe('');
    expect(data.browserConfig.braveKey).toBe('');
    // 非密钥字段原样保留
    expect(data.realtimeConfig.weatherEnabled).toBe(true);
    expect(data.realtimeConfig.weatherCity).toBe('Beijing');
    expect(data.realtimeConfig.userPerceptionEnabled).toBe(true);
    expect(data.realtimeConfig.newsEnabled).toBe(true);
    expect(data.realtimeConfig.newsPlatforms).toEqual(['weibo']);
    expect(data.realtimeConfig.notionEnabled).toBe(true);
    expect(data.realtimeConfig.feishuEnabled).toBe(true);
    expect(data.realtimeConfig.xhsEnabled).toBe(true);
    expect(data.realtimeConfig.xhsMcpConfig.enabled).toBe(true);
    expect(data.realtimeConfig.xhsMcpConfig.mode).toBe('lite');
    expect(data.realtimeConfig.xhsMcpConfig.serverUrl).toBe('https://xhs-lite.xxx.workers.dev/api');
    expect(data.realtimeConfig.xhsMcpConfig.platform).toBe('xhs');
    expect(data.realtimeConfig.xhsMcpConfig.loggedInNickname).toBe('nick');
    expect(data.realtimeConfig.xhsMcpConfig.loggedInUserId).toBe('uid123');
    expect(data.realtimeConfig.cacheMinutes).toBe(30);
    expect(data.realtimeConfig.perspectiveEnabled).toBe(true);
    expect(data.realtimeConfig.perspectiveSupabaseUrl).toBe('https://xxx.supabase.co');
    expect(data.realtimeConfig.perspectiveDays).toBe(7);
    expect(data.realtimeConfig.perspectiveMinIntervalSec).toBe(60);
    expect(data.realtimeConfig.perspectiveSummaryEnabled).toBe(true);
    expect(data.realtimeConfig.perspectiveSummaryThreshold).toBe(500);
    expect(data.browserConfig.useRealSearch).toBe(true);
    expect(hasBackupSecrets(data)).toBe(false);
  });

  it('returns false and touches nothing when there is nothing secret', () => {
    const data: any = { theme: { id: 't' }, notes: 'hello' };
    expect(stripBackupSecrets(data)).toBe(false);
    expect(data).toEqual({ theme: { id: 't' }, notes: 'hello' });
    expect(hasBackupSecrets(data)).toBe(false);
  });

  it('redacts the xhs bridge token', () => {
    const data: any = { realtimeConfig: { xhsMcpConfig: { bridgeToken: 'bridge-tok', cookie: '', rnoteApiKey: '', userXsecToken: '' } } };
    expect(stripBackupSecrets(data)).toBe(true);
    expect(data.realtimeConfig.xhsMcpConfig.bridgeToken).toBe('');
    expect(hasBackupSecrets(data)).toBe(false);
  });

  it('redacts the google bridge token in googleLocal but keeps the bridge url', () => {
    const data: any = { googleLocal: { 'aetheros.google.bridgeToken': 'T', 'aetheros.google.bridgeUrl': 'http://127.0.0.1:8841' } };
    expect(stripBackupSecrets(data)).toBe(true);
    expect(data.googleLocal['aetheros.google.bridgeToken']).toBe('');
    expect(data.googleLocal['aetheros.google.bridgeUrl']).toBe('http://127.0.0.1:8841');
    expect(hasBackupSecrets(data)).toBe(false);
  });
});

describe('keepBackendConnection（导出面板勾选「包含主动消息后端连接」）', () => {
  const withAmsg2 = (): any => ({
    amsg2GlobalConfig: {
      workerUrl: 'https://worker.example.workers.dev',
      userId: 'u-1',
      serverToken: 'server-token-abc',
      masterKey: 'master-key-xyz',
      instantChatEnabled: true,
    },
    apiConfig: apiConfig(),
  });

  it('默认：Worker 的共享密钥与主密钥一律清零（地址与用户 id 留着）', () => {
    const data = withAmsg2();
    stripBackupSecrets(data);
    expect(data.amsg2GlobalConfig.serverToken).toBe('');
    expect(data.amsg2GlobalConfig.masterKey).toBe('');
    expect(data.amsg2GlobalConfig.workerUrl).toBe('https://worker.example.workers.dev');
    expect(data.amsg2GlobalConfig.userId).toBe('u-1');
  });

  it('勾选后：这两把钥匙保留，但其它密钥（LLM API Key）仍然清零', () => {
    const data = withAmsg2();
    stripBackupSecrets(data, { keepBackendConnection: true });
    expect(data.amsg2GlobalConfig.serverToken).toBe('server-token-abc');
    expect(data.amsg2GlobalConfig.masterKey).toBe('master-key-xyz');
    expect(data.apiConfig.apiKey).toBe('');
  });

  it('keepBackendConnection 不会把「没勾选的其它东西」也放行', () => {
    const data: any = {
      cloudBackupConfig: { password: 'p@ss', githubToken: 'ghp_x' },
      pushVapid: { vapidPrivateKey: 'priv' },
      amsg2GlobalConfig: { workerUrl: 'w', serverToken: 's', masterKey: 'm' },
    };
    stripBackupSecrets(data, { keepBackendConnection: true });
    expect(data.cloudBackupConfig.password).toBe('');
    expect(data.cloudBackupConfig.githubToken).toBe('');
    expect(data.pushVapid.vapidPrivateKey).toBe('');
    expect(data.amsg2GlobalConfig.serverToken).toBe('s');
  });
});

// ── 真实导出链路回归：合成标记不得出现在最终 zip（metadata.json / stores 分片）──
// 只走内存 zip，不落真实备份包、不联网、不读用户数据。
// 锁住的契约：
//   ① apiConfig.agentToken（主代理 X-Client-Token）、apiConfig.bridge.token、
//      apiConfig.bridges[].token 一律清零；
//   ② includeBackendConnection 只放行既有授权范围（amsg2GlobalConfig.serverToken/masterKey），
//      不得顺带放行 api/bridge 凭据；
//   ③ 结构留住（agentUrl / bridge.url 仍在），恢复后用户只需重填钥匙。
describe('备份包最终产物里不得出现 apiConfig/bridge 凭据（真实 writeV2Backup）', () => {
  const AGENT = 'MARKER-AGENT-TOKEN-7Q2';
  const BRIDGE = 'MARKER-BRIDGE-TOKEN-7Q2';
  const BRIDGES = 'MARKER-BRIDGES-TOKEN-7Q2';
  const APIKEY = 'MARKER-API-KEY-7Q2';
  const SRV = 'MARKER-SERVER-TOKEN-7Q2';
  const MK = 'MARKER-MASTER-KEY-7Q2';
  const EMOTION = 'MARKER-EMOTION-KEY-7Q2';

  const payload = () => ({
    timestamp: 1,
    apiConfig: {
      baseUrl: 'https://relay.example.dev/v1',
      model: 'm',
      apiKey: APIKEY,
      agentUrl: 'https://vps.example.dev',
      agentToken: AGENT,
      bridge: { url: 'https://bridge.example.dev', token: BRIDGE, enabled: true },
      bridges: [{ url: 'https://bridge2.example.dev', token: BRIDGES, enabled: true }],
    },
    amsg2GlobalConfig: { workerUrl: 'https://worker.example.dev', serverToken: SRV, masterKey: MK },
    characters: [{ id: 'c1', emotionConfig: { enabled: true, api: { baseUrl: 'u', apiKey: EMOTION, model: 'm' } } }],
    messages: [{ id: 1, text: 'hi' }],
  });

  /** 走真实导出：脱敏 → writeV2Backup，再把所有 zip 条目文本拼起来查标记。 */
  const exportToZip = async (opts: { keepBackendConnection?: boolean } = {}) => {
    const data: any = payload();
    expect(stripBackupSecrets(data, opts)).toBe(true);
    const zip = new JSZip() as unknown as ZipFileWriter;
    await writeV2Backup(zip, data, { mode: 'full', createdAt: 1 });
    const files = (zip as any).files as Record<string, { async(t: 'string'): Promise<string> }>;
    const names = Object.keys(files);
    const texts: string[] = [];
    for (const n of names) texts.push(await files[n].async('string'));
    return {
      names,
      all: texts.join('\n'),
      meta: JSON.parse(await files['metadata.json'].async('string')),
    };
  };

  it('默认导出：agentToken / bridge.token / bridges[].token 不进 metadata.json，也不进任何分片', async () => {
    const { names, all, meta } = await exportToZip();
    expect(names).toContain('metadata.json');
    for (const marker of [AGENT, BRIDGE, BRIDGES, APIKEY, EMOTION]) {
      expect(all.includes(marker), `包内仍出现标记：${marker}`).toBe(false);
    }
    // 结构保留，恢复后只需重填钥匙
    expect(meta.apiConfig.agentUrl).toBe('https://vps.example.dev');
    expect(meta.apiConfig.bridge.url).toBe('https://bridge.example.dev');
    expect(meta.apiConfig.bridges[0].url).toBe('https://bridge2.example.dev');
    expect(meta.apiConfig.agentToken).toBe('');
    expect(meta.apiConfig.bridge.token).toBe('');
    expect(meta.apiConfig.bridges[0].token).toBe('');
  });

  it('勾选 includeBackendConnection：只放行 amsg2 的两把钥匙，api/bridge 凭据仍然不进包', async () => {
    const { all, meta } = await exportToZip({ keepBackendConnection: true });
    // 现有授权范围：这两把按勾选保留
    expect(meta.amsg2GlobalConfig.serverToken).toBe(SRV);
    expect(meta.amsg2GlobalConfig.masterKey).toBe(MK);
    expect(all.includes(SRV)).toBe(true);
    // 授权范围之外一律不许跟着漏
    for (const marker of [AGENT, BRIDGE, BRIDGES, APIKEY, EMOTION]) {
      expect(all.includes(marker), `勾选后包内仍出现标记：${marker}`).toBe(false);
    }
  });
});

// ── localStorage 镜像行（assets 表 ls_mirror_v1）──
// 镜像为了本地回填必须留明文，但导出侧绝不能把同一份明文交出去：这里锁
// 「按已知配置键脱敏 + 未知键严格兜底 + 非敏感设置原样保留」三条。
describe('ls_mirror_v1 资产行脱敏（redactLocalStorageMirrorPayload）', () => {
  const mirrorApiConfig = () => {
    const cfg: Record<string, any> = {
      baseUrl: 'https://relay.example.dev/v1',
      model: 'm',
      agentToken: 'AGENT-MARK',
      bridge: { url: 'https://b.example.dev', token: 'BRIDGE-MARK' },
    };
    cfg['api' + 'Key'] = 'LLM-MARK';
    return cfg;
  };

  const mirror = () => ({
    id: LS_MIRROR_ASSET_ID,
    data: {
      savedAt: 1,
      data: {
        os_api_config: JSON.stringify(mirrorApiConfig()),
        push_vapid_v1: JSON.stringify({ vapidPublicKey: 'pub-keep', vapidPrivateKey: 'VAPID-MARK' }),
        os_theme: JSON.stringify({ id: 't', accent: '#fff' }),
        newcfg_v2: JSON.stringify({ label: 'keep', refreshToken: 'RT-MARK', tokens: { accent: '#000' } }),
        plain_text_secret: 'TEXT-MARK',
      },
    },
  });

  it('资产数组里的镜像行被脱敏，非镜像行不动', () => {
    const data: any = {
      assets: [mirror(), { id: 'custom_asset', data: { label: 'keep', notes: 'n' } }],
    };
    expect(stripBackupSecrets(data)).toBe(true);
    const row = data.assets[0];
    const inner = row.data.data;
    const api = JSON.parse(inner.os_api_config);
    expect(api.baseUrl).toBe('https://relay.example.dev/v1');
    expect(api.apiKey).toBe('');
    expect(api.agentToken).toBe('');
    expect(api.bridge.token).toBe('');
    expect(JSON.parse(inner.push_vapid_v1).vapidPublicKey).toBe('pub-keep');
    expect(JSON.parse(inner.push_vapid_v1).vapidPrivateKey).toBe('');
    expect(JSON.parse(inner.os_theme)).toEqual({ id: 't', accent: '#fff' });
    expect(data.assets[1]).toEqual({ id: 'custom_asset', data: { label: 'keep', notes: 'n' } });
    expect(hasBackupSecrets(data)).toBe(false);
  });

  it('未知/新增键：凭据后缀字段与纯文本凭据被清，设计 token 与非敏感字段保留', () => {
    const data: any = { assets: [mirror()] };
    stripBackupSecrets(data);
    const inner = data.assets[0].data.data;
    const newcfg = JSON.parse(inner.newcfg_v2);
    expect(newcfg.label).toBe('keep');
    expect(newcfg.refreshToken).toBe('');
    expect(newcfg.tokens).toEqual({ accent: '#000' });
    expect(inner.plain_text_secret).toBe('');
  });

  it('没有镜像行时不动手（其它资产里正常的 token 字段不当凭据）', () => {
    const data: any = { assets: [{ id: 'appearance_preset_x', data: { tokens: { bg: '#000' } } }] };
    expect(stripBackupSecrets(data)).toBe(false);
    expect(data.assets[0].data.tokens).toEqual({ bg: '#000' });
  });
});
