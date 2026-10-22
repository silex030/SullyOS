// 备份覆盖兜底（Step 5 收口）：按 db.objectStoreNames 动态枚举，把「登记清单」之外、
// 且导入端已支持恢复的 store 自动补进导出集合——杜绝新加 store 忘记登记导致整类数据
// 漏出备份（历史上剧院/家园/生活记录都漏过，本轮实查 xhs_owned_posts 仍在漏）。
//
// 语义约定：
//  - EXCLUDED 永不进包：blob_assets（二进制已由 v3 blobs/* 旁路统一带走）与运行态
//    记录表（api_call_log 保留近 5 天）。blobRef 令牌在任何 store 的 JSON 里都原样
//    进包，恢复端 DB.importFullData 后由 restoreBlobRefsDeep 用 blob_assets 重放。
//  - KNOWN 是导入端「已实现恢复」的字段映射（store → FullBackupData 字段）。OSContext
//    的主 switch 已包含同名 case；exportSwitchDefaultCase 用它做漂移防护：未来新登记
//    的 store 即使忘了写 case，也会按映射自动落进 backupData（单例 store 取首条）。
//  - 不在 KNOWN 里的 store 不进包（导入端尚无恢复语义，硬塞进去 roundtrip 不完整）。

/** 永不进备份包的 store。 */
const EXCLUDED: ReadonlySet<string> = new Set([
    'blob_assets',    // 图片二进制 Blob：v3 blobs/* 旁路统一带走，禁止 getAll 进堆
    'api_call_log',   // 运行态 API 调用记录（保留近 5 天），明确不属于备份范围
]);

/** store → FullBackupData 字段（导入端已支持恢复的集合）。
 * memory_vectors 例外说明：导出不走主 switch（OSContext 经 encodeVectorsForBackup/
 * encodeVectorsForBackupChunked 拼 bin+index，走 writeV2Backup 二进制旁路，避免
 * 遗留 number[] 进 JSON 膨胀）；导入经 assembleV2Backup 重建 data.memoryVectors，
 * 再由 importFullData「记忆向量」段 clear-once 整包写回（keyPath memoryId，不走
 * saveMany 旁路，见 backupFormat.ts 注释）。此处登记仅作覆盖兜底 +
 * exportSwitchDefaultCase 漂移防护的回退映射，主路径仍以二进制旁路为准。
 * 恢复后向量按 memoryId 与 memory_nodes 对齐；备份自带两侧一致，孤向量允许丢弃并记 warn。 */
const KNOWN: Readonly<Record<string, string>> = {
    characters: 'characters',
    character_groups: 'characterGroups',
    messages: 'messages',
    themes: 'customThemes',
    emojis: 'savedEmojis',
    emoji_categories: 'emojiCategories',
    assets: 'assets',
    gallery: 'galleryImages',
    user_profile: 'userProfile',
    diaries: 'diaries',
    tasks: 'tasks',
    anniversaries: 'anniversaries',
    room_todos: 'roomTodos',
    room_notes: 'roomNotes',
    groups: 'groups',
    journal_stickers: 'savedJournalStickers',
    social_posts: 'socialPosts',
    courses: 'courses',
    games: 'games',
    worldbooks: 'worldbooks',
    story_theaters: 'storyTheaters',
    story_theater_presets: 'storyTheaterPresets',
    story_theater_masks: 'storyTheaterMasks',
    novels: 'novels',
    songs: 'songs',
    bank_transactions: 'bankTransactions',
    bank_data: 'bankData',
    xhs_activities: 'xhsActivities',
    xhs_owned_posts: 'xhsOwnedPosts',
    xhs_stock: 'xhsStockImages',
    quizzes: 'quizSessions',
    tarot_readings: 'tarotReadings',
    shopping_orders: 'shoppingOrders',
    guidebook: 'guidebookSessions',
    scheduled_messages: 'scheduledMessages',
    life_sim: 'lifeSimState',
    daily_schedule: 'dailySchedules',
    handbook: 'handbooks',
    trackers: 'trackers',
    tracker_entries: 'trackerEntries',
    hotnews_snapshots: 'hotNewsSnapshots',
    memory_nodes: 'memoryNodes',
    memory_vectors: 'memoryVectors',
    memory_links: 'memoryLinks',
    topic_boxes: 'topicBoxes',
    anticipations: 'anticipations',
    event_boxes: 'eventBoxes',
    room_plates: 'roomPlates',
    digest_reports: 'digestReports',
    memory_batches: 'memoryBatches',
    pixel_home_assets: 'pixelHomeAssets',
    pixel_home_layouts: 'pixelHomeLayouts',
    vr_novels: 'vrNovels',
    vr_annotations: 'vrAnnotations',
    cc_custom_parts: 'customCreatorParts',
    vr_music: 'vrMusicRoom',
    vr_guestbook: 'vrGuestbook',
    vr_scripts: 'vrScripts',
    vr_plays: 'vrStagedPlays',
    vr_presets: 'vrPresets',
    vr_letters: 'vrLetters',
    vr_settings: 'vrSettings',
    worlds: 'worlds',
    world_episodes: 'worldEpisodes',
    airp_events: 'airpEvents',
    airp_world: 'airpWorlds',
    autonomous_outbox: 'autonomousOutbox',
    autonomous_heartbeats: 'autonomousHeartbeats',
    airp_workflow_plans: 'autonomyWorkflowPlans',
    life_records: 'lifeRecords',
    med_plans: 'medPlans',
    life_record_settings: 'lifeRecordSettings',
    prompt_presets: 'promptPresets',
    preset_packs: 'presetPacks',
    preset_pack_active: 'activePresetPackId',
    preset_regexes: 'presetRegexes',
};

