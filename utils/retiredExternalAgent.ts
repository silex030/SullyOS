/**
 * 已退役「外部 agent 桥」的启动期一次性清理。
 *
 * 2026-10 减法：桌面「终端」App 整块删除（它遥控用户自己电脑上的 `opencode serve`，
 * 与角色聊天、主动消息、MCP、主代理全零耦合）。代码删干净了，但**设备上可能还留着
 * 旧连接记录**：`localStorage['aetheros.opencode.connection']` 里是地址 + Basic Auth
 * 明文密码。删代码不会删存储，所以这里做一次性清理。
 *
 * 边界（刻意做窄）：
 *   - 只删 `aetheros.opencode.` 前缀的键，绝不 `clear()`，绝不碰用户其它设置；
 *   - 幂等：没有残留时立刻返回 0，不写日志、不写存储；
 *   - localStorage 被禁（隐私模式 / 沙箱 iframe / 配额异常）时静默返回，不阻断启动。
 *
 * 旧备份包里的 `opencodeLocal` 字段由导入端自然忽略（没有对应的 restore 分段，
 * 未知字段不参与落库），这里不额外处理。
 *
 * 挂载点：`context/OSContext.tsx` 启动期的一次性迁移块（与本文件同一入口的还有
 * `seedBuiltinPromptPresets` / `migrateLegacyVoiceOverrides`）。
 */

/** 退役模块用过的 localStorage 键前缀（含 `.`，避免误伤 `aetheros.opencodeXyz` 这类同词键）。 */
export const RETIRED_EXTERNAL_AGENT_KEY_PREFIX = 'aetheros.opencode.';

/** 只依赖这三样，方便测试注入不可用的实现。 */
export type RetiredStorageLike = Pick<Storage, 'length' | 'key' | 'removeItem'>;

const resolveLocalStorage = (): Storage | null => {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
        // 某些沙箱环境里「读」localStorage 本身就抛 SecurityError。
        return null;
    }
};

/**
 * 清掉外部 agent 桥留下的本机键。
 *
 * @param storage 默认取全局 localStorage；显式传 null 表示「没有存储可用」。
 * @returns 实际删掉的键数（0 = 没有残留 / 存储不可用）。
 */
export const retireExternalAgentStorage = (
    storage: RetiredStorageLike | null = resolveLocalStorage(),
): number => {
    if (!storage) return 0;

    let removed = 0;
    try {
        // 先收集再删：边遍历边 removeItem 会让索引错位。
        const doomed: string[] = [];
        const length = typeof storage.length === 'number' ? storage.length : 0;
        for (let i = 0; i < length; i += 1) {
            const key = storage.key(i);
            if (typeof key === 'string' && key.startsWith(RETIRED_EXTERNAL_AGENT_KEY_PREFIX)) {
                doomed.push(key);
            }
        }
        for (const key of doomed) {
            try {
                storage.removeItem(key);
                removed += 1;
            } catch {
                // 单个键删不掉不影响其它键，也不影响启动。
            }
        }
    } catch (e) {
        console.warn('[RetiredExternalAgent] legacy terminal key cleanup skipped', e);
        return removed;
    }

    if (removed > 0) {
        console.log(`[RetiredExternalAgent] removed ${removed} legacy terminal key(s)`);
    }
    return removed;
};
