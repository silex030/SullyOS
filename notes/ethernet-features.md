# ethernet 分支新功能记录（相对上游）

> 这份文件是开发者自用的功能账本：ethernet 相对上游改得太多，靠它回忆「到底加了哪些东西、细节和数据源是什么」。
> **维护约定：每完成一个新功能（或阶段收尾），在对应章节补记，并在文末「更新记录」加一行。** 别忘了。
>
> 统计口径：从上游分叉点（PR #615）算起，截至 2026-09-18，ethernet 领先约 285 个提交，上游快照停在 v3.9.2；本地 `APP_VERSION` 为 `v3.15 (Frameless)`。
> 注意：2026-09-15 之后的内容（含 AIRP 全阶段、酷狗双音源）截至写此记录时仍在本地、尚未 push 到 `origin/ethernet`，下文凡写「本地已落地、待 push/部署」即指这批。
> 主线思路：**把云端依赖搬回自己手里 + 拟真生活系统大扩张**。同步上游的惯例是按提交等价移植（cherry-pick），不整分支合并；接上游改动前先确认 ethernet 是否已有同名等价改动。

---

## 一、后端自托管

- 原本依赖第三方云（Cloudflare）的服务整套搬到自己 VPS：主动消息、推送、主代理中转、心跳保活、定时任务，不再依赖别人的服务器。
- 配套三通道自动备份（含自建 WebDAV 存储与 GitHub 私有备份分支），数据完全自持。
- API 凭据不再固定存放在云端，随每次请求携带过去；导出的备份会自动剔除密钥。
- 加了连接保活机制（长连接每 15 秒发心跳），解决手机网络空闲时被运营商/梯子掐断、生成到一半收不到的问题。
- 唯一的「数据源」就是用户自己的 VPS 和自建服务，没有第三方依赖。

## 二、主动消息大改版

- 即时对话由用户自己的服务器生成，不再依赖第三方推送通道。
- 后台任务体系化：日程提醒、状态更新、定时生成等活儿在页面关闭后也能跑完，结果再回送到手机。
- 设置页支持一键暂停/恢复后台任务；新增「发送测试通知」按钮，方便排查推送问题。
- 推送支持多条折叠 + 一次发到多台设备：定时任务正文推送在 amsg worker 出口按角色复用即时对话 tag、同批第一段响铃后续静默替换；多设备经 `push_subscriptions_multi` 表广播（上限 10 台，404/410 只清对应行），前端面板显示共 N 台设备。
- 设置页「发送测试通知」走后端 `POST /push-test` 真推送（`messageKind:'test'`，只转交页面不写 inbox，30s 同窗 429），方便亲手验证链路。
- 长生成保活：主代理 SSE 每 15 秒发心跳，对抗手机网络空闲掐断；instant `/continue` 改按实际送达判定，catch 不再直接判失败。
- worker 侧 LLM 调用自动补 opencode 身份头（`User-Agent` + `x-opencode-session`），覆盖即时对话/情绪评估/后台任务全部直连调用。
- API Base URL 误填端点后缀容错：结尾多写的 `/chat/completions` 自动剥掉，存量坏值下次载入自动痊愈。
- 流式终止收口：旁路调用被透明流式升级后，见 `[DONE]` 立即断连接（只见 `finish_reason` 给 1.5s 宽限等 usage），修掉人物关系生成等永远卡「生成中」；主代理见 `[DONE]`/`finish_reason` 即 break，不等上游 EOF（防重复计费）。
- 角色天气感知升级为「角色城市 + 用户城市」双城：用户在手机里设的城市会镜像上云，云端服务也能按城市取天气；天气数据来自免费的 **Open-Meteo**（无需 Key）。

## 三、AI 生图

- **聊天里角色真的能发图**：角色想发图时输出一行英文 tag，系统剥离后在后台调用生图服务，文字回复先出、图片生成完追加一条并自动存入相册；一轮多张只执行第一张。
- 支持方/竖/横三种画幅，内置默认负面词保证出图质量；生图请求串行排队，失败和超时有可读的中文提示。
- **统一生图参数**：质量提示词（masterpiece / best quality 等）由生图出口统一前置，任何入口都不用自己加；采样器默认 **ER SDE**、调度器默认 **Linear Quadratic**、步数 12（站点文档上限，超限会自动按上限降级重提）。
- **设置页可测试生图**：「设置 → AI 生图」一键用固定测试词真跑一张方图，内联预览并显示实际 prompt（含质量词）与 seed；只预览、不存相册不进聊天，会消耗一次生图额度，用来验证 Key、代理通道和出图效果。
- **每个角色一份外貌档案**（danbooru 风格 tag）：首次生图自动从角色人设提取；一张图里可以 @ 同场的其他角色，系统会换成各自的外貌描述，保证画对人。
- **聊天加号面板「相册」按钮 = 上传 / 生成二选一**（原聊天楼层长按的生图入口已取消，独立相册 App 也不再有生成入口）：生成只填一句画面描述，模型先分析成 danbooru tag 并按构图自选画幅（竖/横/方），出图后作为「我发的图」上屏、自动存相册、角色照常回应（与上传同一条路）。
- **画风 / 性别在神经链接角色页配**：画风（画师 tag）+ 质量词对生图**通用注入**（含纯景色、聊天自动配图、主动消息、Spark 首图）；性别**只在画面里出现该角色（prompt 含 @角色名）时注入**，并把模型认错的 `1girl/1boy/male/female/male focus/female focus` 全部剔除。四层 tag 统一去重，不会打架或重复。
- **聊天设置里可按角色开关「角色生图」**：缺省开；关掉后该角色自己写的生图标签只剥离不执行（不影响用户在相册里的手动生成，也不影响总开关与其它角色）。
- **生图静默失败可查**：三类情形都留痕（devDebug + console）——已触发 / 被拦下（开关没开、缺 Key、角色开关关，带原因）/ **模型没写标签**（用户这条像是在要图、回复里却没有生图标签时点名）；被拦下时本地路径每 10 分钟节流提示一次去哪开。
- **生图期间聊天页显示「正在加载图片…」**：角色发图后、图片落地前，消息列表末尾挂一条角色头像气泡（口吻是"图片加载中"，不暴露生图属性，像对方在传图）；成功/失败/取消都自动熄灭，刷新页面不残留（见 `utils/imageGenPending.ts`）。
- **要图硬规则 + 按需提醒**：常驻提示词明确「对方明确要照片/自拍/画图时必须真的发出来，只回『拍好了』算没做到」；发送时刻若最后一条用户消息是在要图，再追加一句本轮硬提醒（fire_pack 烘焙模板不吃）。解析器同时容忍全角冒号、中括号间空格等手滑写法。
- 外貌提示词编辑已迁到**角色 App（神经链接）设定页**，支持「从角色设定提取」和「上传参考图解析」（识图模型直接输出 tag）两种自动解析。
- **主动消息、云端即时对话也能发图**：云端只回传「想发图」的请求（不碰 Key、不烧云端额度），图片在手机本地生成，页面开着时即时补上、关着则下次打开补上。
- **发图意图直接触发生图**：提示词明确「想发照片 / 自拍 / 画画 / 分享画面时都要真的生图」，并点名「不要只嘴上说『给你看张照片』却什么都没发」。
- **Spark（社交 App）角色帖首图**：角色发「晒图 / 自拍 / 画画」类帖子时会生成一张 AI 首图当封面（不再是 emoji 大字卡）；与聊天生图共用同一套外貌档案和串行排队，路人帖不配图、每轮刷新最多 2 张。开关关着或没 Key 时提示词里不提配图，模型也不会写。
- 数据源：**latent.moe**（公益免费生图站，按周配额，用完会提示下周再来）。
- 状态说明：聊天内生图已提交入库；主动消息发图和角色页设定迁移于 2026-09-12 完成（写此记录时这批改动尚未提交入库，后续提交后此行可删）。
- **聊天图片工作室（2026-09-22 收尾入库）**：聊天加号面板「相册」= 上传/生成二选一（楼层长按旧入口与独立相册生成入口移除，相册 App 回归纯浏览）；单聊/群聊图片点开展全屏灯箱（`ImageLightbox`，blobref 经 TokenImg 解析，不再开新标签页）；生图期间挂「正在加载图片…」占位气泡（`imageGenPending` 订阅式内存态）；画风/性别按角色页外貌档案注入（画风通用、性别只在 prompt 含 @角色名时注入）；静默失败三分类留痕（已触发/被拦下/模型没写标签）；Spark 角色帖配图（每轮最多 2 张，fire-and-forget 出图后原地更新）；设置页「测试生图」固定词真跑一张（只预览不落库）。latent 采样器/调度器/步数可配（默认 12/er_sde/linear_quadratic 不变，超上限 422 自动降级重提）。

