/** nodeTransport.js 的类型声明（仓库未安装 @types/node，故手写最小契约）。 */
import type { Transport } from './safeFetch';

/**
 * 把连接绑定到 pinnedAddresses[0] 的 http(s) Transport。
 * 只应在 Node ≥ 18 使用；Cloudflare Workers 等无法绑定的运行时必须拒绝该路径。
 */
export declare const nodePinningTransport: Transport;
