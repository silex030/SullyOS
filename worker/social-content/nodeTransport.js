/**
 * 连接绑定的 node Transport（t_2c2dba79，契约 7.1「连接必须绑定已验证解析结果」）。
 *
 * 单独用 .js 写：仓库没装 @types/node，TS 侧只通过同目录 nodeTransport.d.ts 的声明使用。
 * 对外契约见 safeFetch.ts 的 TransportRequest/TransportResponse。
 *
 * 关键点：http(s).request 的 lookup 被固定成 safeFetch 已验证过的地址，
 * 因此即使 DNS 在"验证完"和"连出去"之间被篡改（DNS 重绑定），连接也不会去攻击者地址。
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const MAX_HEADER_CHARS = 16 * 1024;

/** @type {import('./safeFetch').Transport} */
export const nodePinningTransport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const pinned = req.pinnedAddresses && req.pinnedAddresses[0];
    if (!pinned) return reject(new Error('pinned_address_required'));

    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const family = pinned.includes(':') ? 6 : 4;
    // Node ≥20 的 Agent 会用 lookup(host, { all: true }, cb) —— 此时回调必须给
    // [{ address, family }] 数组，给字符串会报 ERR_INVALID_IP_ADDRESS（集成联调时实测）。
    // 两种调用形态都返回同一个已验证地址，仍然不重新解析域名。
    const lookup = (_hostname, options, cb) =>
      options && options.all ? cb(null, [{ address: pinned, family }]) : cb(null, pinned, family);

    const clientReq = mod(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        // 关掉 SNI 与 Host 的隐式改写：Host 头由 url.hostname 决定，证书按域名校验
        lookup,
      },
      (res) => {
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k] = v.slice(0, MAX_HEADER_CHARS);
          else if (Array.isArray(v)) headers[k] = v.join(', ').slice(0, MAX_HEADER_CHARS);
        }
        resolve({
          status: res.statusCode || 0,
          headers,
          // 不读正文的分支（重定向/非 2xx）必须主动释放：否则 keep-alive 连接被未读响应占住，
          // 重定向链上的 socket 会一路泄漏到进程退出。
          discard: () => {
            try {
              res.destroy();
            } catch {}
          },
          readBody: (limitBytes) =>
            new Promise((done, fail) => {
              const chunks = [];
              let bytes = 0;
              let truncated = false;
              res.on('data', (chunk) => {
                if (truncated) return;
                if (bytes + chunk.length > limitBytes) {
                  const room = Math.max(0, limitBytes - bytes);
                  if (room > 0) chunks.push(chunk.subarray(0, room));
                  bytes = limitBytes;
                  truncated = true;
                  // 超限立刻断开，不把压缩炸弹/超大响应读完
                  res.destroy();
                  done({ text: Buffer.concat(chunks).toString('utf8'), bytes, truncated });
                  return;
                }
                chunks.push(chunk);
                bytes += chunk.length;
              });
              res.on('end', () => {
                if (truncated) return;
                done({ text: Buffer.concat(chunks).toString('utf8'), bytes, truncated });
              });
              res.on('error', fail);
            }),
        });
      },
    );
    clientReq.on('error', reject);
    clientReq.end();
  });