## 四、MCP 与网络体验

- 修复 MCP 公网环境下的跨域问题；默认走主代理中转，连接方式可自选。
- 工具调用次数可自定义、跨轮结果可记忆、手册类资料长期保存、按需加载省 Token。
- 模型列表统一入口，配置 API 时不用四处手动填；LLM 走 **opencode.ai 的 Zen/Go 网关**（如 deepseek-v4-flash 等模型），经自建主代理中转，调用自动带身份头满足上游防风控要求。
- 所有对外请求通道统一管理，连不上时能自动判断是网络问题还是接口问题（错误提示带通道标注）：前端统一走 `utils/externalRequest.ts` 的 `externalFetch(url, { route })` 声明语义（llm/worker/mcp/direct），LLM 系一律走主代理中转 `/agent/v1/*`，搜索/抓取/备份走中心 worker，失败日志自动带通道标注。
- 服务端 CORS 统一契约：全部通道预检「净化回显请求头/方法 + 204 + 鉴权前」，新自定义头零配置放行；参考实现 `worker/shared/cors.ts`，行为由 `worker/corsContract.test.ts` 锁死（改通道后跑它）；单文件 worker 内联同一逻辑。
- 中心 worker 自部署默认 + 来源白名单：构建期 `VITE_PROXY_WORKER_URL` 注入默认 worker，未设回落作者公共实例；`worker/index.js` 新增 `ALLOWED_ORIGINS` 开关（未配 = 全开，名单外浏览器来源 403 且不回 CORS 头），实际值只存 CF 侧不进仓库。

## 五、外卖与购物

- **外卖、购物拆成两个独立 App**，各自有独立图标和入口。
- **外卖 App**：美团外卖式界面，真实店铺（**OpenStreetMap**）+ 品牌 SKU 菜单，商品图统一为本地 SVG；分类覆盖美食外卖、奶茶饮品、甜品蛋糕、超市便利、生鲜果蔬、医药健康、鲜花绿植。
- 外卖点单全流程：购物车、结账、订单列表（按店去重显示最新单）、订单详情；配送状态按时间自动推进（接单 8 分钟、配送 32 分钟、约 40 分钟送达），纯时间驱动不用后台任务。
- 点单可以切换「给谁点」：给自己或某个角色；角色没填收货地址时置灰；从查手机入口以角色身份下单会扣角色名下的卡。
- **店铺列表同名去重（2026-09-18）**：OSM 同一连锁品牌每个分店一条记录导致刷屏（肯德基 191 家、星巴克 340 家）；去重键 = 归一店名（剥括号分店后缀）+ 品牌变体表（15 个实测有变体名的品牌前缀 + CoCo都可/联华超市/可的•KEDI 精确映射，不用 CoCo 前缀以免误伤 Coco Cafe 等独立店），组内保留出现最多的原始店名（平票取月销+评分高者）。源头 `public/shopping/shops.json` 7140→3922 店、`dishes.json` 55936→30651 条（被移除分店的菜品直接丢弃，同品牌菜单相同）；去重由 `scripts/dedup-shopping-json.mjs`（gen-shopping-data.mjs 再生时自动调用）+ 运行时 `utils/shoppingData.ts#dedupShopsByName` 兜底两层保证，`utils/shoppingData.test.ts` 有归并用例和数据护栏锁死。
- **菜单品类修复（2026-09-18）**：详情页每道菜的小字品类原先只有「招牌推荐/热销」（品牌店全标前者、独立小店只两种），且独立小店取菜步长 `i*3` 与池长 6/9 不互质，1094 家店菜单只取到 2-3 种菜并重复多遍（运行时去重后只剩两三道）。修复：`scripts/assign-dish-cat.mjs` 按菜名关键词归类（主食/小吃/饮品/甜品/套餐/热菜/药品/用品，超市 OFF 分类与生鲜/鲜花标签保留）；`scripts/repair-shopping-menus.mjs` 重建 1088 家受影响店铺菜单（复用原菜品 id/价格）；`scripts/recat-shopping-dishes.mjs` 全量重标；`gen-shopping-data.mjs` 同步接入分类器并把池子步长改为 1。4 品类店从 97 家升到 1369 家，菜单长度回到 6-10 道。
- **购物 App**：淘宝式界面，真实商品来自 **OpenFoodFacts**（中国区拉齐 670 条），支持店铺搜索和跨店商品搜索、分页浏览；商品图全 SVG。
- 两类订单都会和银行/记账打通（下单扣卡、订单进账本），并会产生 LLM 拟真购买记录。

## 六、银行与记账

- **银行拟真化**：21 家银行/卡组织的真实风格卡面、品牌渐变色、宫格选卡、卡面翻转动画。
- **角色银行卡视图**：角色有自己的卡和只读流水，在查手机里查看；流水分 ownerId 隔离，不会混进用户的支出统计。
- **记账完善**：支持代记收入、流水正负号显示、退款按收入入账、金额格式全局统一。
- **分类与选卡**：记一笔支持选支出 8 类 / 收入 6 类，并可关联具体银行卡——支出扣卡、收入充卡，删除手动流水自动回滚余额；购物/外卖/角色点单的流水也补上了卡归属（余额在下单流程已扣，不重复）。旧数据「正数金额支出」写法在 BankApp 打开时一次性迁移为负数。
- **收支分离**：银行账本与生活记录记账页都按符号区分收支（支出红 `−`、收入绿 `+`），统计、分类与每日预算只算支出；收入不再被当成赤字。生活记录记账页同步支持收支切换、分类与选卡，且不再混入角色流水。
- **与消费打通**：外卖/购物的下单扣款、角色主动点单（ORDER）扣卡、拟真购买记录全部落到同一套账本里。
- **分类账本卡（2026-09-22 收尾入库）**：分类注册表 `utils/bankCategories.ts`（支出/收入两套 id + 中文名）+ 账务助手 `utils/bankTx.ts`，旧中文分类名经 `resolveCategory` 归一；查手机流水行显示归一分类名 + 卡名后四位；`BankDashboard` 旧面板删除（零引用已验）。

