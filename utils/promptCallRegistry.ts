// utils/promptCallRegistry.ts
// 调用地图的登记表（手工策展）：取材自 spec §7 全仓调用点清单（2026-09-23 实扫）。
// site 与 Task 1 captureCall 的 siteId 同源；wiring 测试锁定每个本地登记项的
// 实现锚点文件存在、关键符号未漂移。云端 [C] 站点本地不可见，只记形态。
export type CallVisibility = 'local' | 'local-uncaptured' | 'cloud';
export interface CallGate { kind: 'char' | 'global' | 'manual'; ref: string; label: string }
export interface CallSite {
    site: string; category: string; name: string; blurb: string;
    trigger: '每轮回复后' | '发送前' | '手动按钮' | '定时 fire' | '工具轮内';
    sources: string[]; // sourceKey 或 'hardcoded:<模块>'
    gates: CallGate[]; visibility: CallVisibility;
    anchor: string; // "文件:行" 实现锚点
    pin: string; // 实现文件里必须存在的符号子串：wiring 测试按符号全文搜索定位，文件被任何窗口改动都不会误报
}

const G = {
    api: { kind: 'global', ref: 'apiConfig', label: '主 API 可用' } as CallGate,
    tts: { kind: 'global', ref: 'apiConfig.ttsProvider', label: '全局 TTS 供应商' } as CallGate,
    manual: { kind: 'manual', ref: 'user-action', label: '用户手动触发' } as CallGate,
    inTurn: { kind: 'manual', ref: 'chat-turn', label: '聊天轮内按需触发' } as CallGate,
};

