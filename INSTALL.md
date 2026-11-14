# 交给她的安装说明

这份文件不是给人看的，是给 **DSH 里的那个角色**看的：谁把仓库地址发过来，谁就照着这份说明，
把 `dsh-arkhub` 装进 DSH，让 QQ 里的人能跟她说上话。

先把边界说清楚，只有一件事你替不了：**装 ArkLink 并扫码登录 QQ**（如果那台机器上还没有）。
其余步骤你自己做，做完再回来接手。

一句话概括你要达成的状态：

> DSH 里还是那个她（同一个人格、同一个家会话），QQ 发来的消息进她的会话，她的回复回到 QQ。

---

## 第零步：摸清四件事

动任何文件之前先查清这些，后面每条命令都要用。

| 要知道的 | 怎么查 |
|---|---|
| `DSH_HOME` | Windows 默认 `C:\Users\<用户名>\.dsh`；看里面有没有 `profiles`、`worlds` |
| 用哪个 profile | 列 `<DSH_HOME>/profiles/` 下的目录，挑 `package.json` 的 `dsh.profile.bundles` 里有你正在跑的那些插件的那个 |
| node 版本 | `node -v`，要 ≥ 22.16；没有就用 DSH 自带的：`<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe` |
| pnpm 在哪 | 用 DSH 自带的：`<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs`，调用方式是 `node <那个 pnpm.cjs> <命令>` |

> macOS / Linux 换成对应路径，命令不变。

---

## 第一步：把包装进 profile

`dsh-arkhub` 是纯 ESM，没有构建步骤，装进去就能跑。

### 从仓库装（推荐）

```bash
git clone https://github.com/panxian-AI/ArkHub.git
cd ArkHub
npm pack                              # 产出 dsh-arkhub-<版本>.tgz（不需要 devDependencies）
```

拿到 tgz 的**绝对路径**，然后：

```bash
cd <DSH_HOME>/profiles/<profile>
node <pnpm.cjs> add '<ArkHub 目录>/dsh-arkhub-0.1.0.tgz' --ignore-scripts
```

### 已经发布到 npm 之后

```bash
cd <DSH_HOME>/profiles/<profile>
node <pnpm.cjs> add dsh-arkhub@latest --ignore-scripts --registry=https://registry.npmjs.org/
```

> **不要**用 `link:` 指向 clone 下来的目录 —— 那样会加载项目自带的一份 Cordis，和 DSH 打架。

---

## 第二步：登记 bundle

打开 `<DSH_HOME>/profiles/<profile>/package.json`，在 `dsh.profile.bundles` 数组里加一项 `"dsh-arkhub"`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "…",
      "dsh-arkhub"
    ]
  }
}
```

只有登记了，DSH 启动时才会去读这个包自带的 `cordis.patch.yml`，把插件行插进来。

---

## 第三步：别让两条通道抢同一个 QQ

如果这个 profile 里已经装了 `dsh-world`，它自带一条 QQ 通道（`qqNative`，连 SnowLuma）。
**两条通道同时开会把每条回复发两遍。**

所以：在她的 `cordis.patch.yml` 里，把 `dsh-world` 那一段的 `qqNative.enabled` 改成 `false`：

```yaml
- id: dsh-world
  name: dsh-world
  config:
    companionName: 大肥鱼
    qqNative:
      enabled: false        # ← 只改这一行：QQ 这条线交给 dsh-arkhub
```

如果她根本没有 `qqNative` 这一段（老版 dsh-world，走 `qqBridge`），把 `qqBridgeAutoStart` 设成 `false`，
或者干脆不启动那个桥 —— 逻辑一样：一个 QQ 只能有一条线。

---

## 第四步：配白名单

打开 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`，找到 `id: dsh-arkhub` 那一段。
装完之后它大概长这样（键都在，值是空的）：

```yaml
- id: dsh-arkhub
  name: dsh-arkhub
  config:
    enabled: true
    transport: arklink
    arklink:
      baseUrl: http://127.0.0.1:6900
      tokenFile: ~/.arklink/api.json
    qq:
      allowPrivate: []        # ← 填：谁能私聊她（QQ 号，字符串）
      allowGroups: []         # ← 填：放行哪些群（群号）
      ownerQQ: ''             # ← 填：她自己开口时推给谁
      autoReply: true
      groupTrigger: mention
      groupKeywords: []       # ← 可选：群里说这些词也算在叫她
    session:
      worldId: default
      bindHomeSession: owner
```

