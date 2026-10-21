import { describe, it, expect } from 'vitest';
import { stripBackupSecrets, hasBackupSecrets } from './backupSecrets';

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
    const data: any = {
      opencodeLocal: { host: 'h', password: 'pw', token: 't' },
      worldHomeLocal: { world_home_api: '{"apiKey":"sk-w"}', world_custom_styles: '[]' },
      mcpLocal: { servers: '[]' },
    };
    expect(stripBackupSecrets(data)).toBe(true);
    expect(data.opencodeLocal).toEqual({ host: 'h', password: '', token: '' });
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