export const CALL_REGISTRY: CallSite[] = [
    // ── 主聊天链路 10 ──
    { site: 'chat-main', category: '主聊天链路', name: '主聊天请求', blurb: 'useChatAI 主请求 + 重试 + 工具轮续跑', trigger: '发送前', sources: ['chat.steelExpression', 'chat.steelYourself', 'voice.minimax', 'voice.fish', 'voice.elevenlabsV3', 'voice.elevenlabsStd', 'chat.perspectiveTool'], gates: [G.api], visibility: 'local', anchor: 'hooks/useChatAI.ts:1086', pin: 'baseReqBody' },
    { site: 'proactive-local', category: '主聊天链路', name: '主动消息本地生成', blurb: 'OSContext 定时触发的本地主动消息', trigger: '定时 fire', sources: ['hardcoded:context/OSContext'], gates: [{ kind: 'char', ref: 'char.proactiveConfig.enabled', label: '角色主动消息开关' }], visibility: 'local-uncaptured', anchor: 'context/OSContext.tsx:2188', pin: 'runProactive' },
    { site: 'amsg-fire', category: '主聊天链路', name: '主动消息主干 fire', blurb: '云端 onBeforeFire：定时任务到点的主干入口', trigger: '定时 fire', sources: ['hardcoded:worker/amsg'], gates: [G.api], visibility: 'cloud', anchor: 'worker/amsg/src/index.ts:1577', pin: 'onBeforeFire' },
    { site: 'instant-chat', category: '主聊天链路', name: '即时对话', blurb: 'instantChat 路由 + activeMsgClient 信封', trigger: '定时 fire', sources: ['hardcoded:worker/amsg'], gates: [{ kind: 'global', ref: 'instantChatEnabled', label: '即时对话总开关' }], visibility: 'cloud', anchor: 'worker/amsg/src/instantChat.ts:383', pin: 'handleInstantChat' },
    { site: 'main-agent', category: '主聊天链路', name: '主代理 llmStream', blurb: 'worker/main-agent 的流式主代理循环', trigger: '工具轮内', sources: ['hardcoded:worker/main-agent'], gates: [G.api], visibility: 'cloud', anchor: 'worker/main-agent/src/index.js:247', pin: 'llmStream' },
    { site: 'instant-push-loop', category: '主聊天链路', name: 'instant-push 主循环', blurb: 'instant-push worker 的请求主循环', trigger: '定时 fire', sources: ['hardcoded:worker/instant-push'], gates: [G.api], visibility: 'cloud', anchor: 'worker/instant-push/src/index.ts:418', pin: 'runEmotionEval' },
    { site: 'call-reply', category: '主聊天链路', name: '通话轮回复', blurb: 'CallApp requestAssistantReply：电话轮次回复', trigger: '发送前', sources: ['hardcoded:apps/CallApp'], gates: [{ kind: 'manual', ref: 'call-active', label: '通话进行中' }], visibility: 'local-uncaptured', anchor: 'apps/CallApp.tsx:1879', pin: 'requestAssistantReply' },
    { site: 'group-chat', category: '主聊天链路', name: '群聊三触发', blurb: '群聊导演 / 轮转 / 群 AI 三路触发', trigger: '发送前', sources: ['hardcoded:apps/GroupChat'], gates: [G.inTurn], visibility: 'local-uncaptured', anchor: 'apps/GroupChat.tsx:1343', pin: 'triggerDirector' },
    { site: 'date-session', category: '主聊天链路', name: '见面主回复', blurb: 'DateApp callLLM：见面 VN 主回复', trigger: '发送前', sources: ['date.digDeeper', 'voice.date'], gates: [G.api], visibility: 'local', anchor: 'apps/DateApp.tsx:227', pin: 'callLLM' },
    { site: 'collaboration-turn', category: '主聊天链路', name: '协作回合', blurb: '协同工作引擎的回合生成', trigger: '手动按钮', sources: ['hardcoded:features/collaboration/engine'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'features/collaboration/engine.ts:22', pin: 'runCollaborationTurn' },
    // ── 记忆系统 7 ──
    { site: 'memory-extract', category: '记忆系统', name: '记忆提取', blurb: 'extraction：话题盒记忆提取', trigger: '每轮回复后', sources: ['memory.extractionRules', 'memory.extractionEntityRule', 'memory.extractionMain'], gates: [G.api], visibility: 'local', anchor: 'utils/memoryPalace/extraction.ts:413', pin: 'safeFetchJson' },
    { site: 'memory-digest', category: '记忆系统', name: '记忆消化', blurb: 'digestion 反刍：独处反思任务', trigger: '每轮回复后', sources: ['memory.reflectTask'], gates: [G.api], visibility: 'local', anchor: 'utils/memoryPalace/digestion.ts:339', pin: 'safeFetchJson' },
    { site: 'personality-detect', category: '记忆系统', name: '认知风格判定', blurb: '消化内的角色认知风格与反刍倾向判定', trigger: '每轮回复后', sources: ['memory.personalityDetect'], gates: [G.api], visibility: 'local-uncaptured', anchor: 'utils/memoryPalace/digestion.ts:984', pin: 'safeFetchJson' },
    { site: 'recall-router', category: '记忆系统', name: '召回路由', blurb: '发送前轻量检索计划生成', trigger: '发送前', sources: ['memory.recallRouter'], gates: [{ kind: 'global', ref: 'recallRouter-feature', label: '召回路由特性开关' }], visibility: 'local-uncaptured', anchor: 'utils/memoryPalace/recallRouter.ts:494', pin: 'memory.recallRouter' },
    { site: 'eventbox-compress', category: '记忆系统', name: '事件盒压缩', blurb: '事件盒封盒压缩与摘要再生', trigger: '定时 fire', sources: ['hardcoded:utils/memoryPalace/eventBoxCompression'], gates: [G.api], visibility: 'local-uncaptured', anchor: 'utils/memoryPalace/eventBoxCompression.ts:610', pin: 'maybeCompressEventBoxes' },
    { site: 'plate-fire', category: '记忆系统', name: '门牌整理', blurb: '云端门牌整理 fire（plateConsolidateHandler）', trigger: '定时 fire', sources: ['hardcoded:worker/amsg'], gates: [G.api], visibility: 'cloud', anchor: 'worker/amsg/src/plateFire.ts:60', pin: 'plateConsolidateHandler' },
    { site: 'archive', category: '记忆系统', name: '归档', blurb: 'Chat 旧归档 + 角色页强制归档 / 批量摘要，同归档模板体系', trigger: '手动按钮', sources: ['hardcoded:apps/Chat'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/Chat.tsx:2907', pin: 'chat/completions' },
    // ── 情绪与日程 2 ──
    { site: 'emotion-eval', category: '情绪与日程', name: '情绪评估', blurb: 'useChatAI evaluateEmotionBackground + emotionEvalCore；云端 amsg/instant-push 同模板并行', trigger: '每轮回复后', sources: ['amsg.emotionEval', 'amsg.emotionEvalMindful', 'amsg.emotionEvalLiving'], gates: [{ kind: 'char', ref: 'char.emotionConfig.enabled', label: '角色情绪评估开关' }], visibility: 'local', anchor: 'hooks/useChatAI.ts:212', pin: 'evalBody' },
    { site: 'schedule-qa', category: '情绪与日程', name: '日程问答', blurb: 'ScheduleApp 日程问答生成', trigger: '手动按钮', sources: ['hardcoded:apps/ScheduleApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/ScheduleApp.tsx:312', pin: 'chat/completions' },
    // ── 关系 2 ──
    { site: 'rel-gen', category: '关系', name: '人物关系生成', blurb: 'relationshipGen：NPC 配角补全', trigger: '手动按钮', sources: ['rel.genGuide'], gates: [G.manual], visibility: 'local', anchor: 'utils/relationshipGen.ts:57', pin: 'generateRelationshipProfiles' },
    { site: 'impression-gen', category: '关系', name: '印象生成', blurb: 'Character handleGenerateImpression，硬编码模板', trigger: '手动按钮', sources: ['hardcoded:apps/Character'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/Character.tsx:1155', pin: 'handleGenerateImpression' },
    // ── 创作与功能 26（song-mentor 接抓取，其余 local-uncaptured）──
    { site: 'song-mentor', category: '创作功能', name: '写歌导师', blurb: '写歌导师系统提示 + 轮次点评', trigger: '发送前', sources: ['song.craftRules'], gates: [G.api], visibility: 'local', anchor: 'apps/SongwritingApp.tsx:505', pin: 'chat/completions' },
    { site: 'song-tag', category: '创作功能', name: '作曲 tag 建议', blurb: 'aceStepApi：作曲风格 tag 行生成', trigger: '手动按钮', sources: ['hardcoded:utils/aceStepApi'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'utils/aceStepApi.ts:306', pin: 'chat/completions' },
    { site: 'char-music-persona', category: '创作功能', name: '角色音乐人格', blurb: 'charMusicPersona：音乐人格判定', trigger: '手动按钮', sources: ['hardcoded:utils/charMusicPersona'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'utils/charMusicPersona.ts:23', pin: 'safeFetchJson' },
    { site: 'xhs-freeroam', category: '创作功能', name: '自由漫游决策', blurb: 'xhsFreeRoam 引擎漫游决策', trigger: '手动按钮', sources: ['hardcoded:utils/xhsFreeRoam'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'utils/xhsFreeRoam.ts:72', pin: 'chat/completions' },
    { site: 'airp-director', category: '创作功能', name: 'AIRP 导演', blurb: 'directorClient：按角色起跑的存在导演', trigger: '工具轮内', sources: ['hardcoded:utils/airp/directorClient'], gates: [{ kind: 'char', ref: 'char.id', label: '按角色启用' }], visibility: 'local-uncaptured', anchor: 'utils/airp/directorClient.ts:269', pin: 'runAirpDirector' },
    { site: 'dream-script', category: '创作功能', name: '梦境剧本', blurb: 'DreamTheater 梦境剧本生成', trigger: '手动按钮', sources: ['hardcoded:apps/DreamTheater'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/DreamTheater.tsx:157', pin: 'chat/completions' },
    { site: 'study-set', category: '创作功能', name: '学习九件套', blurb: 'StudyApp 学习九件套生成', trigger: '手动按钮', sources: ['hardcoded:apps/StudyApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/StudyApp.tsx:778', pin: 'chat/completions' },
    { site: 'bank-board', category: '创作功能', name: '银行留言板', blurb: 'BankApp 留言板回复生成', trigger: '手动按钮', sources: ['hardcoded:apps/BankApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/BankApp.tsx:682', pin: 'chat/completions' },
    { site: 'bank-analytics', category: '创作功能', name: '经营分析', blurb: 'BankAnalytics 经营分析生成', trigger: '手动按钮', sources: ['hardcoded:components/bank/BankAnalytics'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'components/bank/BankAnalytics.tsx:130', pin: 'chat/completions' },
    { site: 'shop-scene', category: '创作功能', name: '商店场景', blurb: 'BankShopScene 商店场景生成', trigger: '手动按钮', sources: ['hardcoded:components/bank/BankShopScene'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'components/bank/BankShopScene.tsx:161', pin: 'chat/completions' },
    { site: 'journal-gen', category: '创作功能', name: '日记生成', blurb: 'JournalApp 日记正文生成', trigger: '手动按钮', sources: ['hardcoded:apps/JournalApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/JournalApp.tsx:529', pin: 'chat/completions' },
    { site: 'room-ambient', category: '创作功能', name: '房间动态', blurb: 'RoomApp 房间生活动态生成', trigger: '手动按钮', sources: ['hardcoded:apps/RoomApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/RoomApp.tsx:636', pin: 'chat/completions' },
    { site: 'checkphone', category: '创作功能', name: '查手机', blurb: 'CheckPhone 总结与回复生成', trigger: '手动按钮', sources: ['hardcoded:apps/CheckPhone'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/CheckPhone.tsx:1219', pin: 'chat/completions' },
    { site: 'browser-summary', category: '创作功能', name: '浏览器总结', blurb: 'BrowserApp 页面总结生成', trigger: '手动按钮', sources: ['hardcoded:apps/BrowserApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/BrowserApp.tsx:301', pin: 'chat/completions' },
    { site: 'guidebook', category: '创作功能', name: '攻略', blurb: 'GuidebookApp 攻略手册生成', trigger: '手动按钮', sources: ['hardcoded:apps/GuidebookApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/GuidebookApp.tsx:36', pin: 'chat/completions' },
    { site: 'game-host', category: '创作功能', name: '游戏主持', blurb: 'GameApp 游戏主持回合', trigger: '手动按钮', sources: ['hardcoded:apps/GameApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/GameApp.tsx:292', pin: 'chat/completions' },
    { site: 'lifesim', category: '创作功能', name: '人生模拟', blurb: 'LifeSimApp 人生模拟事件', trigger: '手动按钮', sources: ['hardcoded:apps/LifeSimApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/LifeSimApp.tsx:83', pin: 'chat/completions' },
    { site: 'worldgen', category: '创作功能', name: '世界生成', blurb: 'WorldHomeApp 世界 NPC 掷骰生成', trigger: '手动按钮', sources: ['hardcoded:apps/WorldHomeApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/WorldHomeApp.tsx:602', pin: 'safeFetchJson' },
    { site: 'vr-event', category: '创作功能', name: 'VR 事件', blurb: 'VRWorldApp 世界事件生成', trigger: '手动按钮', sources: ['hardcoded:apps/VRWorldApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/VRWorldApp.tsx:3676', pin: 'chat/completions' },
    { site: 'gallery-tag', category: '创作功能', name: '画廊 tag', blurb: 'Gallery 画作 tag 生成', trigger: '手动按钮', sources: ['hardcoded:apps/Gallery'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/Gallery.tsx:204', pin: 'chat/completions' },
    { site: 'memory-light', category: '创作功能', name: '记忆轻量 LLM', blurb: 'MemoryPalaceApp 轻量模型调用', trigger: '手动按钮', sources: ['hardcoded:apps/MemoryPalaceApp'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/MemoryPalaceApp.tsx:3193', pin: 'chat/completions' },
    { site: 'settings-probe', category: '创作功能', name: '设置探针', blurb: 'Settings API 连通性探测', trigger: '手动按钮', sources: ['hardcoded:apps/Settings'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/Settings.tsx:2740', pin: 'chat/completions' },
    { site: 'festival-lines', category: '创作功能', name: '节日台词', blurb: '今日特殊节日兜底行：prompt 内硬编码注入，非独立 LLM 调用', trigger: '发送前', sources: ['hardcoded:utils/chatPrompts'], gates: [G.api], visibility: 'local-uncaptured', anchor: 'utils/chatPrompts.ts:567', pin: '今日特殊节日' },
    { site: 'voice-translate', category: '创作功能', name: '语音翻译', blurb: 'Chat llmTranslate：语音转写翻译', trigger: '发送前', sources: ['hardcoded:apps/Chat'], gates: [{ kind: 'char', ref: 'char.chatVoiceEnabled', label: '角色语音开关' }], visibility: 'local-uncaptured', anchor: 'apps/Chat.tsx:565', pin: 'llmTranslate' },
    { site: 'month-refine', category: '创作功能', name: '单月精炼', blurb: 'Character handleRefineMonth：单月记忆精炼', trigger: '手动按钮', sources: ['hardcoded:apps/Character'], gates: [G.manual], visibility: 'local-uncaptured', anchor: 'apps/Character.tsx:823', pin: 'chat/completions' },
    // ── 后台与主动消息 3 ──
    { site: 'autonomy-fire', category: '后台与主动消息', name: '自主回合', blurb: '云端自主回合 fire（autonomyRoundHandler）', trigger: '定时 fire', sources: ['hardcoded:worker/amsg'], gates: [G.api], visibility: 'cloud', anchor: 'worker/amsg/src/autonomyFire.ts:664', pin: 'autonomyRoundHandler' },
    { site: 'schedule-placeholder', category: '后台与主动消息', name: '调度占位符', blurb: '非调用：排程占位提示文案，到点由 worker 下发真实 prompt', trigger: '定时 fire', sources: [], gates: [G.api], visibility: 'cloud', anchor: 'utils/activeMsgClient.ts:872', pin: 'AMSG2_PLACEHOLDER_PROMPT' },
    { site: 'fire-pack-assemble', category: '后台与主动消息', name: 'fire_pack 组装', blurb: 'activeMsgClient 本地组装、云端发包', trigger: '发送前', sources: ['hardcoded:utils/activeMsgClient'], gates: [G.api], visibility: 'local-uncaptured', anchor: 'utils/activeMsgClient.ts:621', pin: 'buildFirePack' },
    // ── 工具与识图 7 ──
    { site: 'tool-recall', category: '工具与识图', name: 'RECALL / SEARCH 二轮', blurb: 'agenticTools：记忆调取工具声明与执行', trigger: '工具轮内', sources: ['hardcoded:utils/agenticTools'], gates: [G.inTurn], visibility: 'local-uncaptured', anchor: 'utils/agenticTools.ts:170', pin: 'RECALL' },
    { site: 'tool-diary', category: '工具与识图', name: '写日记圆场与翻阅二轮', blurb: '写日记圆场 / 翻日记×4 / 读笔记×2 的二轮续跑', trigger: '工具轮内', sources: ['hardcoded:utils/applyAssistantPostProcessing'], gates: [G.inTurn], visibility: 'local-uncaptured', anchor: 'utils/applyAssistantPostProcessing.ts:648', pin: 'READ_DIARY' },
    { site: 'tool-perspective', category: '工具与识图', name: '透视窗二轮与圆场', blurb: 'PERSPECTIVE_QUERY / SUMMARY 二轮与圆场', trigger: '工具轮内', sources: ['chat.perspectiveTool'], gates: [{ kind: 'char', ref: 'char.perspectiveEnabled', label: '角色透视窗开关' }], visibility: 'local-uncaptured', anchor: 'utils/applyAssistantPostProcessing.ts:1658', pin: 'PERSPECTIVE_QUERY' },
    { site: 'tool-xhs-search', category: '工具与识图', name: '小红书搜索浏览', blurb: 'XHS_SEARCH / XHS_BROWSE 二轮续跑', trigger: '工具轮内', sources: ['hardcoded:utils/applyAssistantPostProcessing'], gates: [G.inTurn], visibility: 'local-uncaptured', anchor: 'utils/applyAssistantPostProcessing.ts:1570', pin: 'XHS_SEARCH' },
    { site: 'tool-xhs-detail', category: '工具与识图', name: '小红书主页详情', blurb: 'XHS_DETAIL / MY_PROFILE 笔记详情与主页', trigger: '工具轮内', sources: ['hardcoded:utils/applyAssistantPostProcessing'], gates: [G.inTurn], visibility: 'local-uncaptured', anchor: 'utils/applyAssistantPostProcessing.ts:2122', pin: 'XHS_DETAIL' },
    { site: 'vision-describe', category: '工具与识图', name: '识图', blurb: 'visionApi describeImageWithVisionApi', trigger: '工具轮内', sources: ['hardcoded:utils/visionApi'], gates: [G.inTurn], visibility: 'local-uncaptured', anchor: 'utils/visionApi.ts:63', pin: 'describeImageWithVisionApi' },
    { site: 'appearance-extract', category: '工具与识图', name: '外貌提取', blurb: 'imageGenFlow ensureAppearanceProfile：人设外貌提取', trigger: '工具轮内', sources: ['hardcoded:utils/imageGenFlow'], gates: [G.inTurn], visibility: 'local-uncaptured', anchor: 'utils/imageGenFlow.ts:146', pin: 'ensureAppearanceProfile' },
];
