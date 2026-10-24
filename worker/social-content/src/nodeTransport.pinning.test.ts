/**
 * 连接绑定回归（集成卡 t_babca897）。
 *
 * 父卡交付时只测了「对本机 http server 真实收发一次」，那台 Agent 走 lookup(host, options, cb)
 * 的非 all 形态；Node 22 的默认 Agent 会用 all:true，父实现给字符串会报
 * ERR_INVALID_IP_ADDRESS —— 联调时三平台全部 NETWORK_ERROR 的根因。
 * 本文件锁住“pinned 生效、无 pinned 拒绝”；all:true 形态没有可注入的钩子，
 * 由真实平台探测（docs/social-content/integration-v1.md 的 412/AUTH_REQUIRED 结果）间接证明。
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { nodePinningTransport } from '../nodeTransport';

describe('nodePinningTransport', () => {
  it('pinned 地址生效（Host 头仍是域名、连接落到 127.0.0.1）', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers.host));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const res = await nodePinningTransport({
        url: `http://pinned.test.local:${port}/probe`,
        method: 'GET',
        headers: { host: `pinned.test.local:${port}` },
        pinnedAddresses: ['127.0.0.1'],
        signal: AbortSignal.timeout(5000),
        maxBytes: 4096,
      });
      expect(res.status).toBe(200);
      const body = await res.readBody(4096);
      expect(body.text).toContain('"ok":true');
      expect(seen).toEqual([`pinned.test.local:${port}`]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('没有 pinned 地址直接拒绝（不退化成裸 fetch）', async () => {
    await expect(
      nodePinningTransport({
        url: 'http://127.0.0.1:1/x',
        method: 'GET',
        headers: {},
        pinnedAddresses: [],
        signal: AbortSignal.timeout(1000),
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/pinned_address_required/);
  });
});
