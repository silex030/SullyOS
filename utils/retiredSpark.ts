/**
 * 已退役「Spark 社交 App」的启动期一次性清理。
 *
 * 2026-10-24 减法：Spark（AppID `social`，`apps/SocialApp.tsx`）整块删除。
 * 代码删干净了，但**设备上可能还留着它自己的几个 localStorage 键**；
 * 这些键不属于任何现存功能，留着只会让下一次清理普查再挖一遍。
 *
 * 边界（刻意做窄，和 `retiredExternalAgent.ts` 同一套纪律）：
 *   - 只删下面这张**精确键名**清单，绝不 `clear()`、绝不用前缀通配；
 *   - **不动 `spark_char_handles`**：那是 Spark 与朋友圈 MomentsApp 共写的角色马甲表，
 *     朋友圈仍在正常读写（`apps/MomentsApp.tsx`、`utils/chatPrompts.ts`）；
 *   - 不动 IndexedDB：`social_posts` 表与 `spark_social_profile` / `spark_user_bg`
 *     两个 assets 行是用户内容/备份的一部分（`social_posts` 还被朋友圈共用），
 *     删存储不在本模块职责内，宁可留孤儿也不做破坏性删除；
 *   - 幂等：没有残留时立刻返回 0，不写日志、不写存储；
 *   - localStorage 被禁（隐私模式 / 沙箱 iframe / 配额异常）时静默返回，不阻断启动。
 *
 * 旧备份包里的 `socialAppData.userId` 由导入端自然回写（见 `context/OSContext.tsx`
 * 的 restore 分支）：备份是用户资产，回写后下次启动这里会再清一次，无副作用。
 */

/** Spark 独占、且没有任何现存功能读取的 localStorage 键（精确匹配，不做前缀匹配）。 */
export const RETIRED_SPARK_STORAGE_KEYS: readonly string[] = [
    'spark_douban_groups', // 豆瓣小组清单
    'spark_douban_hidden', // 已删除的豆瓣帖 id（最多 500 个）
    'spark_user_id', // Spark 内展示用的用户号
];

/** 只依赖这两样，方便测试注入不可用的实现。 */
export type RetiredStorageLike = Pick<Storage, 'getItem' | 'removeItem'>;

const resolveLocalStorage = (): Storage | null => {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
        // 某些沙箱环境里「读」localStorage 本身就抛 SecurityError。
        return null;
    }
};

/**
 * 清掉 Spark 留下的本机键。
 *
 * @param storage 默认取全局 localStorage；显式传 null 表示「没有存储可用」。
 * @returns 实际删掉的键数（0 = 没有残留 / 存储不可用）。
 */
export const retireSparkStorage = (
    storage: RetiredStorageLike | null = resolveLocalStorage(),
): number => {
    if (!storage) return 0;

    let removed = 0;
    for (const key of RETIRED_SPARK_STORAGE_KEYS) {
        try {
            // removeItem 对不存在的键是空操作，先 getItem 才能数准「实际清掉几个」。
            if (storage.getItem(key) === null) continue;
            storage.removeItem(key);
            removed += 1;
        } catch {
            // 单个键删不掉不影响其它键，也不影响启动。
        }
    }

    if (removed > 0) {
        console.log(`[RetiredSpark] removed ${removed} Spark key(s)`);
    }
    return removed;
};