## 七、自习室 / 学习系统

- **EPUB 阅读器**：原文与 AI 总结双模式、白天/护眼/夜间配色、图片持久保存、引用标注行内小图。
- **重复图片检测**：自动统计全书重复图片，用户可自选隐藏（本地计算，不联网）。
- **教学增强**：AI 分层总结、目录层级、讲课模式、浮动导师、总结幻灯片、多套字体库。
- 数据来源：用户自己导入的 EPUB 文件，全部本地解析处理。

## 八、角色感知与世界观

- **透视窗**：角色可查看用户真实设备的操作记录，且由角色自主决定看不看，不是例行公事。数据存于 **Supabase**（原始事件 + 总结两张表，带行级安全 RLS），设备操作经节流后上报，只记行为轨迹。
- **真实地点系统**：接入 **高德 Web 服务**做地理编码与 POI 搜索（Key 自己填，个人认证免费；配额有限——地理编码 15 万次/月、POI 搜索 5000 次/月，所以地点库按城市缓存 30 天）。海外城市高德无权限，自动回落 **Open-Meteo 地理编码**。地点卡验证、日程、日历、世界、见面、搬家、用户城市卡全部使用真实地点。
- **天气与节日**：角色所在地天气联动（Open-Meteo）；中国法定节假日/调休状态机来自 **timor.tech** 节假日接口（按年拉取、本地缓存 7 天；接口失败用内置表兜底，再失败严格降级不改日程）。
- **时光契约**：日历化、支持重复规则、日程内容稳定注入。
- **人际关系**：联系人关系网发散、关系首页双向展示、自定义故事剧场独立。
- **蓝牙外设**：通过浏览器原生 **Web Bluetooth** 配对真实蓝牙设备，可调试试读、订阅通知、保存常用指令；设备与指令数据存在本机并随备份走。角色能感知已连设备并在聊天中调用指令。
- **番茄钟**：水球计时、同伴鼓励与惩罚（落入聊天和记忆）、可拖动悬浮球、12 周热力图、铅笔手绘风界面。
- **塔罗**：
  - 每日一抽（一天一次）与多种牌阵：时间之流（过去/现在/未来）、五张十字、关系牌阵、马蹄牌阵、凯尔特十字等。
  - 抽牌仪式支持选择占卜对象（自己或某个角色），正逆位齐全，每个位置有对应含义。
  - 解读分两层：本地速览永远可用；「让 TA 解读」按需调用 LLM，由指定角色来为你解读。
  - 完整 78 张韦特牌库可浏览（大阿卡纳 + 权杖/圣杯/宝剑/星币四花色）；素材为本地图片。
  - 星空氛围增强：紫罗兰/青玉绿/金三色慢速极光层 + 全屏斜掠流星（可同屏两颗）。
  - 解读分层不变，但角色解读改为连贯散文口吻（不分点、不逐张复述牌义），解读卡为深紫星空金边样式。
  - 星空华彩第二波：银河带 + 三层视差星（亮星十字星芒）+ 北斗七星/仙后座/猎户座/天鹅座连线明灭 + 火流星火花与偶发流星雨；极光加幕帘流光层；标题与占卜台十二宫符号环；牌库改等宽网格（桌面 4 列对齐、手机 2 列，文案按端、hover 金色流光）。
  - 深空景深第三波：WebGL 着色器天空（fbm 星云云团 + 竖向幕帘极光明显横移 + 银河雾，60fps 封顶、按实测帧率自适应降档、失败自动回落 CSS 幕帘）；2D 层扩到 6 组星座满屏常驻 + 星点加亮；Tab 切换背景分层横移（近动远静）而内容纯淡入；新增 z-30 前景散景层盖在内容上；晕影减弱。
  - 第四波视觉重构：极光扩为贯穿全屏的 5 层幕帘（CSS 回落层同步全屏）；星座改仰视半球天穹（天球角度布点 + θ³ 鱼眼投影，桌面 24 / 手机 18 组保持密布、大部分在屏内仅边缘轻微溢出，Tab 切换整片天穹旋转）；流星统一为右下方斜掠；极光带加噪声摆动/厚薄变化/呼吸脉冲去规律化；牌库取消每类首张放大（全部同尺寸网格）、类别提示提高层级避免被 hover 卡遮挡；今日页去掉与顶部牌面重复的「今日运势」牌义块。，连线逐点投影呈弧形、双层描边，8 组星座数据；首页每日牌去掉外围大框、解读正文去掉卡片外壳直接排星空上；「让 TA 解读」改四角 L 形纹样仪式按钮（hover 角纹外扩 + 金色扫光）。
  - 第四波收尾（2026-09-22 入库）：首页鱼眼天穹四件套（`TarotSkyShader`/`TarotParticles`/`TarotBokeh`/`ZodiacRing`）全部接线渲染；解读框 aurora/sky/fisheye 三波样式跟齐。

## 九、提示词与预设

- 全系统提示词目录化：内置目录、运行时解析、分类管理界面，所有提示词可查可改。
- 提示词注入预览、三段式标签分类。
- 语音指南、主动消息情绪评估都接入了提示词目录。
- 新增「预设」App：提示词段落预设管理（含预设合集）。
- **预设套组（2026-09-22，本地已落地、待 push）**：预设从「固定位置片段合集」升级为 SillyTavern 风格套组制——多套切换（「默认预设」不可删）、条目级 role（system/user/assistant）/ 落位（角色卡后 / 历史之后 / 历史内 depth / chatHistory 分界）/ tags 场景过滤（聊天/约会/剧场/写歌/查手机/记忆为空=全场景）；宏 `{{char}} {{user}} {{persona}} {{lastUser}} {{lastAssistant}} {{time}} {{date}}`（钢印与世界书 `{{char}}/{{user}}` 口径统一）；采样参数随套组（温度/TopP/TopK/双惩罚/MaxTokens + 精简模式，缺项回退 API 设置）；输出正则脚本（输入/输出/发模型三作用域 + 测试器，分组 `$1` + 宏替换，非法正则整条跳过；仅显示作用域 v1 未接）；`sullyos.preset-kit` 分享文件导入导出；闲置的注入预览组装器接进 App（逐块 + token 估算）。旧自定义段落一次性迁入「默认预设」（顺序/启停不变）；内置技术模板不动，仅钢印两条纳入套组视野；备份新增 `presetPacks/presetRegexes/activePresetPackId`；DB v78（`preset_packs` + `preset_pack_active` + `preset_regexes`）。参考了 ai-virtual-phone 的预设机制，文件格式不共通。设计见 `docs/superpowers/specs/2026-09-22-preset-kit-system-design.md`。

## 十、桌面与界面体验

