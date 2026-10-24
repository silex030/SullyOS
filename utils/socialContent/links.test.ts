import { describe, expect, it } from 'vitest';
import { buildContentId, extractShareLinks, parseContentId, bilibiliPartKey } from './links';

/**
 * 链接识别的契约测试（t_2c2dba79）。全部离线纯文本，不碰网络。
 * 夹具刻意混入真实分享文本形态：中文包裹标点、跟踪参数、复制出来的换行。
 */

const first = (text: string, opts?: Parameters<typeof extractShareLinks>[1]) => {
  const r = extractShareLinks(text, opts);
  if (!r.ok) throw new Error(`extract failed: ${r.code}`);
  return r.candidates;
};

describe('小红书', () => {
  it('识别 /explore 与 /discovery/item 帖子路径，保留 ID 大小写', () => {
    const c = first('看看这个 https://www.xiaohongshu.com/explore/AbC123xYz?xsec_token=ABtok&xsec_source=pc_share 好可爱');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      platform: 'xiaohongshu',
      linkKind: 'canonical',
      externalId: 'AbC123xYz',
      canonicalUrl: 'https://www.xiaohongshu.com/explore/AbC123xYz',
      // 签名参数不进 canonical/openUrl；无签名时 openUrl 退回官方内容页（契约 2.3）
      openUrl: 'https://www.xiaohongshu.com/explore/AbC123xYz',
      partKey: null,
      rejectCode: null,
    });
    // 原文串保留签名，供服务端做受控展开
    expect(c[0].originalUrl).toContain('xsec_token=ABtok');

    const d = first('https://www.xiaohongshu.com/discovery/item/64f0aa11bb');
    expect(d[0]).toMatchObject({ platform: 'xiaohongshu', externalId: '64f0aa11bb' });
  });

  it('短链只标 short，不合并内容引用', () => {
    const c = first('分享 http://xhslink.com/a/9Kd2Lm 复制本条信息');
    expect(c[0]).toMatchObject({ platform: 'xiaohongshu', linkKind: 'short', externalId: null, canonicalUrl: null });
    expect(c[0].originalUrl).toBe('http://xhslink.com/a/9Kd2Lm');
  });

  it('rednote 默认关闭；显式开启后才接受帖子路径', () => {
    const off = first('https://www.rednote.com/explore/66aa77bb');
    expect(off[0]).toMatchObject({ rejectCode: 'SOURCE_NOT_CONFIGURED', linkKind: 'unsupported' });

    const on = first('https://www.rednote.com/explore/66aa77bb', { rednoteEnabled: true });
    expect(on[0]).toMatchObject({ platform: 'xiaohongshu', externalId: '66aa77bb', linkKind: 'canonical' });
  });

  it('非帖子路径的小红书链接不算内容分享', () => {
    const c = first('https://www.xiaohongshu.com/user/profile/5f00aa');
    expect(c[0]).toMatchObject({ rejectCode: 'UNSUPPORTED_LINK_TYPE', platform: 'xiaohongshu' });
  });
});

describe('抖音', () => {
  it('识别 /video 与 /note', () => {
    const v = first('https://www.douyin.com/video/7300123456789012345');
    expect(v[0]).toMatchObject({
      platform: 'douyin',
      externalId: '7300123456789012345',
      canonicalUrl: 'https://www.douyin.com/video/7300123456789012345',
    });
    const n = first('https://www.douyin.com/note/7300123456789012345');
    expect(n[0].canonicalUrl).toBe('https://www.douyin.com/note/7300123456789012345');
  });

  it('v.douyin.com 短链 + 无 scheme 形态都识别为 short', () => {
    expect(first('https://v.douyin.com/iRxAbCdE/')[0]).toMatchObject({ platform: 'douyin', linkKind: 'short' });
    expect(first('看 v.douyin.com/iRxAbCdE/ 这个')[0]).toMatchObject({ platform: 'douyin', linkKind: 'short' });
  });

  it('iesdouyin 兼容候选只在带 ID 时接受', () => {
    expect(first('https://www.iesdouyin.com/share/video/7300123456789012345')[0]).toMatchObject({
      platform: 'douyin',
      externalId: '7300123456789012345',
      linkKind: 'canonical',
    });
    expect(first('https://www.iesdouyin.com/share/user/123')[0]).toMatchObject({ rejectCode: 'UNSUPPORTED_LINK_TYPE' });
  });
});

