# 更新日志

## 0.6.0 — 2026-11-15

世界控制台多了一行「用哪个号」。以前换号 = 改装配行 + 改桥配置 + 重启桥，三件事分别在三个
地方；现在是一次点击，两条线各自有名字、有号码、有活没活。

- 新增 `lib/lines.js`：「线」= 一个号 + 桥的上游。`vm`（VM 里的号，走门面，收信和
  语音/引用在 SnowLuma）和 `windows`（本机 SnowLuma 直连，换桥前的样子）。号不单独选 ——
  上游指向谁，说话的就是谁。
- 新增 `channel.enabled`：选 `windows` 时本插件整段待命（不轮询、不开门面，只留状态与
  换线路由）。不这样的话它会拿另一个号同时回话。
- 新路由 `GET /dsh-arkhub/lines`（只读文件 + 探活）和 `POST /dsh-arkhub/lines {target}`。
  POST 先回 202 再把活交给独立进程 —— 换线要动装配行，DSH 会热重载本插件，
  在进程里做的话桥的重启那一步会连同 Promise 一起被丢掉。
- 新增 `dsh-arkhub lines` / `dsh-arkhub line vm|windows`；`bridge use` / `bridge rollback`
  改成它们的别名，后者现在是「换到原桥那条线」而不是「回会话模式」。
- 切回原桥时恢复备份会保留**现在的** `dsh.baseUrl`：备份里那份是换桥前的端口，照抄过去
  桥就找不到 DSH，看着像连上了、其实一帧都不来。
- 门面把昵称也报出来（`get_login_info` / `/api/status` 的 `nickname`），界面上才写得出
  「小暖 · 100010002」；换线接口不回令牌，只说有没有配。
- 新增 `tools/dsh-world-patch/apply.mjs`：给 dsh-world 的 QQ 卡补一行选择器（宿主路由 + 客户端
  按钮），幂等、带原件备份、`--check` 只看不装。dsh-world 升级冲掉之后重跑一次即可。
- 测试 69 通过（新增 `test/lines.test.js` 7 个、`test/channel.test.js` 4 个）。

## 0.5.0 — 2026-11-15

收信接上了，语音和引用也回来了。之前门面只会「替 ArkLink 打字」：ArkLink 在无头
Linux 上收不到消息（hook 注入撞墙），也发不了语音和引用（x11 只会点输入框）。
解决办法不是再写一套协议，而是把 SnowLuma 装进同一个 VM —— 它注入在运行期，
能进得去，而且对外的就是标准 OneBot。

- 新增 `lib/snowluma.js`：WS 订阅收信 + HTTP 转发送信。断线自己退避重连，
  连不上只是一条日志，文字照发。
- 门面（bridge 模式）：收信来自 SnowLuma，事件原样转给 qq-bridge；`send_*` 先走
  SnowLuma（语音 `record`、引用 `reply`、图片这些段原样进协议层），失败才退回 ArkLink 只发文字。
  `get_login_info` / `get_group_list` / `get_friend_list` 在 SnowLuma 在线时用它的真实数据。
  两条上游按 `message_id` 去重（5 分钟窗口），同一条不会进两次。
- 会话模式（session）也吃同一条收信：`itemFromEvent()` 把 OneBot 事件转成 ArkLink 那种
  item，白名单/叫她的判据/攒批全都复用，不另写一份。
- 新增 `POST /dsh-arkhub/ingest`：ArkBot 兜底入口。`tools/arkbot-arkhub/arkhub_fallback.py`
  是配套插件 —— ArkBot 自己连一份协议端，收到消息 POST 进来，门面按 id 去重。
- 状态接口带上 `snowluma`（connected / selfId / received / lastEventAt）和
  `sentVia` / `eventVia`，排障时一眼看出这条消息是哪条链路来的。

## 0.4.0 — 2026-11-15

一键换桥。会话模式下世界控制台那张 QQ 卡永远是「未运行」；要让它显示真的，
得手工改三处配置（装配行、桥的 config.json、重启桥），错一步就静默失效。

