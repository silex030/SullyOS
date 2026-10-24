/**
 * 自主生活 · 执行设备安装 id
 *
 * 语义：一个浏览器（一份 localStorage）就是一个「已绑定安装」。换设备/清站点数据 =
 * 新的安装 id，服务端那边需要显式切换（`POST /devices/register` 不自动抢占）。
 *
 * 为什么不用随机 UUID 直接发：参与设备绑定的是**稳定**标识；每次刷新都换一个的话，
 * 在途许可会全部作废、服务端也会反复触发「换设备要显式确认」。所以这里持久化。
 */

export const AUTONOMY_INSTALLATION_KEY = 'os_autonomy_installation_id_v1';

const memory = { id: '' as string };

const randomId = (): string => {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoApi?.randomUUID) return `inst_${cryptoApi.randomUUID()}`;
  return `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
};

/** 读取（必要时生成并持久化）本机安装 id。缺 localStorage 时进程内复用同一个值。 */
export function getAutonomyInstallationId(): string {
  let store: Storage | null = null;
  try {
    store = typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    store = null;
  }
  if (!store) {
    if (!memory.id) memory.id = randomId();
    return memory.id;
  }
  try {
    const existing = store.getItem(AUTONOMY_INSTALLATION_KEY);
    if (existing && existing.trim()) return existing.trim();
    const created = randomId();
    store.setItem(AUTONOMY_INSTALLATION_KEY, created);
    return created;
  } catch {
    if (!memory.id) memory.id = randomId();
    return memory.id;
  }
}
