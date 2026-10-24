import { describe, expect, it } from 'vitest';
import {
  assertUrlAllowed,
  checkResolvedAddresses,
  classifyIpv4,
  classifyIpv6,
  expandIpv6,
  SsrfError,
} from './security';

/**
 * SSRF 策略的契约测试（t_2c2dba79，契约 7.1）。
 * 纯函数，零网络；拒绝态一律给出分类与原因，便于审计时区分"私网"和"畸形"。
 */

describe('IPv4 分类', () => {
  const cases: Array<[string, string, boolean]> = [
    ['8.8.8.8', 'public', true],
    ['223.5.5.5', 'public', true],
    ['10.0.0.5', 'private', false],
    ['172.16.3.4', 'private', false],
    ['172.31.255.255', 'private', false],
    ['192.168.1.1', 'private', false],
    ['127.0.0.1', 'loopback', false],
    ['0.0.0.0', 'unspecified', false],
    ['169.254.169.254', 'metadata', false],
    ['169.254.10.10', 'link_local', false],
    ['100.64.1.1', 'cgnat', false],
    ['224.0.0.1', 'multicast', false],
    ['240.0.0.1', 'reserved', false],
    ['192.0.2.10', 'documentation', false],
    ['198.18.0.1', 'benchmarking', false],
    ['255.255.255.255', 'reserved', false],
  ];
  for (const [ip, cls, ok] of cases) {
    it(`${ip} → ${cls}`, () => {
      const v = classifyIpv4(ip);
      expect(v.cls).toBe(cls);
      expect(v.ok).toBe(ok);
    });
  }

  it('前导零/缺段/越界一律 malformed', () => {
    for (const bad of ['010.0.0.1', '1.2.3', '1.2.3.256', '1.2.3.4.5', 'a.b.c.d']) {
      expect(classifyIpv4(bad).reason, bad).toBe('malformed_ipv4');
      expect(classifyIpv4(bad).ok).toBe(false);
    }
  });
});

describe('IPv6 分类', () => {
  it('展开 8 组 hextet', () => {
    expect(expandIpv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  });

  const cases: Array<[string, string, boolean]> = [
    ['2606:4700::1111', 'public', true],
    ['::1', 'loopback', false],
    ['::', 'unspecified', false],
    ['fe80::1', 'link_local', false],
    ['fc00::1', 'ula', false],
    ['fd12:3456::1', 'ula', false],
    ['ff02::1', 'multicast', false],
    ['2001:db8::1', 'documentation', false],
  ];
  for (const [ip, cls, ok] of cases) {
    it(`${ip} → ${cls}`, () => {
      const v = classifyIpv6(ip);
      expect(v.cls).toBe(cls);
      expect(v.ok).toBe(ok);
    });
  }

  it('IPv4 映射地址（含公网映射）整体拒绝', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:8.8.8.8']) {
      const v = classifyIpv6(ip);
      expect(v.ok, ip).toBe(false);
      expect(v.cls, ip).toBe('ipv4_mapped');
    }
  });

  it('畸形 IPv6 不猜', () => {
    expect(classifyIpv6('1::2::3').reason).toBe('malformed_ipv6');
    expect(classifyIpv6('gggg::1').reason).toBe('malformed_ipv6');
  });
});

describe('解析结果校验', () => {
  it('全公网通过', () => {
    expect(checkResolvedAddresses(['93.184.216.34', '2606:4700::1111'])).toEqual({ ok: true });
  });

  it('混入一个私网地址就整体拒绝（不做部分放行）', () => {
    const r = checkResolvedAddresses(['93.184.216.34', '10.1.2.3']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('private');
  });

  it('解析为空/不可解析都拒绝', () => {
    expect(checkResolvedAddresses([])).toEqual({ ok: false, reason: 'dns_no_answer' });
    expect(checkResolvedAddresses(['not-an-ip'])).toEqual({ ok: false, reason: 'dns_unparsable_address' });
  });
});

describe('URL 策略', () => {
  const allowedHosts = ['www.bilibili.com', 'api.bilibili.com'] as const;

  it('白名单内的 https 地址通过', () => {
    const r = assertUrlAllowed('https://www.bilibili.com/video/BV1xx411c7mD?p=2', { allowedHosts });
    expect(r.host).toBe('www.bilibili.com');
    expect(r.url.searchParams.get('p')).toBe('2');
  });

  it('相似域名不通过（不做后缀模糊匹配）', () => {
    for (const url of [
      'https://www.bilibili.com.evil.tld/video/BV1xx411c7mD',
      'https://evilbilibili.com/video/BV1xx411c7mD',
      'https://www.bilibili.com%2eevil.tld/video/BV1xx411c7mD',
    ]) {
      expect(() => assertUrlAllowed(url, { allowedHosts }), url).toThrow(SsrfError);
    }
  });

  it('userinfo / 非默认端口 / IP 字面量 / 协议 / 控制字符全部拒绝', () => {
    const bads: Array<[string, string]> = [
      ['https://user:pass@www.bilibili.com/video/BV1xx411c7mD', 'userinfo_present'],
      ['https://www.bilibili.com:8080/video/BV1xx411c7mD', 'non_default_port'],
      ['https://1.2.3.4/video/BV1xx411c7mD', 'ip_literal_host'],
      ['https://[::1]/video/BV1xx411c7mD', 'ip_literal_host'],
      ['ftp://www.bilibili.com/video/BV1xx411c7mD', 'protocol_not_http'],
      ['https://www.bilibili.com/video/BV1xx411c7mD\u0000', 'control_chars'],
      ['https://www.bili\u200bbili.com/video/BV1xx411c7mD', 'control_chars'],
    ];
    for (const [url, reason] of bads) {
      try {
        assertUrlAllowed(url, { allowedHosts });
        throw new Error(`should have thrown: ${url}`);
      } catch (err) {
        expect(err, url).toBeInstanceOf(SsrfError);
        expect((err as SsrfError).reason, url).toBe(reason);
      }
    }
  });

  it('punycode / 非 ASCII 域名拒绝（同形字绕过）', () => {
    for (const url of ['https://xn--bilibili-9d0f.com/video/BV1xx411c7mD', 'https://ⓑilibili.com/video/BV1xx411c7mD']) {
      expect(() => assertUrlAllowed(url, { allowedHosts }), url).toThrow(SsrfError);
    }
  });

  it('localhost / .internal 等内网域名拒绝', () => {
    for (const host of ['localhost', 'api.internal', 'foo.local']) {
      expect(() => assertUrlAllowed(`https://${host}/x`, { allowedHosts: [host] }), host).toThrow(SsrfError);
    }
  });
});