- 新增 `bridge use` / `bridge rollback`：装配行 `bridge.enabled` 翻转、
  桥的 `snowluma.httpUrl` / `wsUrl` 指向门面、原配置存 `.dsh-arkhub.bak`、
  打桥自己的 `/api/restart` 重连，全是一条命令。
- 关键坑入库：桥的 `followDiscoveredEndpoint` 必须关——它的自愈机制默认会
  「发现」真实 SnowLuma 并悄悄连回去、把配置改回来（bridge.js 的端点跟随）。
- 兼容 0.2.x 装配行：老块没有 `bridge:` 段时自动补一段。
- 世界控制台的 halt/start 门实测不可靠（halt 打断连接、start 只看活着没），
  重启改走桥自己的 `/api/restart`。

## 0.3.2 — 2026-11-15

新增「ArkLink 收信」体检与排查手册。起因：发送一切正常，但 ArkLink 一条消息都收不到
（`bus.total` 96 分钟为 0），而面板上看不出任何异常。

- `doctor` 新增「ArkLink 收信」：读 ArkLink 控制台的 `/api/doctor`（无需登录），
  直接告诉你 hook 管道在不在。注意它的 WARN 项也带 `ok: true`，只能看 `status` 字段。
- 门面模式启动时，若管道不在会打一条日志，不再等半夜发现她不回话。
- `INSTALL.md` 新增「收不到消息」一节：Windows / Linux 的注入步骤、ptrace_scope、
  用 gdb 代替它坏掉的 ptrace 注入、以及「注入器坏了还是模块不兼容」的判别方法。

## 0.3.1 — 2026-11-15

修正「演练模式」的判定，之前会长期误报。

- 原来读的是 `sends.last`——上一次发送的历史快照。ArkLink 换成真发送引擎（`engine: x11`）后，
  那条旧记录仍写着 `dry_run: true`，于是体检一直说「消息不出网」，把人往反方向带。
  现在以**当前生效的引擎**为准，只有引擎字段缺失才回退看历史。
- 体检项从「演练模式」改成「发送引擎」，直接显示 `x11（真发送）` / `dry-run（演练，消息不出网）`。

## 0.3.0 — 2026-11-15

新增「门面模式」：让 ArkLink 顶掉 SnowLuma，qq-bridge 与它那套会话机制原样照搬。

- **为什么这么做**：世界控制台左下角那张 QQ 卡（桥在跑、上次收包、会话绑定、主动聊天统计）
  读的是 qq-bridge。自己另起一套接收通道，那张卡永远是「未运行」，而且会话绑定要再存一份。
  桥说的是 **OneBot 11**，所以只要有人在 3010 上说 OneBot，它什么都不用改。
- **`bridge.enabled: true`**：本插件只做 OneBot 服务端 ——
  HTTP 动作（`get_login_info` / `send_group_msg` / `send_private_msg` / `send_msg` /
  `get_group_list` / `get_friend_list` / `get_status` / `get_version_info`）
  + WebSocket 事件推送（message 事件、30 秒一次 heartbeat）。手写的握手与帧编解码，不引依赖。
- **会话仍按 qq-bridge 的机制存**：`~/.dsh/qq-bridge/state/sessions.json`，按
  `private:<QQ>` / `group:<群号>` 一条一条绑到具体会话；本插件不另存对话。
- 不认识的动作回 `retcode 1404`，让桥自己降级而不是整个挂掉；富媒体暂降级为纯文本。
- `install --bridge`：一条命令写成门面模式的配置。
- **`monitor`：夜间稳定性监控**。只读地记两样东西 —— 今晚收到的每条消息，和这条链路的存活时间
  （ArkLink uptime、探测延迟 p50/p95/最大、总线丢包/重复、掉线时刻与恢复时刻）。
  数据落在 `~/.dsh/arkhub/monitor/<本地日期>.jsonl`，游标自己维护、重启接着走。
  `--report` 出总结，`--report --push <QQ>` 直接把总结推过去 —— **推送不问人，没有二次确认**。

## 0.2.0 — 2026-11-15

把「装一个插件」从四步手工活变成一条命令。顺带修掉上一版装卸不干净的老账。

