/**
 * SSRF 防护的纯策略层（t_2c2dba79，契约 7.1）。
 *
 * 这里只做判定，不做 I/O：给定 URL/主机/IP 字符串，回答"能不能连"。
 * 真正的连接在 safeFetch.ts，每跳都回来调用这里的函数复验。
 *
 * 判定顺序（与契约一致）：协议 → userinfo → 端口 → 主机名形态 → 精确域名白名单
 * → DNS 解析出全部地址 → 每个地址必须公网。任何一步失败整条请求拒绝，不做"部分放行"。
 */

/** 契约 7.1 明确的硬上限。 */
export const SSRF_LIMITS = {
  maxRedirects: 5,
  maxUrlLength: 4096,
} as const;

export type IpClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'metadata'
  | 'reserved'
  | 'multicast'
  | 'unspecified'
  | 'documentation'
  | 'benchmarking'
  | 'ula'
  | 'ipv4_mapped';

export interface IpVerdict {
  ok: boolean;
  cls: IpClass;
  /** 拒绝原因（诊断用，不含原始 URL）。 */
  reason: string;
}

const ipv4ToInt = (parts: number[]): number =>
  ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];

function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = base.split('.').map(Number);
  const baseInt = ipv4ToInt(b);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (baseInt & mask) >>> 0;
}

/** 只接受标准点分十进制；前导零（010.0.0.1）按畸形拒绝，避免八进制歧义。 */
export function parseIpv4(raw: string): number[] | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith('0')) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv4 分类。169.254.169.254 / 100.100.100.200 等云元数据地址单独标出。 */
export function classifyIpv4(raw: string): IpVerdict {
  const parts = parseIpv4(raw);
  if (!parts) return { ok: false, cls: 'reserved', reason: 'malformed_ipv4' };
  const ip = ipv4ToInt(parts);
  const reject = (cls: IpClass, reason: string): IpVerdict => ({ ok: false, cls, reason });

  if (inCidr4(ip, '0.0.0.0', 8)) return reject('unspecified', 'this_network');
  if (inCidr4(ip, '127.0.0.0', 8)) return reject('loopback', 'loopback');
  if (inCidr4(ip, '10.0.0.0', 8)) return reject('private', 'rfc1918_10');
  if (inCidr4(ip, '172.16.0.0', 12)) return reject('private', 'rfc1918_172_16');
  if (inCidr4(ip, '192.168.0.0', 16)) return reject('private', 'rfc1918_192_168');
  if (inCidr4(ip, '169.254.0.0', 16)) {
    // 云环境元数据端点固定落在链路本地；单独命名便于审计
    if (ip === ipv4ToInt([169, 254, 169, 254])) return reject('metadata', 'cloud_metadata');
    return reject('link_local', 'link_local');
  }
  // 阿里云/腾讯云内部元数据与内网服务
  if (inCidr4(ip, '100.100.100.0', 24)) return reject('metadata', 'cloud_metadata_internal');
  if (inCidr4(ip, '100.64.0.0', 10)) return reject('cgnat', 'rfc6598_cgnat');
  if (inCidr4(ip, '192.0.0.0', 24)) return reject('reserved', 'ietf_protocol_assignments');
  if (inCidr4(ip, '192.0.2.0', 24)) return reject('documentation', 'test_net_1');
  if (inCidr4(ip, '198.18.0.0', 15)) return reject('benchmarking', 'benchmarking');
  if (inCidr4(ip, '198.51.100.0', 24)) return reject('documentation', 'test_net_2');
  if (inCidr4(ip, '203.0.113.0', 24)) return reject('documentation', 'test_net_3');
  if (inCidr4(ip, '224.0.0.0', 4)) return reject('multicast', 'multicast');
  if (inCidr4(ip, '240.0.0.0', 4)) return reject('reserved', 'reserved_240');
  if (ip === ipv4ToInt([255, 255, 255, 255])) return reject('reserved', 'broadcast');
  return { ok: true, cls: 'public', reason: 'public' };
}

/** 展开 IPv6 成 8 个 hextet；内嵌 IPv4 会被换算。返回 null 表示畸形。 */
export function expandIpv6(raw: string): number[] | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;
  // 去掉 zone id（fe80::1%eth0）
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  let tailV4: number[] = [];
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tailV4 = [(v4[0] << 8) + v4[1], (v4[2] << 8) + v4[3]];
    s = s.slice(0, lastColon + 1) + (s.endsWith(':') ? '' : '');
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }

  const doubleColon = s.indexOf('::');
  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let head: number[] | null;
  let tail: number[] | null;
  if (doubleColon >= 0) {
    if (s.indexOf('::', doubleColon + 1) >= 0) return null; // 多个 '::'
    head = parseGroups(s.slice(0, doubleColon));
    tail = parseGroups(s.slice(doubleColon + 2));
  } else {
    head = parseGroups(s);
    tail = [];
  }
  if (!head || !tail) return null;

  const total = head.length + tail.length + tailV4.length;
  if (total > 8) return null;
  const fill = 8 - total;
  if (doubleColon < 0 && fill !== 0) return null;
  const groups = [...head, ...Array(fill).fill(0), ...tail, ...tailV4];
  return groups.length === 8 ? groups : null;
}

