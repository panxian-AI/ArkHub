# 更新日志

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