- **`dsh-arkhub install`**：自己挑 profile（优先装了 dsh-world 的那个，因为那条鱼在那儿）、
  以 `link:` 写进依赖、跑 DSH 自带的 pnpm、追加带标记的装配行、
  从 ArkLink 读账号与白名单、从 `life.json` 读她住哪间 —— 人只剩「重启 DSH」
- **`dsh-arkhub uninstall`**：删依赖、删 bundle 登记、删装配行三处，其他条目一个字不碰
- **`dsh-arkhub doctor`**：逐项体检（Node、DSH 目录、profile、依赖落地、工具链、ArkLink、
  演练模式、角色的家），每项不通过都给处理办法
- **`dsh-arkhub status`**：装了没、通道通没通、收/回/发/拦/失败各多少
- **装卸是逐字节可逆的**：装配行改成「切三段重建」而不是原文缝补 ——
  反复安装不再累积空行，卸载后 `cordis.patch.yml` 与安装前完全一致（有测试盯着）
- **装失败会自己退回去**：pnpm 挂了就把刚写的两个文件还原，不留半装状态
- **ArkLink 演练模式可见了**：`status` 与日志都会直说「收得到、发不出去」。
  这是最难自己发现的一类故障 —— 一切看着正常，消息根本不出网
- **移除 `roster()`**：它打的 `/api/v1/groups`、`/api/v1/friends` 在当前 ArkLink 版本上是 404

## 0.1.1 — 2026-11-15

修补「装进 DSH 之后要重启两次才好使」的几个坑。都出在常驻进程与外部凭据/游标的时序上。

- **凭据按需重读**：token 往往是在 DSH 起来之后才写进 `~/.arklink/api.json` 的，
  以前只在装配那一刻读一次，读空就一直 401 到下次重启。现在每次用前再看一眼文件；
  碰到 401 会重读一次、确实变了就重试一次
- **没连上就不处理积压**：轮询前先确认游标已对齐，没对齐只对齐、不投消息。
  避免「DSH 先起、ArkLink 后起」时，几十条历史消息被当成刚收到的挨个回一遍
- **游标改为认 `last_seq`**：用 `/api/v1/messages` 响应里自带的 `last_seq` 对齐起点，
  不假设列表是升序还是降序，空页也能正确落在末尾
- **`hasToken` 说真话**：状态接口报的是实际持有的凭据，而不是配置里写没写 token

## 0.1.0 — 2026-11-15

第一个能装的版本。

- **作为一个 DSH 插件**：cordis 插件，纯 ESM，无构建步骤；`dsh.bundle.patch` 自带装配行
- **接 QQ**：走 ArkLink 的 HTTP API 收消息、发消息；也可以换成 ArkHub 的开放面（`transport: arkhub`）
- **还是原来那个她**：私聊默认投进 `worlds/<worldId>/life.json` 里的 `homeSessionId`，
  群聊各开一间屋子；找不到世界文件时退化成 QQ 专用会话
- **白名单**：私聊 / 群各一份，留空 = 谁都不理
- **群里什么时候接话**：`mention`（@ 她 / 关键词）或 `all`
- **攒批**：连着发的几句合成一段（`batchQuietMs`）
- **静默**：`mutedUntil` 到点前只收不回
- **状态路由**：`GET /dsh-arkhub/status`；热开关 `POST /dsh-arkhub/config`
- **更新提示**：一天查一次，查到只说一句；`update.check: false`、`DSH_ARKHUB_NO_UPDATE_CHECK=1`、
  `POST /dsh-arkhub/mute` 三种关法
- **首次启动不重放历史**：游标对齐到最新一条，免得把三天前的话又回一遍

### 已知边界

- 只发文字；图片、表情、@ 的收发还没做（`[[at:…]]` 这类标记会被去掉，不会漏到 QQ 上）
- 她自己开的一轮（闹钟、世界线）暂时不主动推到 QQ —— dsh-world 那条通道已经会推，
  两边都推会重复。等它彻底下线后再打开这里
- `transport: arkhub` 只做了最小适配，主要路径是 `arklink`