- **桌面模式**：宽屏下进入桌面布局，左侧 Dock、桌面一屏主页，窗口大小自适应；版本 `v3.12 (Desktop Shell)` 起为正式桌面壳。
- **Frameless**：去掉仿真手机框，只剩电脑版 / 手机版两态（`v3.15 (Frameless)`）；电脑版判定为「半屏规则 + 绝对下限 + 移动端护栏」（电脑屏上宽度达到半屏或 `>= 900` 进电脑版，手机/平板屏沿用 `width >= 1024`，高度不参与）。
- **宽而矮窗口**：手机形态主页新增紧凑档 + 整页缩放到一屏（`FitPage` 按可视高缩放，不做纵向滚动；方形组件限宽防巨图）。
- **桌面 polish**：相册/书架/商品网格桌面分支自适应列数、手账选本桌面限宽居中；全 App 按钮状态过渡统一（200ms 颜色 + 150ms 按压缩放，respect 减少动效）。
- **滚轮翻页修复**：半屏手机形态下滚轮只翻页不误滚（只认真滚动容器，被 `contain: paint` 裁剪的假溢出容器不再拦截）。
- **启动器改版**：Dock 与桌面网格共用一套排序，支持长按编辑、跨区域拖动互换；手机主网格 4x4 紧凑图标。
- **动效统一**：全 App 页面切换、弹层入场、按钮按压、编辑抖动统一动效，并适配系统的「减少动效」偏好。
- **聊天图片点开看大图**：单聊与群聊点图片缩略图打开全屏灯箱（复用 TokenImg，blobref / data: / 外链通吃）；普通图居中完整显示，超长图（高宽比 > 1.6）按宽度铺满、可纵向滚动；点遮罩、右上角按钮、Esc、系统返回键都能关；群聊不再开新标签页。
- ~~**终端 App**~~（已于 2026-10-22 整块退役，见「减法项」）：手机远程控制电脑上的 opencode。

## 十一、新内容来源

- 聊天里的 **B站 / 豆瓣 / 小红书 / 普通网页**链接会生成内容卡片，能读取字幕、正文、热评并喂给角色。
- **B站**：走官方公开接口（稿件信息、CC 字幕、预览帧、素材代理），全程不需要登录、不需要账号。
- **豆瓣**：走 m 站的匿名接口（小组话题、详情、评论），用 iPhone UA + 豆瓣 Referer 过风控，列表 120 秒内存缓存；图片只放行豆瓣自家图床。Spark 社区据此混入豆瓣小组真实帖子，预置了多个实测活跃小组。
- **小红书**：走用户自己配置的 xhs-lite 服务，正文全量抓取、评论按赞排序。
- **小红书 VPS 会话桥（2026-09-22 代码入库、部署待做）**：VPS 常驻 camofox 浏览器维护登录态，cookie 加密只存 VPS；前端/主动消息切「VPS 托管」后只带随机 token 调用（cookie 永不上云、不进 localStorage）；失效扫一次码即可。实现 `vps-backend/src/xhs/`（store/bridge/collector/run）+ systemd/Caddy 部署件；运维手册 `docs/xhs-vps-session.md`。
- **识图策略**：以上卡片如果需要看图，遵守「零额外 LLM 调用」红线——多帧拼成一张图、只调一次、结果永久缓存。

## 十二、稳定性与质量

- 修复历史遗留的中文乱码问题，并加了防复发检查（全仓扫描，出现乱码即测试失败）。
- 备份更可靠：自动枚举全部数据类型防止漏备、导出自动剔除密钥。
- 新增大量自动化测试与 CI，保证新改动不破坏旧功能。

## 十三、AIRP 幕后导演（阶段一：私聊闭环）

- 每次私聊回复前先跑一次**导演 Agent**：读快照（时间/地点/日程/记忆基线/实时天气/事实）→ 按需调只读工具（定向补检索/网页搜索/读笔记）→ 输出结构化《演出指令》插进提示词钢印之前；角色模型只负责表演。解决长提示词打架、记忆错乱、擅自假设用户状态。
- 记忆/天气/新闻/日程走**确定性固定注入**（现有 `injectMemoryPalace` / realtimeWorld 缓存 / 日程管线原样保留），只有第三地天气、周边路线、定向补检索走导演工具；导演计划永不直接写成事实。
- 世界事实分六档权威（用户设定 > 正式剧情 > 工具验证 > 运行状态 > 记忆摘要 > 导演推断），旧记忆与新剧情冲突以新剧情为准并留痕；角色知识边界隔离（为群聊多角色打底）。
- 能力与权限：全系统能力注册表 + `read/low_write/confirm/forbidden` 四档 × 自治等级 L0-L3；默认 L2，写入类默认关闭；后台永不执行需确认类操作。
- 按角色 opt-in（`char.airp`），关闭的角色 payload 逐字一致、零额外调用；失败整段降级不打断聊天；导演诊断走 dev-only 开关。
- 代码：`utils/airp/`（types/facts/capabilities/directorCore/directorPrompt/settings/capabilityCatalog/snapshot/directorClient/toolExecutor）+ 私聊链三处接线；设计见 `docs/superpowers/plans/2026-09-15-airp-runtime-plan.md`，总图见 `docs/superpowers/specs/2026-09-15-presence-layer-architecture.md`。
- 状态说明：阶段一（导演闭环）本地已落地、待 push/部署；浏览器 5 轮手验待做；世界事件提交/离线生活/跨 App 投影在后续阶段。
- **阶段二（事实校验与提交）**：回复后处理末新增 Step 7——导演提议的事件只有在正文里真正叙述了才提交（关键词命中规则），落 `airp_events` 事件流（IndexedDB 新 store，DB v75）并物化进按角色的 `airp_world` 事实/知识库（DB v76），冲突走事实权威链（新胜旧、败者标 superseded 留痕），角色自动记下自己亲历的事实；消息 metadata 记账保证重跑不重复；失败整段降级不挡聊天；两库随备份走。再生回复的新事实会自动 supersede 旧版，无需特殊逻辑。

## 十四、音乐双音源

- **酷狗概念版双音源**：酷狗默认来源、网易保留可切换（`MusicCfg.source`）；worker 新增 `/kugou/*` 路由（上游为用户自部署的 KuGouMusicApi，`platform=lite`，地址配 env `KUGOU_UPSTREAMS`）；前端 `kugouApi` + `utils/kugouCore.ts` + 酷狗登录面板/个人页。角色「一起听」注歌词的机制双音源通用。
- 状态说明（2026-09-18 晚更新）：**已部署生效并完成真机校准**。worker（sully-proxy，`proxy.ethernet-vps.bot.cd` 为其反代入口）已配 `KUGOU_UPSTREAMS=https://kugou-music-api-chi.vercel.app` 并重部署；上游加了稳定设备指纹 env（GUID/DEV/MAC/WEBGL）；修掉三个实测 bug（cookie 空格致登录态失效、冷启动指纹漂移、`/song/url/auth/merge` 聚合链不稳改直通原生模块）；错误透传 + 音质自动降级 + 真实 errcode 中文映射。字段校准全部回写代码与单测（见酷狗计划附录）。代码仍在本地待 push；前端版本提至 `v3.16 (Dual Source)`。

## 十五、部署换轨与域名

- 前端站点由 Vercel 换到 **Cloudflare Pages**（项目 `sullyos`，只从 ethernet 分支自动构建，构建命令 `pnpm exec vite build`，`functions/` + `public/_redirects` 承接同源中转与 SPA 回退）；Vercel 保留为备用入口。
- VPS 域名拆分为后端 / MCP / opencode / worker 中转四个独立主机名；同源后端中转地址走部署面板环境变量 `BACKEND_HOST`，仓库无写死域名。工程细节与踩坑见 `notes/ethernet-branch-context.md` 域名迁移条目。

