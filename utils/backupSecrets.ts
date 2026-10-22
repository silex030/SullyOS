/**
 * 备份出包前的密钥脱敏。
 *
 * 备份包会被用户到处传（网盘/聊天软件/仓库），而包里躺着 LLM Key、TTS Key、
 * WebDAV 密码、GitHub Token、VAPID 私钥、各家 API Key……XSS 或一次误分享
 * 即全泄。导出时把密钥值清空、只留地址/模型等非敏感配置；恢复后用户重填一次 Key。
 *
 * 约定：
 * - 只处理本文件显式列出的持有者 + 不透明 local map 的启发式（键名命中
 *   key/token/secret/password/auth，或值是含这些键名的 JSON）。
 * - 返回是否动过手：动过则导出端在包上打 `secretsRedacted: true`，
 *   导入端看到即 toast 提醒重填。
 * - 纯函数（就地改传的对象）+ 全单测覆盖，新增密钥字段时先补这里再补类型。
 */

const SECRET_KEY_PATTERN = /key|token|secret|password|auth/i;
const SECRET_JSON_PATTERN = /"(apiKey|api_key|token|secret|password|auth)[^"]*"\s*:/i;

const blankField = (hit: { hit: boolean }, obj: any, field: string): void => {
  if (obj && typeof obj[field] === 'string' && obj[field] !== '') {
    obj[field] = '';
    hit.hit = true;
  }
};

/** APIConfig 形态（含各家 TTS/生图 Key + 视觉副 API + 主代理/桥接凭据）。Partial 亦可。 */
function stripApiConfig(hit: { hit: boolean }, cfg: any): void {
  if (!cfg || typeof cfg !== 'object') return;
  for (const f of [
    'apiKey', 'minimaxApiKey', 'fishAudioApiKey', 'elevenLabsApiKey',
    'aceStepApiKey', 'latentImageKey',
    // 主代理（VPS /agent/v1 中转）的 X-Client-Token：等价于后端共享密钥，绝不进包。
    'agentToken',
  ]) blankField(hit, cfg, f);
  if (cfg.visionApi && typeof cfg.visionApi === 'object') blankField(hit, cfg.visionApi, 'apiKey');
  if (cfg.secondaryApi && typeof cfg.secondaryApi === 'object') blankField(hit, cfg.secondaryApi, 'apiKey');
  if (cfg.api && typeof cfg.api === 'object') blankField(hit, cfg.api, 'apiKey');
  // 外部连接桥的 Bearer（单桥 bridge / 多桥 bridges[]）：URL 留着、令牌清零。
  // 注意：这条不在「包含主动消息后端连接」的授权范围里——勾选项只放行 amsg2 的
  // serverToken/masterKey，不能顺带放行 api/桥接凭据。
  if (cfg.bridge && typeof cfg.bridge === 'object') blankField(hit, cfg.bridge, 'token');
  if (Array.isArray(cfg.bridges)) {
    for (const b of cfg.bridges) {
      if (b && typeof b === 'object') blankField(hit, b, 'token');
    }
  }
}

/** RealtimeConfig 形态（天气/高德/新闻/Notion/飞书/小红书 cookie/透视窗 anonKey）。Partial 亦可。 */
function stripRealtimeConfig(hit: { hit: boolean }, cfg: any): void {
  if (!cfg || typeof cfg !== 'object') return;
  for (const f of [
    'weatherApiKey', 'amapApiKey', 'newsApiKey',
    'notionApiKey', 'notionDatabaseId', 'notionNotesDatabaseId',
    'feishuAppId', 'feishuAppSecret', 'feishuBaseId', 'feishuTableId',
    'perspectiveSupabaseAnonKey',
  ]) blankField(hit, cfg, f);
  const xhs = cfg.xhsMcpConfig;
  if (xhs && typeof xhs === 'object') {
    for (const f of ['cookie', 'rnoteApiKey', 'userXsecToken', 'bridgeToken']) blankField(hit, xhs, f);
  }
}

