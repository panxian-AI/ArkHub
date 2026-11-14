# ArkHub

**把 DSH 里已经存在的那个人，接上 QQ。**

不是再造一个机器人，也不搬走她原来的家：消息进来走她正在住的那个会话，她说过的话原路回到 QQ。
装好之后重启 DSH 就能用，不需要 SnowLuma、不需要第二个进程、不需要再扫码（除了 ArkLink 登录那一次）。

```
QQ ──► ArkLink（登录着 QQ 的那台机器/虚拟机）──► dsh-arkhub ──► 她的会话（世界里那间）
                                                    ▲                    │
                                                    └──── 她说的话 ◄──────┘
```

## 它是什么

一个 **DSH 插件**（cordis 插件，纯 ESM，无需构建），加一套可选的本地开放面。

| 能力 | 说明 |
|---|---|
| 接 QQ | 走 ArkLink 的 HTTP API（收消息 / 发消息），不依赖 OneBot、不依赖 SnowLuma |
| 用她原来的会话 | 默认把私聊投进 `~/.dsh/worlds/<worldId>/life.json` 里的 `homeSessionId`，群聊各开一间屋子 |
| 白名单 | 私聊 / 群各一份，留空 = 谁都不理（照 dsh-world 的规矩，不偷偷放开） |
| 群里什么时候接话 | `mention`（默认，@ 她 / 命中关键词）或 `all` |
| 攒批 | 连着发的几句合成一段，不让她为半句话回三次 |
| 静默 | `mutedUntil` 到点前只收不回 |
| 状态路由 | `GET /dsh-arkhub/status` —— 面板、排障、脚本都看它 |
| 更新提示 | 有新版在日志说一句；`update.check: false`、`DSH_ARKHUB_NO_UPDATE_CHECK=1`、或 `POST /dsh-arkhub/mute` 都能关 |
| 命令装卸 | `dsh-arkhub install / uninstall / status / doctor`，自带体检与自动填配置 |

## 装

把仓库地址交给 DSH 里的她，让她照 [INSTALL.md](INSTALL.md) 做；或者自己来，两条命令：

```bash
node bin/dsh-arkhub.mjs doctor    # 体检：哪一项没通、怎么修，直接说
node bin/dsh-arkhub.mjs install   # 装：自动挑 profile、写装配行、填 QQ 号、落地依赖
```

然后重启 DSH。

`install` 干完的活原本要人手工做四步（改 `package.json` 的 bundles、改 `cordis.patch.yml` 的 YAML、
跑 pnpm、把 QQ 号抄对）。它自己找 profile、自己从 ArkLink 读账号和白名单、自己从 `life.json` 读她住哪间，
改文件前留备份，pnpm 失败会把文件退回原样。**重复执行只有一段，不会翻倍。**

撤回来一条：

```bash
node bin/dsh-arkhub.mjs uninstall   # 卸掉依赖 / bundle 登记 / 装配行，其他条目一个字不碰
```

> 装完先看 `http://127.0.0.1:<DSH 端口>/dsh-arkhub/status`：`channel.running` 是 `true`、
> `homeBound` 也是 `true`，说明它已经在听 QQ 了。
> 如果 `dryRun` 是 `true`，说明 ArkLink 在演练模式 —— 收得到、发不出去，这一步得在 ArkLink 那边关。

## 配置

改 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里 `id: dsh-arkhub` 那一段（或 DSH 设置 → 插件）。
完整字段见 [cordis.patch.yml](cordis.patch.yml)，常改的就这几个：

```yaml
qq:
  allowPrivate: ['10001']     # 谁能私聊她
  allowGroups: ['20002']      # 放行哪些群
  ownerQQ: '10001'            # 她自己开口时推给谁
  autoReply: true             # 先验通道时设 false：只收不回
  groupTrigger: mention       # 群里 @ 到才接
  groupKeywords: ['小鱼']
session:
  worldId: default            # 用哪个世界的她
  bindHomeSession: owner      # 私聊用家会话，群各自独立
```

这几个开关也能热改，不用重启：