## 十七、可靠记忆 · 缓存可观测 · 角色连续生活（2026-10-22 批次）

一批把四件事同时收口，互相依赖：**记忆不出错、缓存看得见、协商不臆造、生活能自己过**。

### 1. 记忆可靠性（P0）

- **清空清两份水位**：IndexedDB 里 assets 的 `mp_hwm_v1_*` 镜像与 localStorage 的 `mp_lastMsgId_*` 一起清；只按前缀删镜像，别的 assets 不动。只清一处会让「清空后旧聊天不再处理」失效。
- **云端清空结果三态**：`success / failed / skipped`，行数未知显示「行数未提供」而不是 0；云端失败可以只重试云端，不重复清本地。
- **正文与向量同一事务**：`saveNodeWithVector` 在一个 readwrite 事务里提交，put 抛错就 `tx.abort()`；失败不会留下 `embedded=true` 的假完成。
- **能力权限三态**：`all / allowlist / none`，旧空数组仍是 all，显式 none 不会被迁移成 all；面板显示「全部允许 / 白名单 N 项 / 全部禁止」。
- **主代理鉴权 fail-closed**：没配 `AMSG_CLIENT_TOKEN` 的生产路径一律 403，只有显式 `MAIN_AGENT_ALLOW_ANONYMOUS=true` 才允许匿名（默认值没改，凭据没动）。
- **备份/恢复**：备份源从 `config/services.js` 的真实库路径生成 manifest（`VACUUM INTO` + integrity_check + sha256），不完整不产包不轮转；恢复先校验再停服，暂存→替换→失败回滚，启动失败不谎报。测试只在临时目录 + fake `systemctl`/`cp` 上跑。

### 2. 缓存可观测（P1/P2）

- usage allowlist 契约（`utils/llmUsage.ts`）：普通 token、缓存读/写、缺失状态、缓存语义（子集/独占/未知）。**缺失不写 0**，UI 显示「未提供」而不是 0%。
- 前台 API 调用记录、main-agent、amsg 即时/自主回程都保留这些字段；流式正文先出，尾部有界收集 usage（超时/EOF/DONE 都退出，不留悬挂连接）。
- 提示词结构：时光契约、生活记录实时摘要、MCP 近期结果、生活否决反馈移到动态尾段；固定说明与长期手册仍留稳定段；工具名映射与 schema 序列化稳定化（不重排 enum/required 语义数组）；用户世界书位置一律不动。
- 诊断叶子 `utils/promptCacheDiagnostics.ts` + `utils/requestPrefixObserver.ts`：段指纹、首个差异段、TTFT；只报结构指标，不宣称命中率。

### 3. 自然记忆协商（P3）

- 同一次提取调用内产出证据等级/主体/时间范围/来源消息；**零额外请求**，没有固定问卷、没有关键词判断。
- 否定、引用、假设、角色猜测、主体不明、来源不可核对 → 不落库，进按角色隔离的未决候选账本；只有模型显式 `resolve` + 新消息证据 + 议题一致才物化。
- 用户纠正保留原正文 + 追加失效关系；短期状态不升级成长偏好。
- 开关：`featureFlags.epistemicState`（默认关），本机调试 key 仅作覆盖；设置页如实显示开关来源。

### 4. 感知与自主生活（P4/P5）

- 感知归一（`utils/airp/perception.ts`）：source / subject / observedAt / expiresAt / permissions / version / dedupeKey；本地过滤过期、重复、无权限、无关联；只把相关小快照放动态尾段，缺席就省略（`utils/airp/perceptionPrompt.ts` 支持「已渲染来源」去重，绝不重复注入、不发请求）。
- 自主工作流：角色在**已有的一轮生成**里顺带提一条低风险小事（私人日记 / 个人计划 / 兴趣笔记），规则校验器降成白名单动作（禁 URL/代码/工具/权限/预算键、禁替对方断言感受、禁把想法说成已发生），云端落 `proposed` 计划，到点用既有调度器另起一次后台请求执行。
- 能力闸三处一致：聊天工具注入、排队前、执行前都读同一份权限终值；显式 `none` 连排队都不进（不白占当日次数）。
- 预算双门禁：每角色 2 次/天、同类动作间隔 2 小时、全局 6 次/天（云端共享行权威），外加既有 token 预算；`unknown` 是终态，绝不自动重试计费请求。
- 客户端可查看：新表 `airp_workflow_plans`（DB v79，随备份动态覆盖）在角色自主生活面板显示「TA 自己的小事」——标题、为什么想做、做完了的正文（明确标「TA 的私事（虚拟）」），失败/未知不展示成完成。
- 普通聊天里也能提：native tool `propose_life_workflow`（工具参数无正文、无网址、无权限字段），前台只发一次鉴权登记请求，回话只说「后台已排队，不要向对方提起」，不在回复里宣布。

## 十六、减法项（退役与移除）

- **外部 agent 桥（终端 App + opencode 遥控）整块删除**（2026-10-22）：桌面「终端」App、`components/terminal/*`、`components/settings/OpencodeConnectionConsole`、`utils/opencodeClient.ts`、两条代理（`scripts/opencode-proxy.mjs` / `worker/opencode-proxy/`）与 `docs/opencode-terminal.md` 全部下线；`AppID.Terminal`、`Opencode*` 类型、备份字段 `opencodeLocal` 与旧连接的本机键（`aetheros.opencode.connection`，含明文 Basic 密码）一并清理（启动期一次性迁移 `utils/retiredExternalAgent.ts`）。**保留** `opencode.ai` 作为聊天模型供应商的兼容层（`utils/llmIdentity.ts` 身份头 + `/models` 中转）——同名不同物，别顺手删。不要重新加回终端 App。
- Instant Push UI 整体退役，主动消息收拢为 amsg2 唯一模块；VAPID 凭据面板退役。
- 移除 umami 统计（含残留 `trackEvent` 引用与注释）；移除 Capacitor 安卓壳与整套原生推送 fallback（含 APK 流水线）；移除桌面 PiP 投屏按钮；应用内更新提示下线。
- 塔罗牌图转 webp 并删 mediapipe nosimd fallback，首屏资源减肥。

## 十八、本地记忆（v3.20 Local Memory，2026-10-23 已发布）