/** 不透明 Record<string,string>：键名命中即清空；值是含密钥键名的 JSON 也整值清空。 */
function stripOpaqueMap(hit: { hit: boolean }, map: any): void {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  for (const k of Object.keys(map)) {
    const v = (map as any)[k];
    if (typeof v !== 'string' || v === '') continue;
    if (SECRET_KEY_PATTERN.test(k)) {
      (map as any)[k] = '';
      hit.hit = true;
      continue;
    }
    if ((v.startsWith('{') || v.startsWith('[')) && SECRET_JSON_PATTERN.test(v)) {
      (map as any)[k] = '';
      hit.hit = true;
    }
  }
}

/**
 * 就地脱敏备份载荷。返回 true = 动过手（调用方应在包上标记 secretsRedacted）。
 *
 * @param opts.keepBackendConnection 用户在导出面板显式勾了「包含主动消息 2.0 的后端连接」时传
 *   true：Worker 的共享密钥与主密钥留着不抹。其余密钥（LLM/TTS/WebDAV/VAPID…）无论如
 *   何一律清零——那几样跟"换设备恢复连接"无关，留着只增加泄漏面。
 */
export function stripBackupSecrets(data: any, opts: { keepBackendConnection?: boolean } = {}): boolean {
  if (!data || typeof data !== 'object') return false;
  const hit = { hit: false };

  stripApiConfig(hit, data.apiConfig);
  stripApiConfig(hit, data.checkPhoneApi);
  stripApiConfig(hit, data.studyApiConfig);
  if (Array.isArray(data.apiPresets)) {
    for (const p of data.apiPresets) stripApiConfig(hit, p?.config);
  }
  if (Array.isArray(data.characters)) {
    for (const c of data.characters) {
      stripApiConfig(hit, c?.proactiveConfig?.secondaryApi);
      stripApiConfig(hit, c?.emotionConfig?.api);
    }
  }

  blankField(hit, data.pushVapid, 'vapidPrivateKey');
  blankField(hit, data.instantPushConfig, 'clientToken');
  blankField(hit, data.cloudBackupConfig, 'password');
  blankField(hit, data.cloudBackupConfig, 'githubToken');  blankField(hit, data.remoteVectorConfig, 'supabaseAnonKey');
  if (data.memoryPalaceConfig && typeof data.memoryPalaceConfig === 'object') {
    blankField(hit, data.memoryPalaceConfig.embedding, 'apiKey');
    blankField(hit, data.memoryPalaceConfig.lightLLM, 'apiKey');
    blankField(hit, data.memoryPalaceConfig.rerank, 'apiKey');
  }
  if (!opts.keepBackendConnection) {
    blankField(hit, data.amsg2GlobalConfig, 'serverToken');
    blankField(hit, data.amsg2GlobalConfig, 'masterKey');
  }
  stripRealtimeConfig(hit, data.realtimeConfig);
  blankField(hit, data.browserConfig, 'braveKey');

  // 外部 agent（终端 / 本机 opencode 遥控）已于 2026-10-22 整体退役：导出侧不再有
  // opencodeLocal 字段，这里不留死分支。旧备份包里的该字段在导入时被 runSection
  // 静默忽略（无白名单校验），无害且不会回写 localStorage。
  stripOpaqueMap(hit, data.luckinLocal);
  stripOpaqueMap(hit, data.mcdLocal);
  stripOpaqueMap(hit, data.mcpLocal);
  stripOpaqueMap(hit, data.worldHomeLocal);
  // Google 桥 token（localStorage aetheros.google.*）：随包带出即失守，键名命中 token 启发式即清空。
  stripOpaqueMap(hit, data.googleLocal);

  return hit.hit;
}

/** 包里是否还看得到密钥（导入端/测试断言用）。 */
export function hasBackupSecrets(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  const snapshot = JSON.parse(JSON.stringify(data));
  return stripBackupSecrets(snapshot);
}