/** IPv6 分类。ULA/链路本地/IPv4 映射/回环/文档段一律拒绝；内嵌 IPv4 走 IPv4 判定。 */
export function classifyIpv6(raw: string): IpVerdict {
  const g = expandIpv6(raw);
  if (!g) return { ok: false, cls: 'reserved', reason: 'malformed_ipv6' };
  const reject = (cls: IpClass, reason: string): IpVerdict => ({ ok: false, cls, reason });

  const allZero = g.every((x) => x === 0);
  if (allZero) return reject('unspecified', 'unspecified');
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return reject('loopback', 'loopback');
  // IPv4 映射 ::ffff:a.b.c.d
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    const verdict = classifyIpv4(v4.join('.'));
    // 无论内嵌地址是否公网，映射形态本身一律拒绝（契约 7.1 明确拒 IPv6 映射 IPv4）
    return { ok: false, cls: 'ipv4_mapped', reason: `ipv4_mapped_${verdict.reason}` };
  }
  // 兼容式映射 ::a.b.c.d（::1.2.3.4 之类）
  if (g.slice(0, 6).every((x) => x === 0) && (g[6] !== 0 || g[7] !== 0)) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    const verdict = classifyIpv4(v4.join('.'));
    return { ok: false, cls: 'ipv4_mapped', reason: `compat_mapped_${verdict.reason}` };
  }
  if ((g[0] & 0xfe00) === 0xfc00) return reject('ula', 'unique_local');
  if ((g[0] & 0xffc0) === 0xfe80) return reject('link_local', 'link_local');
  if ((g[0] & 0xff00) === 0xff00) return reject('multicast', 'multicast');
  if (g[0] === 0x2001 && g[1] === 0x0db8) return reject('documentation', 'documentation');
  return { ok: true, cls: 'public', reason: 'public' };
}

/** 任意 IP 字面量（v4/v6）判定；不是字面量返回 null。 */
export function classifyIpLiteral(raw: string): IpVerdict | null {
  const host = raw.trim().replace(/^\[|\]$/g, '');
  if (parseIpv4(host)) return classifyIpv4(host);
  if (host.includes(':')) return classifyIpv6(host);
  return null;
}

/** DNS 返回的每个地址都必须是公网；有一个私有/保留就整体拒绝（不做部分放行）。 */
export function checkResolvedAddresses(addresses: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (!addresses || addresses.length === 0) return { ok: false, reason: 'dns_no_answer' };
  for (const addr of addresses) {
    const verdict = classifyIpLiteral(addr);
    if (!verdict) return { ok: false, reason: 'dns_unparsable_address' };
    if (!verdict.ok) return { ok: false, reason: `${verdict.cls}:${verdict.reason}` };
  }
  return { ok: true };
}

/** 平台/媒体 CDN 白名单。精确 host 匹配，不做后缀模糊（相似域名一律不认）。 */
export const PLATFORM_HOSTS = {
  xiaohongshu: ['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'www.xhslink.com'],
  rednote: ['www.rednote.com', 'rednote.com'],
  douyin: ['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'],
  bilibili: ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'b23.tv', 'api.bilibili.com'],
  /** 二次请求（图片/字幕）单独白名单：不允许多余跳板。 */
  bilibiliCdn: ['i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com', 'aisubtitle.hdslb.com'],
} as const;

export type Allowlist = readonly string[];

export interface UrlPolicyOptions {
  /** 允许的精确 host 列表。 */
  allowedHosts: Allowlist;
  /** 是否允许 IP 字面量（永远 false；保留字段是为了显式传错时能拒绝）。 */
  allowIpLiteral?: false;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * URL 层校验：协议、userinfo、端口、控制字符、IDN/相似域名、IP 字面量、精确白名单。
 * 注意：这里**不**做 DNS——解析结果校验在 safeFetch 每跳做。
 */
export function assertUrlAllowed(rawUrl: string, opts: UrlPolicyOptions): { url: URL; host: string } {
  if (typeof rawUrl !== 'string' || !rawUrl) throw new SsrfError('INVALID_URL', 'empty_url');
  if (rawUrl.length > SSRF_LIMITS.maxUrlLength) throw new SsrfError('INVALID_URL', 'url_too_long');
  if (CONTROL_CHARS.test(rawUrl)) throw new SsrfError('UNSAFE_URL', 'control_chars');
  if (rawUrl.includes('\\')) throw new SsrfError('UNSAFE_URL', 'backslash_obfuscation');

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError('INVALID_URL', 'unparsable_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('UNSAFE_URL', 'protocol_not_http');
  if (u.username || u.password) throw new SsrfError('UNSAFE_URL', 'userinfo_present');
  if (u.port && u.port !== '80' && u.port !== '443') throw new SsrfError('UNSAFE_URL', 'non_default_port');

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new SsrfError('INVALID_URL', 'empty_host');

  // 非 ASCII / punycode：只允许白名单里显式列出的 ASCII host，避免同形字绕过
  if (/[^\x20-\x7e]/.test(host)) throw new SsrfError('UNSAFE_URL', 'non_ascii_host');
  if (host.startsWith('xn--') || host.includes('.xn--')) throw new SsrfError('UNSAFE_URL', 'punycode_host');

  if (classifyIpLiteral(host)) throw new SsrfError('UNSAFE_URL', 'ip_literal_host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SsrfError('UNSAFE_URL', 'internal_hostname');
  }

  if (!opts.allowedHosts.includes(host)) throw new SsrfError('UNSAFE_URL', 'host_not_allowlisted');
  return { url: u, host };
}

/** SSRF 失败：code 用契约错误码，reason 只作诊断，不含原始 URL/凭据。 */
export class SsrfError extends Error {
  readonly code: 'INVALID_URL' | 'UNSAFE_URL';
  readonly reason: string;
  constructor(code: 'INVALID_URL' | 'UNSAFE_URL', reason: string) {
    super(`${code}:${reason}`);
    this.name = 'SsrfError';
    this.code = code;
    this.reason = reason;
  }
}
