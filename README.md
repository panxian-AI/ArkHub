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

## 和 dsh-world 的关系

dsh-world 自带一条 QQ 通道（`qqNative`，连 SnowLuma）。**两条通道不能同时开**，
否则同一个 QQ 会收到两遍回复。用这个插件时，把 dsh-world 的 `qqNative.enabled` 设成 `false`：
她的人格、记忆、生活线还是 dsh-world 的，只有「哪条线连 QQ」换成了这里。

不想用 ArkLink、只想让插件当个 OneBot 端子？把 `transport` 换成 `arkhub`，
指向 `ArkHub` 的开放面（`http://127.0.0.1:7090`），收消息和发消息都走它。

## 它不做什么

- 不建人设、不管记忆、不管作息 —— 那是 dsh-world 的活
- 不改 DSH 源码，只用宿主开放的扩展接口
- 不自动装 ArkLink、不替你扫码登录 QQ（这两件只有人能做）
- 不偷偷升级自己：只提示，命令给你

## 许可

MIT。见 [LICENSE](LICENSE)。
