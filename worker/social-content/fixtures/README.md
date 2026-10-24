# social-content 夹具说明（t_2c2dba79）

这些文件是**手工构造的脱敏/虚构夹具**，用于验证适配器与安全策略的解析逻辑，
**不是**真实抓取的平台响应，也不代表任何平台当前的真实字段布局：

- `bilibili_view.json`：B 站 view 接口的最小成功响应形状（标题/作者/统计/分P）。
- `bilibili_player.json`：player/v2 原生字幕轨列表形状。
- `bilibili_subtitle.json`：字幕 JSON 的 `body[]` 形状。
- `bilibili_replies.json`：评论第 1 页（热度排序，5 条）形状。
- `douyin_share_page.html`：抖音分享页里 `window._ROUTER_DATA` 的形状示例（虚构账号与文案）。

真实平台验证结果必须单独记录在卡片/验收文档里，不能用这些夹具冒充"已接通"（契约 8、9）。
所有账号名、ID、URL 均为虚构；未包含任何 Cookie、token 或真实用户数据。