```bash
curl -X POST http://127.0.0.1:<端口>/dsh-arkhub/config \
  -H 'x-dsh-arkhub: 1' -H 'content-type: application/json' \
  -d '{"autoReply": false, "allowPrivate": ["10001"]}'
```

## 两种接法（选一种，别同时开）

同时开会把每条回复发两遍。由 `bridge.enabled` 决定走哪条：

| | `bridge.enabled: false`（默认）| `bridge.enabled: true` |
|---|---|---|
| 谁把消息投进会话 | 本插件自己 | qq-bridge（照搬它的机制）|
| 会话绑定存哪 | `worlds/<id>/life.json` 的 `homeSessionId` | `~/.dsh/qq-bridge/state/sessions.json`，按 `private:<QQ>` / `group:<群号>` 一条一条绑 |
| 世界控制台左下角那张 QQ 卡 | 不读本插件，会是「未运行」 | 真实：桥状态、上次收包、会话绑定、主动聊天统计 |
| 需要 qq-bridge | 不需要 | 需要（它本来就在），但**不再需要 SnowLuma** |

门面模式做的事很少：把 ArkLink 的消息流翻译成 OneBot 事件，从 `:3010` 推给 qq-bridge；
桥发出去的 `send_group_msg` / `send_private_msg` 翻译回 ArkLink 的 `/api/v1/send`。
桥那边的巡检、会话绑定、工具、主动聊天的账一件没改 —— 所以卡片上的数都是真的。

切过去的步骤见 [INSTALL.md](INSTALL.md#换成门面模式世界控制台那张-qq-卡才有数)。

## 和 dsh-world 的关系

dsh-world 自带一条 QQ 通道（`qqNative`，连 SnowLuma）。**两条通道不能同时开**，
否则同一个 QQ 会收到两遍回复。用这个插件时，把 dsh-world 的 `qqNative.enabled` 设成 `false`：
她的人格、记忆、生活线还是 dsh-world 的，只有「哪条线连 QQ」换成了这里。

不想用 ArkLink、只想让插件当个 OneBot 端子？把 `transport` 换成 `arkhub`，
指向 `ArkHub` 的开放面（`http://127.0.0.1:7090`），收消息和发消息都走它。

## 稳定性监控

跑一整晚，看这条链路到底稳不稳。只读，不影响正在用的通道：

```bash
node bin/dsh-arkhub.mjs monitor              # 每 30 秒采一次，Ctrl+C 结束并出总结
node bin/dsh-arkhub.mjs monitor --interval 15
node bin/dsh-arkhub.mjs monitor --report     # 看今天（和前两天）的总结
node bin/dsh-arkhub.mjs monitor --report --push 10001   # 直接推到 QQ，不问你
```

记的是两样东西：

- **收到什么**：每条 QQ 消息（seq、私聊还是群、谁发的、正文前 300 字）
- **活多久**：ArkLink 的 uptime、每次探测的延迟（p50/p95/最大）、总线丢包与重复、掉线时刻与恢复时刻

数据落在 `~/.dsh/arkhub/monitor/<本地日期>.jsonl`，一行一个事件；游标存在
`~/.dsh/arkhub/monitor.json`，重启接着走，不会重复记。晚上跑到凌晨算同一晚（按本地日期切文件）。

## 它不做什么

- 不建人设、不管记忆、不管作息 —— 那是 dsh-world 的活
- 不改 DSH 源码，只用宿主开放的扩展接口
- 不自动装 ArkLink、不替你扫码登录 QQ（这两件只有人能做）
- 不偷偷升级自己：只提示，命令给你

## 参与开发

- **仓库里不写真实 QQ 号。** 测试、冒烟、注释、文档示例一律用占位值
  （账号 `123456789`、群 `987654321`）；要对自己的账号跑，用环境变量
  `ARKHUB_TEST_UIN` / `ARKHUB_TEST_GROUP` 覆盖，别把号码写回文件。
- 运行时产物（`*.jsonl`、`*.log`、`live.json`、`monitor/`）已在 `.gitignore` 里，别提交。
- 改动后跑 `npm test`；改了收发逻辑再跑 `node smoke/facade.mjs`（只连本地，不发 QQ 消息）。

## 许可

MIT。见 [LICENSE](LICENSE)。