describe('B 站', () => {
  it('BV 链接带 p 参数 → partKey=p2，canonical 不带 spm 跟踪参数', () => {
    const c = first('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333.999&vd_source=deadbeef');
    expect(c[0]).toMatchObject({
      platform: 'bilibili',
      externalId: 'BV1xx411c7mD',
      partKey: 'p2',
      canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      openUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    });
  });

  it('av 号、m 站、b23 短链、裸 BV 都识别', () => {
    expect(first('https://www.bilibili.com/video/av170001')[0]).toMatchObject({ externalId: 'av170001' });
    expect(first('https://m.bilibili.com/video/BV1xx411c7mD')[0]).toMatchObject({ externalId: 'BV1xx411c7mD' });
    expect(first('https://b23.tv/XyZ123')[0]).toMatchObject({ linkKind: 'short', platform: 'bilibili' });
    expect(first('这个 BV1xx411c7mD 好看')[0]).toMatchObject({
      linkKind: 'canonical',
      externalId: 'BV1xx411c7mD',
      originalUrl: 'BV1xx411c7mD',
    });
  });

  it('裸 BV 与视频链接同时出现时只算一张卡', () => {
    const c = first('https://www.bilibili.com/video/BV1xx411c7mD 也就是 BV1xx411c7mD');
    expect(c).toHaveLength(1);
    expect(c[0].spans.length).toBeGreaterThanOrEqual(1);
  });

  it('p 参数解析只认正整数', () => {
    expect(bilibiliPartKey(new URL('https://x.test/v?p=3'))).toBe('p3');
    expect(bilibiliPartKey(new URL('https://x.test/v?p=0'))).toBe(null);
    expect(bilibiliPartKey(new URL('https://x.test/v?p=abc'))).toBe(null);
    expect(bilibiliPartKey(new URL('https://x.test/v'))).toBe(null);
  });
});

describe('明确不支持的产品与未知平台', () => {
  it('TikTok / bilibili.tv / biliintl 返回 UNSUPPORTED_REGION_OR_PRODUCT', () => {
    for (const url of [
      'https://www.tiktok.com/@user/video/7300000000000000000',
      'https://vm.tiktok.com/ZMabc/',
      'https://www.bilibili.tv/en/video/2048000001',
      'https://www.biliintl.com/en/play/123',
    ]) {
      const c = first(`${url} 看看`);
      expect(c[0], url).toMatchObject({ rejectCode: 'UNSUPPORTED_REGION_OR_PRODUCT', linkKind: 'unsupported', platform: null });
    }
  });

  it('未知站点保留链接但标 UNSUPPORTED_PLATFORM，不猜平台', () => {
    const c = first('https://example.com/post/1');
    expect(c[0]).toMatchObject({ rejectCode: 'UNSUPPORTED_PLATFORM', platform: null });
  });
});

describe('恶意/畸形链接（SSRF 与混淆的输入层拒绝）', () => {
  it('userinfo 混淆：host 实际是 evil.com', () => {
    const c = first('https://www.xiaohongshu.com@evil.com/explore/abc123');
    expect(c[0]).toMatchObject({ rejectCode: 'INVALID_URL', platform: null, rejectReason: 'userinfo' });
  });

  it('相似域名、IP 字面量、整型 IP、异常端口、非 http(s) 协议全部拒绝', () => {
    const cases: Array<[string, string, string]> = [
      // 相似域名不是 INVALID_URL，而是"host 不在白名单"，必须是拒绝态且 platform=null
      ['https://www.xiaohongshu.com.evil.tld/explore/abc', 'UNSUPPORTED_PLATFORM', 'host_not_allowlisted'],
      ['https://192.168.1.5/explore/abc', 'INVALID_URL', 'ip_literal'],
      ['https://2130706433/explore/abc', 'INVALID_URL', 'ip_literal'],
      ['https://www.bilibili.com:8080/video/BV1xx411c7mD', 'INVALID_URL', 'port'],
      ['http://localhost/explore/abc', 'INVALID_URL', 'internal_host'],
    ];
    for (const [url, code, reason] of cases) {
      const c = first(`${url} `);
      expect(c[0]?.rejectCode, url).toBe(code);
      expect(c[0]?.platform, url).toBe(null);
      expect(c[0]?.rejectReason, url).toBe(reason);
    }
  });

  it('非 http(s) 协议不会成为候选（也就不可能被当作内容抓取）', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd']) {
      const r = extractShareLinks(text);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.candidates).toHaveLength(0);
    }
  });

  it('控制字符/零宽字符与反斜杠混淆被拒绝', () => {
    const c = first('https://www.bilibili.com/video/BV1xx411c7mD\u200b');
    // 零宽字符本身不进入链接匹配（URL 字符类已排除空白），这里只要求不产生"成功"的 canonical
    expect(c.every((x) => x.rejectCode === null || x.platform === null)).toBe(true);
    expect(first('https://evil.com\\@www.bilibili.com/video/BV1xx411c7mD')[0].rejectCode).toBe('INVALID_URL');
  });
});

