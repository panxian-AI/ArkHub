# 更新日志

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