三条硬规矩，别改错：

1. **`allowPrivate` / `allowGroups` 留空 = 谁都不理**，不是「所有人都理」。这是故意的。
2. `allowPrivate` / `allowGroups` 要写**数字串**，`['10001']`，不要写成用户名或昵称。
3. 想先验通道不想让她回话，把 `autoReply` 设 `false`：收得到、不回、也不花额度。

白名单从哪来？问主人要；或者让 ArkLink 列出来：

```bash
curl -H "Authorization: Bearer <ArkLink token>" http://127.0.0.1:6900/api/v1/friends
curl -H "Authorization: Bearer <ArkLink token>" http://127.0.0.1:6900/api/v1/groups
```

---

## 第五步：ArkLink 和 QQ（这一半只有人能做）

如果 `http://127.0.0.1:6900/api/v1/status` 能返回 `{"ok": true, ...}`，说明 QQ 那一头已经好了，跳过这步。

否则请主人做这两件事：

1. 装 ArkLink 并**扫码登录 QQ**（这一步替不了，二维码得人拿手机扫）
2. 把 ArkLink 的 API token 放到 `~/.arklink/api.json`（或填进 `arklink.token`）

确认：

```bash
curl -s http://127.0.0.1:6900/api/v1/status
# 期望：{"ok": true, "uin": "...", ...}
```

---

## 第六步：重启 DSH

前几步改的都是「DSH 启动时才读」的东西（bundles、cordis.patch.yml）。所以现在重启 DSH。

重启后验证两件事：

1. `http://127.0.0.1:<DSH 端口>/dsh-arkhub/status` 返回 JSON，且：
   - `channel.running` 是 `true`
   - `channel.homeBound` 是 `true`（说明接上了她原来的家会话）
   - `channel.account.uin` 是她的 QQ 号
2. 日志里有一行 `[arkhub] 已装配：transport=arklink ...` 和一行 `QQ 通道已开`

> DSH 的 webServer 会校验 Host 头，用浏览器打开；拿 curl 打要带对 Host。

---

## 第七步：真发一条

让主人在 QQ 上用一个在 `allowPrivate` 里的号给她发一条：

- 她回了 → 成了
- 没回，但 `/dsh-arkhub/status` 里 `counts.blocked` 在涨 → 那个号不在白名单
- `counts.received` 都不动 → 消息没进来，看 `lastError`

群里：@ 她一句应该回；说一句没叫她的，`counts.received` 会涨但 `replied` 不动（只记上下文，不回）。

---

## 出问题看这里

| 现象 | 真正的原因 |
|---|---|
| `channel.running` 是 `false` | 看 `lastError`。多半是 ArkLink 没起、端口不对、token 不对 |
| `homeBound` 是 `false` | 世界里还没有 `homeSessionId`：让她的世界先开始过一次；或者把 `session.homeSessionId` 手填上 |
| 收到消息但一个字不回 | `qq.autoReply` 关着，或者 `counts.blocked` 在涨（白名单） |
| 她回了，但 QQ 上没出现 | `counts.failed` 在涨，看 `lastError`；也可能是发送号没有权限（ArkLink 的发送策略会拦） |
| 同一个问题收到两条回复 | dsh-world 的 `qqNative` 还开着，两条通道都在回 —— 见第三步 |
| 群里 @ 了还是不接 | 群号要写进 `allowGroups`；另外群里默认只认 @ 她、或者 `groupKeywords` 里的词 |
| 私聊进来的话串到群里 | `bindHomeSession: owner` 的含义是「私聊用家会话、群各自独立」；改成 `all` 才会共享 |
| 装完 DSH 起不来 | 把 `package.json` 的 bundles 那行撤掉，重启确认能起，再检查 tgz 是否装全（`node_modules/dsh-arkhub/lib/index.js` 应该在） |
| 设置里找不到这个插件 | 只登记了 install 没登记 bundle —— 见第二步 |

---

## 一句话总结给主人听

> 装好了。以后重启电脑只要两件事：ArkLink 自己登录 QQ、DSH 起来。她的记忆和人格还是原来那套，
> 只是 QQ 这条路现在直通她。