- **本地 embedding 全链路可调用**：本机 `127.0.0.1:8850`（容器 `embgemma2:440m-local2`，只 bind 回环、`/health` 不跑推理 3ms）→ 主代理 `/agent/v1/local-embedding{,/embeddings,/health}` 三个精确路径（在既有 `AMSG_CLIENT_TOKEN` 鉴权之后，无匿名、key 只存在服务端 env、不接受浏览器自定义上游地址）→ 浏览器侧 `utils/memoryPalace/localEmbedding.ts`（task=query/document 前缀由服务端加一次，客户端只剥不加）→ 记忆宫殿「本地 EmbeddingGemma2」选择卡（一键填入、不覆盖云配置、重建可取消/可续）。
- **向量空间身份指纹**：`provider|model|revision|dim|prefix|norm`。写入时每条向量带指纹；检索与去重都按指纹严格分区——维度相同但模型/前缀不同**不混检**，legacy（无指纹）只允许「云端同名同维度」继续用，本地模型下 legacy 一律排除。换模型只标「待重建」，不自动重建、不删向量。
- **远端 Supabase 保持 schema v1（vector(1024)）**：本地 768 维写入被显式拒绝并**告警一次**（不是"已同步"），查询端直接跳过远端走本地/词法；迁移 SQL 只作为纯文本方案产出，需用户自己在 SQL Editor 执行，**本轮未跑任何 DDL**。
- **运行环境**：`sullyos.service` 增加 `EnvironmentFile=/opt/sullyos/secrets/local-embedding.env`（600 root），unit 备份在 `/opt/sullyos/secrets/sullyos.service.bak-*`；改 unit 不重启服务，部署时随 `systemctl restart` 生效。`vps-backend/config/services.js` 的 `envKeys` 补文档，env 实际是全量直通。
- **本机语音明确未启用**：GPT-SoVITS 环境保留（`/opt/gpt-sovits`，4.0GB），实测 41 字 65.3s、常驻 >4GB、宿主可用内存触到 1.95GB，`gpt-sovits-tts.service` 保持 `disabled`+`inactive`，**未接主代理、未改 env、未上 UI 开关**；设置里那一项改标「未启用 · 试验未达标」并给出警告，不再冒充「中文克隆可用」。云 TTS 三家默认不变。
- **减法**：`backupSecrets` 里 `opencodeLocal` 死分支删除（旧包导入静默忽略）；外部 agent 桥全部下线（见「十六、减法项」）；VPS 自动备份链退役（见下文与 `BACKUP-RETIRED.md`）；Windows 端 opencode 登录自启脚本 `scripts/opencode-autostart-win.ps1` 一并删除（它注册的计划任务指向已删的 `opencode-proxy.mjs`，属坏自启；`opencode.ai` 作为聊天供应商的身份头/`/models` 中转**不受影响**）。
- **发布轮收口（3 项有限修正）**：① 删掉上述坏自启脚本，并加守卫用例（`scripts/` 下不得再引用 `opencode-proxy`，同时锁住 `llmIdentity.ts` 仍在）；② 本地 embedding 的 `/health` 不再回显上游内网地址，只留 `model / dimensions=768 / fingerprint / configured / tasks`；③ 设置页语音项标题改为「本地语音（GPT-SoVITS，未启用）」，选中时明示「已选 · 不可用」+ 未达标原因，云 TTS 三家仍是唯一可用选项。
- 版本名 `v3.20 (Local Memory)`。
- **明确未完成（别当已完成）**：SoVITS 本机 CPU 推理不达标，服务保持 `disabled`+`inactive`，未接主代理；云端 BGE 无同题实测，仅保留为可选；前端备份 ZIP 仍未加密；Cloudflare `worker/amsg` 的 Google secret 未同步（本机无 wrangler/无 CF 凭据）；Supabase 零 DDL（768 迁移仍是文本方案，需用户自己执行）；索引重建需用户自选触发，不自动全量重建；「架构一键向导」不是本轮内容。**上线回滚资产只有旧前端静态产物 + 旧代码 SHA，不做数据库备份/恢复。**

## 开发备注（自用）

- ethernet 是唯一主力开发线，同步上游按提交等价移植，不整分支合并。
- 新功能延续 ethernet 既有 UI/动效风格；**番茄钟的「铅笔手绘风」是唯一例外专区**，不扩散到其他 App。
- 分支背景、部署布局和历史踩坑见 `notes/ethernet-branch-context.md`。

---

## 更新记录

