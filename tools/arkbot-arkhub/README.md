# ArkBot 兜底（收信第二条腿）

门面自己连 SnowLuma 的 WebSocket 收信。这条链路只有一份，它挂了就一条都收不到——
所以再挂一条：**ArkBot 独立连一份协议端**，把收到的消息 POST 进门面。

```
SnowLuma(VM)  ──WS 3101──▶  dsh-arkhub 门面  ──WS 3010──▶  qq-bridge  ──▶  她的会话
      └────────WS 3101──▶  ArkBot + 本插件 ──HTTP POST /dsh-arkhub/ingest──┘
```

两条链路进的是同一个门面，门面按 `message_id` 去重（5 分钟窗口），同一条消息
不会让她回两遍。哪条先到算哪条。

## 装

1. `arkhub_fallback.py` 丢进 ArkBot 的插件目录（默认 `plugins/`，靠 `load_directory` 扫描）；
2. `bot.toml` 里加一条 OneBot 适配器，指向 SnowLuma（和门面连的是同一个地址、同一个 token）：

```toml
[[adapters]]
type = "onebot11"
url = "ws://127.0.0.1:3101/?access_token=<wsToken>"

[plugins.arkhub_fallback]
base_url = "http://127.0.0.1:62560"   # DSH 的 webServer 地址
enabled = true
# 只推这些（空 = 全推；门面自己的白名单照旧生效）
# groups = [200010001]
# users  = [100010001]
```

3. `python -m arkbot` 跑起来，日志里应看到 `arkhub 兜底已挂上：.../dsh-arkhub/ingest`。

## 验

```bash
# 门面这侧：应看到 eventVia=arkbot、events 在涨
curl -s http://127.0.0.1:3010/api/status
```

门面只在 `bridge.enabled`（门面模式）下收兜底事件；session 模式没有要广播的
OneBot 客户端，`POST /ingest` 会回 409。

## 为什么不直接用它当主力

ArkBot 走的是「适配器连协议端」——协议端收不到的东西它也收不到。它值钱的地方是
**另一条进程、另一条连接、另一套重连**：门面的 WS 客户端卡死时，它还能把消息塞进来。
真要「协议层彻底不可用仍能收」，得换官方机器人通道（`official_qq` 适配器，
群聊只在被 @ 时收到），那需要开放平台的 app_id / app_secret，接口位子已经留好。