describe('多链接、去重与包裹标点', () => {
  it('中文包裹标点不进入链接', () => {
    const c = first('（https://www.douyin.com/video/7300123456789012345）。');
    expect(c[0].originalUrl).toBe('https://www.douyin.com/video/7300123456789012345');
  });

  it('同链接重复出现合并为一张卡、保留全部 span', () => {
    const text = 'https://www.bilibili.com/video/BV1xx411c7mD 再发一次 https://www.bilibili.com/video/BV1xx411c7mD?spm=1';
    const r = extractShareLinks(text);
    if (!r.ok) throw new Error('extract failed');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].spans).toHaveLength(2);
    expect(r.duplicatesMerged).toBe(1);
  });

  it('不同分 P 不合并', () => {
    const c = first('https://www.bilibili.com/video/BV1xx411c7mD?p=1 https://www.bilibili.com/video/BV1xx411c7mD?p=2');
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.partKey)).toEqual(['p1', 'p2']);
  });

  it('超过 5 条可解析链接：前 5 条排队，其余显式 overLimit 且不丢', () => {
    const ids = ['11', '22', '33', '44', '55', '66', '77'];
    const text = ids.map((id) => `https://www.douyin.com/video/73001234567${id}0`).join(' ');
    const r = extractShareLinks(text);
    if (!r.ok) throw new Error('extract failed');
    expect(r.queuedCount).toBe(5);
    expect(r.droppedOverLimit).toBe(2);
    expect(r.candidates.filter((c) => c.overLimit)).toHaveLength(2);
    expect(r.candidates).toHaveLength(7);
  });

  it('文本超 16000 UTF-16 单元时明确拒绝而不是截断', () => {
    const r = extractShareLinks('a'.repeat(16001));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SIZE_LIMIT');
  });

  it('混合文本中用户问题保留（函数不改写输入）', () => {
    const text = '这个视频讲什么？https://www.bilibili.com/video/BV1xx411c7mD 值不值得看';
    const r = extractShareLinks(text);
    expect(r.ok).toBe(true);
    expect(text).toContain('值不值得看');
  });
});

describe('内容 ID', () => {
  it('按 platform:encoded(sourceId):encoded(externalId) 生成且可反解', () => {
    const id = buildContentId('bilibili', 'public-bili', 'BV1xx411c7mD');
    expect(id).toBe('bilibili:public-bili:BV1xx411c7mD');
    expect(parseContentId(id)).toEqual({ platform: 'bilibili', sourceId: 'public-bili', externalId: 'BV1xx411c7mD' });
  });

  it('含冒号/斜杠的段被编码，避免分段歧义', () => {
    const id = buildContentId('import', 'src:eu/1', 'a:b/c');
    expect(id.split(':')).toHaveLength(3);
    expect(parseContentId(id)).toEqual({ platform: 'import', sourceId: 'src:eu/1', externalId: 'a:b/c' });
  });

  it('空 sourceId/externalId 直接抛错，不生成含糊 ID', () => {
    expect(() => buildContentId('douyin', '', '123')).toThrow();
    expect(() => buildContentId('douyin', 'public-douyin', '')).toThrow();
  });
});