- 2026-09-12：初稿（覆盖至当日的新增功能，含当日完成、尚未提交的主动消息发图与角色页设定迁移）；定位调整为开发者自用功能账本。
- 2026-09-13：补记聊天图片点击放大查看（全屏灯箱，单聊 + 群聊）。
- 2026-09-15：**部署换轨 + 域名迁移**——前端站点由 Vercel 换到 Cloudflare Pages（`functions/` + `public/_redirects` 承接同源中转与 SPA 回退，构建命令 `pnpm exec vite build`，只从 ethernet 分支自动构建），VPS 域名拆分为后端 / MCP / opencode / worker 中转四个主机名；Vercel 保留为备用入口。工程细节与踩坑见 `notes/ethernet-branch-context.md` 同日条目。
- 2026-09-15：**AIRP 幕后导演阶段一**（私聊导演闭环：快照 + 导演调用 + 演出指令注入 + 工具补充轮；记忆/天气/新闻确定性注入；六档事实权威；能力注册与四档权限；按角色 opt-in）。本地已落地、待 push/部署，浏览器手验待做。
- 2026-09-16：**AIRP 阶段二（事实提交）+ 阶段三（离线自主生活）**——回复后处理 Step 7 把正文中真正发生的事件提交进 `airp_events`（DB v75）并物化进按角色的 `airp_world`（DB v76），备份全覆盖；角色可按调度离线醒来过自己的回合（经历进 outbox/日记/心跳，大事件推送），下次聊天经转述块自然提起（told 记账 + 披露翻转）；重大剧情自动降级为待定等用户；云端转述与工具调用留待后续阶段。本地已落地、待 push/部署，浏览器 D3 手验待做。
- 2026-09-16：**AIRP 阶段四（现实工具接线）**——导演按需调用第三地天气、周边地点（高德代理）与自管排程/写日记（复用 amsg2 会话，防重放）；新闻只进角色城市/兴趣相关的（其余不过提示词）；路线规划暂缓（无现成 helper，不编造）。写操作默认关闭，需用户显式开闸。本地已落地、待 push/部署。
- 2026-09-17：**AIRP 阶段五（跨 App 投影与管理面板）**——世界事件投影进各 App：交换日记引用真实事件（私密标 isPrivate）、朋友圈刷新按可见性发帖（公开+已披露才进正文，整批锚点防重喂）、查手机浏览/购买/外卖/打车记录从事件生成（购买明细走原模拟规则、事实只锁买什么和时间）、见面/通话注入实时处境块（时间感知关闭整块撤掉）、快照新增番茄钟事实（与聊天易变尾逐字节一致）；角色页 AirpPanel（自治等级+能力白名单+最近 50 条事件只读，开关仍归 AutonomyPanel）；共享词汇表 `utils/airp/projection.ts`（可见性三分+锚点约定：记录类取 event.at，帖子/日记用发表时刻）。生成链（导演/提交/快照旧基线）零改动。本地已落地、待 push/部署，全量 5921 用例绿；浏览器手验待做。
- 2026-09-18：**记录补齐**——统计口径更新到 285 提交/`v3.15 (Frameless)` 并注明 AIRP/酷狗本地待 push；主动消息补折叠多设备/测试按钮/心跳/身份头/后缀容错/流式收口，MCP 补 CORS 契约/统一入口/worker 默认与白名单，桌面补 Frameless/半屏/FitPage/polish/滚轮修复，新增音乐双音源、部署换轨、减法项三节，终端补后续增强，AIRP 状态一律改为本地待 push。
- 2026-09-22：**预设套组系统**——四期一次落地（可控注入+迁移 / 宏+套组UI+预览+分享 / 采样参数随套组 / 正则脚本），旧段落迁入「默认预设」，DB v78，备份全覆盖。全量 477 文件 / 6003 用例绿。本地已落地、待 push；浏览器手验待做（套组切换/导入导出 round-trip/预览块数/正则测试器）。
- 2026-09-23：**XHS VPS 会话桥代码入库**——批次一（会话模型/超时单飞/三态/token 字段）+ 批次二代码（sessionStore/sessionBridge/collector/run + deploy 件 + Caddy 模板）+ 批次三接线（vps 传输测试/Settings 会话卡/amsg 不上 cookie + bundle 2026-09-15）+ 任务 16 文档（README/排障重写/部署手册）。本地代码完、门禁绿；VPS 部署（camofox/扫码/24h 试验）、安全审计、六场景验收待做，见交接清单。
- 2026-09-23：**提示词统合收尾（Unified Prompt，`v3.18`）**——预设 App 收成三页：提示词（内置常驻段可接管落位 + 生效徽标 + 真实发送抓取视图）/ 世界书（原样嵌入）/ 调用地图（注册表按分类渲染调用卡：门三态按当前角色实时算、sourceKey 点跳页1对应卡、本地站点显示最近一次抓取时间并点开同渲染器、云端卡列补段清单、未接入抓取站点打标）；世界书独立 App 退役（入口/图标/预载/渲染全撤）；删离线预览镜像（`promptPreviewComposer` 及测试，抓取视图为唯一完整 prompt 来源）；`chat.appRules` 补进行为规范条目。各任务门禁全量绿，见 `notes/ethernet-branch-context.md` 同日条目。
- 2026-09-24：**VPS 语音换 Genie-TTS（替换 GPT-SoVITS-CPUFast）**——`/home/speak` 从 9880 切 9882，角色名 `ether`，补 44 字节 WAV 头。顺带修好一个从未生效的功能：原实现只发 `{text}`，而 GPT-SoVITS 要 `ref_audio_path`，所以该端点自上线起每次 400、一直静默降级成纯文本。VPS 侧 `gptsovits-api.service` 与 `/opt/gpt-sovits`（含 conda env）已删除。**收益**：盘空 22G→27G、合成 4-22 秒→3-4 秒；**代价**：常驻内存 4.6G，比原 GPT-SoVITS 多约 1.9G。工程细节、三个上游坑、换机可行性见 `docs/superpowers/plans/2026-09-24-genie-tts-swap-plan.md` 与 `notes/ethernet-branch-context.md` 同日条目。
- 2026-10-22：**可靠记忆 / 缓存可观测 / 记忆协商 / 角色连续生活（P0–P5 批）**——记忆清空两份水位 + 云端三态 + 正文向量原子事务 + 能力 all/allowlist/none；usage 缓存字段保真（缺失≠0）+ 提示词稳定结构（易变段落后移、工具 schema 稳定化）+ 缓存诊断叶子；记忆协商走同一次提取调用（证据等级、未决候选账本、纠正追加失效、默认关）；感知归一与自主生活工作流（聊天工具 + 后台计划 + 预算双门禁 + 客户端可查看记录 DB v79）。未部署；门禁数字见 `/srv/model-tests/implementation/FINAL-INTEGRATION.md`。
- 2026-10-22：**P3 记忆协商数据闭环（离线实现，未部署）**——记忆提取同一次调用内新增证据字段（evidence / subject / scope / timeRange / topic / sourceMsgIds），零额外 LLM 请求；否定、引用、假设、角色猜测、主体不明、来源不可核对一律不落库，改存未决候选账本（按角色隔离、localStorage、有上限），候选只在模型显式 `resolve` + 新消息 + 议题/主体一致时才物化成确定性 ID 的事实节点，重放幂等；用户纠正记录带来源消息的失效关系、原正文不删；短期状态不进消化材料与门牌。开关沿用 `featureFlags.epistemicState`，默认关闭。文件：`utils/memoryPalace/negotiation*.ts`（新）、`extraction.ts` / `pipeline.ts` / `digestion.ts`（最小接入）。清空记忆时需由 wipe 调用 `clearNegotiationLedger(charId)`（未接，属另一位代理文件）。
- 2026-10-22：**发布前最后两个硬阻断修复**——人工重试换新代去重键（`旧键:gen:新id`，真 SQLite UNIQUE 回归）；owner 未解析一律 fail-closed 跳过（普通回合与计划到点都停）；备份恢复按每库真实落点安装、必填库全集校验（缺库默认拒，`--allow-partial` 才「部分恢复」）。发布门禁：全量 562 文件 / 6869 用例、tsc 55 条 0 新增、worker bundle 两次同哈希、vite build 通过；上线读回见 `/srv/model-tests/implementation/RELEASE-RESULT.md`。
- 2026-10-23：**本地记忆候选（v3.20，未提交/未部署）**——本地 EmbeddingGemma2 主代理路由三路径挂载 + `sullyos.service` 载入受限 env 文件（未重启）+ 向量空间指纹（检索/去重严格分区，legacy 不当新模型）+ 记忆宫殿本地模型卡（重建可取消/可续）+ Supabase 1024 不兼容显式告警（不静默假同步、无 DDL）+ 设置页本地语音改标「未启用」+ 版本号 `v3.20 (Local Memory)`。门禁：全量 566 文件 / 6853 用例全绿、`tsc` 0 新增（55 条，基线实测 56）、`build:workers` 两次同哈希、`vite build` 通过；`check:workers` 因未提交必红。详见 `/srv/model-tests/next-phase/INTEGRATION-CANDIDATE.md`。
- 2026-10-23：**本地记忆（v3.20 Local Memory）发布**——本地 EmbeddingGemma2 主代理三路径 + 受限 env + 向量空间指纹严格分区 + 记忆宫殿本地模型卡 + Supabase 不兼容显式告警（无 DDL）+ 设置页本地语音改标「未启用」；发布轮只做 3 项有限修正（删坏自启脚本、`/health` 去内网地址回显、语音项标题准确化）并补守卫用例。SoVITS 仍停用、CF Google secret 仍未同步、前端备份 ZIP 仍未加密、索引需用户自选重建。门禁与线上读回见 `/srv/model-tests/next-phase/RELEASE-RESULT.md`。
- 2026-10-22：**发布候选收尾（三路阻断修复后的最终打通）**——①记忆协商开关前后台统一走 `getMemoryNegotiationGate()`（正式 config 的 false 压过旧 localkey，config 读坏按关且不回落）；②导入备份后清空旧协商账本（OSContext 收尾 + `db.importFullData` 两条入口，幂等，清不掉如实提示）；③角色面板改用权威快照显示全局护栏（读不到云端显示「后台未确认」，不再拿默认 6 次的兜底值冒充）；④补上「角色自己排着的事」提示段（服务端 id + 标题 + 能不能撤），聊天工具登记/撤销后同步本地 `airp_workflow_plans`，取消不再被同一条用户消息误判；⑤人工重试保留旧 run 审计（released 行改名让位而非删除），旧 task payload 只认自己那一代计划；⑥全局护栏新增受鉴权专用 CAS 写路由（`POST /autonomy-guardrails/patch`），并在泛写入口拦「把远端暂停改回未暂停」的普通保存，带真 SQL 并发回归。未提交/未部署；门禁与产物哈希见 `/srv/model-tests/implementation/RELEASE-CANDIDATE.md`。
- 2026-10-23：**角色自主出行（v3.21 Travel，未提交/未部署）**——B0 契约 + B1 存储预算 + B2 高德/Mapbox provider + B3 tick/路由 + B4 前端数据层 + B5 悬浮球真地图面板 + B6 设置/聊天卡 + 安全 lane（会话 + 镜像脱敏）合并进同一工作树并做集成：`index.ts` 在配置门后、未知 fallback 前挂 `/travel/*`（session/exchange、state、share、budget、settings、char、anchor、anchor/search、context、config、staticmap），`scheduled()` 内接 `handleTravelScheduled`。集成期**改语义**的四处：①预算从「每 tick 预留一次」改为**每个真实地图请求在 provider 出口扣一格**（tick 只做只读闸门，避免双扣）；②`settleMapCall` 默认**不退款**，只有「一个字节都没发出去」才显式 `refund:true`（否则失败重试免费）；③`/travel/anchor` 单数 + `placeId` 短期签名令牌（前端不传坐标，服务端解析），搜索走城市内检索；④会话统一：`POST /travel/session` = exchange 摊平别名，前端用一次性配对码自动续期，不再要求用户每次输 token。契约从 7 表扩到 10 表（`travel_anchors` / `travel_char_settings` / `travel_trip_positions`），设置加 `enabled`、角色级启用位、历史按共享代际过滤。新增端到端回归 `worker/amsg/src/travel/integration.test.ts`（真 SQLite + 真 provider + 注入 fetch）与挂载回归 `mount.test.ts`。未接通项（高德 Key 权限、`/_AMapService` 反代、Mapbox、per-user LLM 凭据解密、真机视觉）见 `docs/travel-contract.md` §11.5。
- 2026-10-23（补齐批，仍未提交/未部署）：**角色自己产生出行愿望 + 用用户自己的模型凭据**。
  ① 自主回合 JSON 增加**可选** `travel:{want:"go|wander|none",wish?,category?}`（提示词 + 解析 + 落库 +
  tick 枚举一条链），愿望由角色在既有自主回合里自然说出，用户不必手写；缺省/`none` 就是不出门，
  不按次数强制。解析走 `travel/intent.ts`（`sanitizeWishText` 拒坐标/门牌），落库前复核总开关、
  角色位、预算行、暂停与地图额度，3 小时内同类去重，**不额外调模型**。
  ② tick 的 subject 枚举改为「愿望 ∪ 已授权角色」（`listTravelTickSubjectsWithAuthorized`），
  没愿望的角色也会被检查但不会花模型/地图（执行前复核仍在）。
  ③ 决策模型凭据改为 **per-user `llm_credentials`**（`char:<charId>/chat`，与自主生活同口径），
  用上游同一份信封解密（`deriveUserEncryptionKey` + `decryptFromStorage`）；解不开即端口缺席，
  worker 级 `LLM_*` 只在 `TRAVEL_LLM_WORKER_ENV_FALLBACK=allow` 时兜底（线上那份已失效）。
  ④ 语义纠正：`placeId` 是 **HMAC 完整性签名、不是加密**（base64url 可解出坐标），只回本人配置界面，
  禁止进模型/日志/推送/备份；不称「隐私加密」。
  ⑤ 修掉一个真实烧额度的缺陷：tick §3 原把在途代自己的 `chosen` 愿望当「更新一代」，导致每跳重排路线；
  现在比对 `dedupeKey` 只认**另一条**愿望。回归 `worker/amsg/src/travel/intent.test.ts`（14 例，真 SQLite）。

  - 2026-10-23（同日补）：**闲逛分段 / 停留 / 在外结束 / 返程**接上。到点停留后由角色自己选
  `next`（换站，真候选 + 真道路折线）/ `stay`（延长停留）/ `return`（沿真实路线回确认锚点，
  `returnAt` 才变 `returned`）/ `stop`（终态 `stopped`：在外结束，不假装到家）。没有模型或额度
  就留在原地、愿望保留。愿望走完闭环成 `completed`（否则 `chosen` 会每跳重排）。另补一条
  **不依赖推送订阅**的自主意愿探针（窗口可配：`TRAVEL_INTENT_PROBE_MINUTES` → 用户自己配的
  autonomy 同类最小间隔 → 3h 兜底，复用 autonomy 账本），因为上游自主回合
  缺订阅会整跳跳过（上游 409）。回归 `worker/amsg/src/travel/wander.test.ts`（10 例，真 SQLite
  + 注入 fetch）。
  **终态与文案一致性（收尾轮补）**：`stopped`（在外结束）/`completed`（愿望闭环）加进契约后，
  `TRAVEL_PHASE_COPY`、提示词相位文案、`resolvePanelStatus`（静音终态、不给 ETA）、
  `getActiveTravelTrip` / 静态图判定（改用 `isTerminalStatus`）、保留期清理（`completed` 也按
  过期删）逐项对齐；`dwelling → stopped` 补进 `TRAVEL_TRANSITIONS`（此前 tick 真写该边、
  契约表却没有）。
  **未完成**：高德/Mapbox 真实账号权限与配额、`/_AMapService` 反代、真机视觉验收（见
  `docs/travel-contract.md` §11.5）。