/** 单例落法的 store：FullBackupData 里存首条对象/记录而非数组（switch 特判同款语义）。 */
export const SINGLETON_BACKUP_STORES: ReadonlySet<string> = new Set([
    'life_sim', 'bank_data', 'vr_music', 'vr_guestbook', 'user_profile',
]);

/**
 * 计算需要兜底补齐的 store（保持 objectStoreNames 的稳定顺序，方便日志 diff）。
 * @param storeNames       IDBDatabase.objectStoreNames（DOMStringList 可直接迭代）
 * @param registeredStores 导出清单已登记的 store（allStores 或全模式合并集）
 */
export function findUnregisteredBackupStores(
    storeNames: Iterable<string>,
    registeredStores: Iterable<string>,
): string[] {
    const registered = new Set(registeredStores);
    const result: string[] = [];
    for (const name of storeNames) {
        if (registered.has(name)) continue;
        if (EXCLUDED.has(name)) continue;
        if (!KNOWN[name]) continue; // 导入端尚无恢复语义的 store 不进包（保证 roundtrip 完整）
        result.push(name);
    }
    return result;
}

/** 测试与导出循环共用：读 KNOWN 映射快照。 */
export const knownBackupStoreFieldMap = (): Readonly<Record<string, string>> => ({ ...KNOWN });

/** 测试用：EXCLUDED 快照。 */
export const excludedBackupStores = (): ReadonlySet<string> => new Set(EXCLUDED);

/**
 * 导出循环收尾兜底：枚举 db.objectStoreNames，把登记清单遗漏、且导入端已支持恢复的
 * store 追加进 storesToProcess。返回补齐清单（空数组 = 登记完备，无兜底发生）。
 * 动态 import('./db') 取库句柄：保持本模块零 IDB 依赖，node 单测可直接钉纯函数。
 */
export const ensureBackupStoresCovered = async (
    storesToProcess: string[],
): Promise<string[]> => {
    const { openDB } = await import('./db');
    const db = await openDB();
    // DOMStringList 是 legacy 接口：老规范不保证 Symbol.iterator，按 length+item()
    // 逐个取最稳（真浏览器与 fake-indexeddb 的 DOMStringList 都实现 item()）。
    const rawList = db.objectStoreNames as unknown as { length: number; item(i: number): string | null };
    const names: string[] = [];
    for (let i = 0; i < rawList.length; i++) {
        const n = rawList.item ? rawList.item(i) : (rawList as unknown as any)[i];
        if (typeof n === 'string') names.push(n);
    }
    const missing = findUnregisteredBackupStores(names, storesToProcess);
    if (missing.length > 0) {
        storesToProcess.push(...missing);
        console.warn('[BackupCoverage] 登记清单遗漏的 store 已兜底补进导出集合：', missing);
    }
    return missing;
};

/**
 * 导出主 switch 的 default 分支：按 KNOWN 映射把未显式 case 的 store 落进 backupData。
 * 数组 store 整组赋值；单例 store 取首条（与 vr_music / life_sim 等显式 case 同语义）。
 * 返回是否发生了落包（调用方可据此打 warn，提示把显式 case 补回主 switch）。
 */
export const exportSwitchDefaultCase = (
    backupData: Record<string, any>,
    storeName: string,
    processedData: any,
): boolean => {
    const field = KNOWN[storeName];
    if (!field) return false;
    if (SINGLETON_BACKUP_STORES.has(storeName)) {
        backupData[field] = Array.isArray(processedData) ? (processedData[0] ?? undefined) : (processedData ?? undefined);
    } else {
        backupData[field] = processedData;
    }
    return true;
};
