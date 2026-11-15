# 给 dsh-world 的 QQ 卡补一行「用哪个号」

世界控制台的客户端模块是 dsh-world 的（装在 `node_modules` 里），没有对外暴露「往 QQ 卡上
再加一行」的接口。这个补丁补的是那一行 —— 除此之外什么都不改。

```bash
node tools/dsh-world-patch/apply.mjs            # 装上（幂等，重复跑没事）
node tools/dsh-world-patch/apply.mjs --check    # 只看现在装了没
```

装完**重启 DSH**，设置 → 世界控制台 → 接入 → QQ 卡上会多一行按钮。点击 = 换线 + 重启桥，
十几秒；界面自己轮询到切完，进度在 `~/.dsh/arkhub/line-switch.log`。

## 补了什么

| 文件 | 改动 |
| --- | --- |
| `lib/ecosystem/qq/route.js` | `GET /dsh-world/qq/lines` 与 `POST /dsh-world/qq/lines`：转给本插件的 `/dsh-arkhub/lines`。dsh-world 只当门房，不复制任何判断 |
| `lib/index.js` | 注册路由时把自己的 origin 传进去（不然门房不知道去哪儿问） |
| `client/index.js` | QQ 卡上那一行：两条线、昵称 · 号码、活没活、现在哪条；点一下换 |

## 为什么不是改 dsh-world 的源码

dsh-world 是别人维护的包，我们的需求（「用哪个号」）只有接上 dsh-arkhub 才有意义。补丁只动
三个地方，锚点是函数签名和路由表，`--check` 会告诉你锚点还在不在 —— dsh-world 改结构了会
标 ✗，而不是悄悄补错位置。

## 升级之后

dsh-world 升级会把 `node_modules` 里的改动冲掉（原件留在 `*.dsh-arkhub.orig`）。冲掉之后重跑
一次 `apply.mjs` 就行；看到 ✗ 说明它改过结构，要人工看一眼再补。