- 2026-10-23（地图凭据补齐，未提交/未部署）：**用户在前端自己填高德 Key，后台加密保存，不再手改 env / 重构建**。
  - 新表 `travel_map_credentials`（`contracts/travel.ts` DDL），整份 JSON 用 `deriveUserEncryptionKey` + `encryptForStorage` 按账号加密；
    复用既有 crypto 与 `AMSG_MASTER_KEY`，**没有新建全局 owner**；换过 masterKey 时 `unreadable` 且拒绝覆盖。
  - `GET/PUT /travel/map/credentials`（只回存在性 + JS API / Mapbox `pk.` 公开展示 Key + 短期 `serviceHost`；Web 服务 Key 与 jscode 永不出后端）、
    `POST /travel/map/credentials/test`（显式一次、30 秒冷却、不扣出行预算）。空字段保持不变，清除走显式 `clear`；填 Key 不能解锁几何许可。
  - `/_AMapService/t/<token>` 安全代理（`worker/amsg/src/travel/mapProxy.ts`）：HMAC 绑定 userId + 过期；白名单 7 个只读端点；
    上游固定 `restapi.amap.com`；覆盖 `key`、服务端注入 `jscode`；跨用户/过期/非 GET/超限流一律拒绝。
  - provider / 锚点检索 / 静态图 / tick 都改为**按主体解密凭据优先**，worker 级 env 仅在 `TRAVEL_MAP_ENV_FALLBACK=allow` 时兜底；
    `TravelOverlay` 运行期从服务端取配置（`utils/travel/mapRuntime.ts`，内存缓存），设置后无需重构建。
  - 设置页新增四个 password 输入 + 保存/清除/测试按钮，`autocomplete=new-password`，成功清空并读回存在性，失败不覆盖草稿。
  - 回归 17（mapCredentials/mapProxy/mapProviders）+ routes 5 + 设置 UI 3 + 前端 runtime 5 + loader 3；全部合成 Key，未发真实收费请求。
  - 未验证：VPS Caddy `handle /_AMapService/*` 路由（样板在 `docs/travel-map-credentials.md`，未应用）；用户真实 Key 的权限与出图。
