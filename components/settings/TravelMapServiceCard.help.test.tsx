// @vitest-environment jsdom
/**
 * 设置 · 地图服务「新手填写帮助」的护栏（静态渲染）：
 * - 每个 Key 下面都有可折叠的「不会填？查看步骤」，还有一份总「第一次填写顺序」；
 * - 外链只能是核实过的官方入口，且必须 target=_blank + rel=noopener noreferrer（无 http/ javascript:）；
 * - 文案不许把「申请连接」说成去高德拿配对码，不许让用户把密钥发到聊天里；
 * - Mapbox 必须写成可选、留空也能用，不承诺永久免费。
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TravelMapServiceCard, { TRAVEL_MAP_HELP_LINKS } from './TravelMapServiceCard';
import TravelAnchorCard from './TravelAnchorCard';
import TravelCharCard from '../character/TravelCharCard';

const ALLOWED_HOSTS = new Set([
  'console.amap.com',
  'lbs.amap.com',
  'account.mapbox.com',
]);

const renderCard = () => renderToStaticMarkup(
  React.createElement(TravelMapServiceCard, { runtime: {} as never }),
);

const hrefsOf = (html: string): string[] =>
  [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe('地图服务 · 新手填写帮助', () => {
  const html = renderCard();

  it('总「第一次填写顺序」在申请连接下方，讲清短码交给管理员、不用去高德找配对码', () => {
    expect(html).toContain('data-testid="map-help-order"');
    expect(html).toContain('第一次填写顺序');
    expect(html).toContain('申请连接');
    expect(html).toContain('不用去高德找配对码');
    expect(html).toContain('XXXX-XXXX');
    expect(html).toContain('管理员');
    // 一次性批准后自动连接 + 过期重申
    expect(html).toContain('自动连接');
    expect(html).toContain('重新申请');
  });

  it('明确禁止把 clientSecret / ownerKey / API Key 发到聊天', () => {
    expect(html).toContain('clientSecret');
    expect(html).toContain('ownerKey');
    expect(html).toContain('不要发到聊天');
  });

  it('四个 Key 字段各自有「不会填？查看步骤」折叠块', () => {
    for (const id of ['map-web-key-help', 'map-js-key-help', 'map-js-code-help', 'map-mapbox-help']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html.match(/不会填？查看步骤/g)?.length ?? 0).toBe(4);
  });

  it('Web 服务 Key：已有可复用、服务平台写 Web服务、只粘 key 本身、不混类型', () => {
    expect(html).toContain('不用重新申请');
    expect(html).toContain('Web服务');
    expect(html).toContain('不要粘网站链接');
    expect(html).toContain('不能混用');
    // 只填这一把时的边界：能搜地点/路线，地图画面还缺两项
    expect(html).toContain('地点搜索');
    expect(html).toContain('还缺 JS Key 与安全密钥');
  });

  it('JS Key：同一应用新增、平台写 Web端(JS API)、正式域名白名单、公开配置', () => {
    expect(html).toContain('同一个应用');
    expect(html).toContain('Web端(JS API)');
    expect(html).toContain('web 平台（JS API）'); // 官方原文标签
    // 白名单文案跟当前 host 走：独立部署后自动是自己的域名，不再写死任何人的站点。
    expect(html).toContain(window.location.host);
    expect(html).not.toContain('link.ethernet.bot.cd');
    expect(html).toContain('公开配置');
  });

  it('jscode：服务端保存、不回显、与公开 JS Key 区分', () => {
    expect(html).toContain('jscode');
    expect(html).toContain('保存在服务端');
    expect(html).toContain('jscode 保密');
    expect(html).toContain('不要互相粘贴');
  });

  it('Mapbox：可选、留空可用、pk./sk. 区分、不承诺永久免费', () => {
    expect(html).toContain('可选');
    expect(html).toContain('留空');
    expect(html).toContain('pk.');
    expect(html).toContain('sk.');
    expect(html).toContain('不承诺永久免费');
  });

  it('独立部署说明：本机脚本用法准确、多设备是次入口、不冒充自助注册、不引导找原作者', () => {
    expect(html).toContain('data-testid="map-self-host"');
    expect(html).toContain('本人独立部署');
    // 脚本用法必须和 scripts/travel-pair-admin.mjs 的真实子命令一致
    expect(html).toContain('travel-pair-admin.mjs list');
    expect(html).toContain('travel-pair-admin.mjs approve');
    expect(html).toContain('requestId');
    expect(html).toContain('userId');
    // 边界：不冒充已有自助登录，也不让用户去求人
    expect(html).toContain('不提供匿名自助注册');
    expect(html).toContain('多设备');
    expect(html).not.toContain('小何');
    expect(html).not.toContain('原作者');
  });

  it('保存 ≠ 已出图/已获许可；测试连接可能耗额度', () => {
    expect(html).toContain('保存只把凭据写进服务端');
    expect(html).toContain('不代表地图已经出图');
    expect(html).toContain('可能消耗高德额度');
  });

  it('未配对时只有「申请连接」，不会假报已连接', () => {
    expect(html).toContain('data-testid="pair-request"');
    expect(html).not.toContain('本机已连接');
  });

  it('外链只有核实过的官方入口，且全部 target=_blank + rel=noopener noreferrer', () => {
    const hrefs = hrefsOf(html);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith('https://')).toBe(true);
      const host = new URL(href).host;
      expect(ALLOWED_HOSTS.has(host)).toBe(true);
    }
    const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of anchors) {
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noopener noreferrer"');
    }
    // 四个官方入口都真的出现在页面上
    expect(new Set(hrefs)).toEqual(new Set(Object.values(TRAVEL_MAP_HELP_LINKS)));
  });
});

describe('固定地点 / 自主出行 的说明文案', () => {
  it('固定地点卡：先选城市再搜、不填楼栋房号、不是实时定位', () => {
    const html = renderToStaticMarkup(
      React.createElement(TravelAnchorCard, { runtime: {} as never }),
    );
    expect(html).toContain('先填城市');
    expect(html).toContain('不填门牌、楼栋、单元、房号');
    expect(html).toContain('不是设备定位');
    expect(html).not.toContain('navigator.geolocation');
  });

  it('自主出行：去向由角色决定，用户只给总授权，没有新增可填参数', () => {
    const html = renderToStaticMarkup(
      React.createElement(TravelCharCard, { charId: 'c1', runtime: {} as never }),
    );
    expect(html).toContain('data-testid="travel-char-authorization"');
    expect(html).toContain('由 TA 自己决定');
    expect(html).toContain('总授权');
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('type="number"');
  });
});
