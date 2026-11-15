# 装到 DSH 上

这份文档是写给**替你动手的那个助手**看的。你只要把仓库链接贴给它，说「照 INSTALL.md 装」，它跑两条命令就够了。

---

## 给人看的三句话

1. 先确认 ArkLink 在跑、QQ 登着（这一步本来就要做，不是本插件要求的）。
2. 在仓库目录里跑 `node bin/dsh-arkhub.mjs install`。
3. 重启 DSH。

装完她会用**原来那个会话**回 QQ 消息，不新建角色、不另起进程。

### 全新 DSH（从零开始）

DSH 刚装好、什么插件都没有也行 —— `install` 会把 **dsh-world 一起装上**：

- profile 的 `dependencies` 里没有 `dsh-world` 就自动加（版本钉在 `^0.6.4`，npm 上最早的
  公开版就是 0.6.4；0.x 的 `^` 只钉次要版本，不会跳到 0.7+。「用哪个号」补丁对自带 0.5.x、
  npm 0.6.x、0.7.x 三代锚点都认。profile 里本来就有 dsh-world 的话一个字不动）；
- 装配行里没有 `- id: dsh-world` 块就自动补一段（`qqBridgeDir` 指到 `<DSH home>/qq-bridge`、
  `qqBridgeAutoStart: true`）；
- pnpm 落地后自动跑一次 `tools/dsh-world-patch/apply.mjs`，QQ 卡上的「用哪个号」选择器
  也就位了（失败不拦安装，命令行 `dsh-arkhub lines` / `line vm` 照样能换线）。

所以从零开始的完整步骤就是：

```bash
git clone https://github.com/panxian-AI/ArkHub
cd ArkHub
node bin/dsh-arkhub.mjs doctor   # 先体检
node bin/dsh-arkhub.mjs install  # dsh-world + dsh-arkhub 一起装，配置全自动
# 重启 DSH，curl http://127.0.0.1:62560/dsh-arkhub/status 验证
```

VM 里的 QQ 想要人工兜底（扫码/验证/换号，watchdog 没收录的界面亲手点）：装
ArkLink 仓库 `tools/vm-manual/install.sh`，宿主 VNC 客户端连 `127.0.0.1:5903`，
详见 ArkLink 文档「人工操作口（VNC）」。

---

## 给助手看的

### 前提

| 项 | 怎么确认 |
| --- | --- |
| DSH 装好并能启动 | `~/.dsh/profiles/<名字>/package.json` 存在 |
| ArkLink 在跑 | `~/.arklink/api.json` 里有 `base_url` 和 `token` |
| Node ≥ 22 | DSH 自带那份就够，安装脚本会自己找 |

### 第一步：体检

```bash
node bin/dsh-arkhub.mjs doctor
```

逐项打 `[ok]` / `[!!]`，每一项不通过都直接给出处理办法。**先把它跑成全绿再往下走**，否则装完也是个哑的。

### 第二步：装

```bash
node bin/dsh-arkhub.mjs install
```

这一条命令做的事（都不需要人插手）：

- 自动挑 profile —— 优先挑**装了 dsh-world 的那个**，因为那条鱼在那儿；只有一个就选它
- 把本仓库以 `link:` 方式写进 profile 的 `dependencies`，再跑 DSH 自带的 pnpm 落地
- 在 `cordis.patch.yml` 末尾追加一段带标记的装配行（重复执行只会替换这一段）
- 从 ArkLink 读出账号 QQ、允许的私聊/群，从 `worlds/<id>/life.json` 读出角色住的会话，自动填进配置
- 改任何文件之前先存一份 `<文件>.dsh-arkhub.bak`；pnpm 失败会把改过的文件退回原样

可选参数：

```bash
node bin/dsh-arkhub.mjs install --no-reply        # 先只收不回，观察一阵
node bin/dsh-arkhub.mjs install --profile desktop # 指定 profile
node bin/dsh-arkhub.mjs install --uin 123 --groups 456,789 --private 123
```

### 第三步：重启 DSH

profile 只在启动时读一次，不重启等于没装。

重启后验证：

```bash
curl -s http://127.0.0.1:62560/dsh-arkhub/status
```

要看到：

- `channel.running: true`
- `channel.homeBound: true`（说明接的是她原来的会话）
- `channel.account.uin` 是她的 QQ 号
- `channel.cursor` 是个大于 0 的数（说明游标已对齐，不会重放历史）

### 撤回

```bash
node bin/dsh-arkhub.mjs uninstall
```

删掉依赖、bundle 登记、装配行三处，其他条目一个字不碰；然后重启 DSH。
反复装过也不会留下多余空行 —— 卸完的 `cordis.patch.yml` 与装之前逐字节一致（有测试盯着这件事）。

---

## 换成门面模式（世界控制台那张 QQ 卡才有数）

默认的「会话模式」是本插件自己把消息投进她的会话 —— 简单，但世界控制台（设置 → 世界控制台 →
接入 → QQ）那张卡读的是 **qq-bridge**，所以它会显示「未运行」。

想让它显示真的（桥在跑、上次收包、每个入口绑了哪间会话、主动聊天统计），就换成门面模式：
本插件只做 OneBot 服务端，会话由 qq-bridge 按它自己的机制（`state/sessions.json` 按
`private:<QQ>` / `group:<群号>` 绑定）来投。**收信要另外接一条**——见下一节。

### 概念：一条「线」= 一个号 + 桥的上游

| 线 | 谁在说话 | 桥的上游 | 收信 / 富消息 |
| --- | --- | --- | --- |
| `vm` | VM 里登录的那个号 | 本插件的门面 `127.0.0.1:3010` | VM 里的 SnowLuma（语音、引用、图片都在协议层）；发文字失败才退回 ArkLink |
| `windows` | 本机 SnowLuma 登录的那个号 | 真 SnowLuma（换桥前 `config.json` 里的地址，通常 `:3001`） | 全由 qq-bridge + 本机 SnowLuma 负责，本插件待命 |

号不用单独选：桥的上游指向谁，说话的就是谁的号。选 `windows` 时装配行里的
`channel.enabled` 会一起关掉 —— 本插件不轮询、不开门面，只留状态和换线路由；
不关的话它会拿另一个号同时回话。

### 在世界控制台里点（推荐）

```bash
node tools/dsh-world-patch/apply.mjs     # 给 dsh-world 的 QQ 卡加一行「用哪个号」
```

装完重启 DSH，设置 → 世界控制台 → 接入 → QQ 卡上会多一行按钮：两条线各一个，
标着昵称和号、活没活、现在用哪条。点一下 = 换线 + 重启桥，十几秒；界面会自己轮询到切完。
进度写进 `~/.dsh/arkhub/line-switch.log`。

> dsh-world 升级会把这些改动冲掉（它装在 `node_modules` 里，没有扩展接口）。冲掉之后
> 再跑一次上面那条命令就行，补丁是幂等的；`--check` 只看不装。

### 用命令行

```bash
node bin/dsh-arkhub.mjs lines          # 看有哪两条线、各自活没活、现在在哪条
node bin/dsh-arkhub.mjs line vm        # 换到门面（VM 里的号）
node bin/dsh-arkhub.mjs line windows   # 换回原桥（本机 SnowLuma 直连），本插件随之待命
```

`bridge use` / `bridge rollback` 是这两个的旧名字，行为一致。

`line vm` 一口气做三件事：

1. 把装配行里的 `bridge.enabled` / `channel.enabled` 翻成 `true`（DSH 热重载，门面 :3010 当场起来）；
2. 把 `~/.dsh/qq-bridge/config.json` 的 `snowluma.httpUrl` / `wsUrl` 指向 `127.0.0.1:3010`、
   `accessToken` 对齐，并关掉 `followDiscoveredEndpoint` —— 这条最关键：桥的自愈机制默认会
   「发现」真实 SnowLuma 并悄悄连回去、把配置改回来，不关等于没换；
   原配置先存一份 `config.json.dsh-arkhub.bak`（换回来就是从这里还原，DSH 的端口用现在这个，
   备份里那份可能已经过期）；
3. 打桥自己的 `/api/restart` 让它按新配置重连（世界控制台的 halt/start 门不顶用——
   halt 会把连接打断，start 只看「活着没」，桥喘着气就回 already-running）。

跑完看 `node bin/dsh-arkhub.mjs status`：

`连着 1 个客户端` 就是桥连上来了。此时世界控制台那张卡上的「上次收包」会每 30 秒走一次
（那是门面发的心跳），绑定的会话就是 `sessions.json` 里那几条 —— 也就是说，**对话还是按
dsh-world / qq-bridge 原来的机制存在真机本地**，本插件不另存一份。

> 门面能听懂的动作：`get_login_info`、`get_status`、`get_version_info`、
> `get_group_list`、`get_friend_list`、`send_msg`、`send_private_msg`、`send_group_msg`。
> `get_login_info` / `get_group_list` / `get_friend_list` 在 SnowLuma 在线时用它的真实数据；
> 别的动作回 `retcode 1404`（桥会自己降级，不会崩）。

---

## 接上收信与富消息（VM 里装 SnowLuma）

ArkLink 在无头 Linux 上**只能发、不能收**，而且只会「打字」——语音、引用、图片都出不去。
这两件事在协议层都是现成的，所以把 SnowLuma 装进同一个 VM，让它出收信和富消息，
ArkLink 继续负责发文字。两个都不是必须：SnowLuma 不在时插件照旧能发文字，只是收不到。

VM 里一条命令（脚本在 ArkLink 仓库 `tools/snowluma/`）：

```bash
bash install.sh
```

它会把 Node 24、SnowLuma lite 包、`hookAutoLoad: true`、systemd 单元、`0.0.0.0` 监听
都弄好，最后打印宿主机要填的两个端口和两个 token。宿主机补两条 NAT 转发
（**别用 3100**，那是 qq-bridge 的控制台，抢了会静默失效）：

```bash
VBoxManage controlvm arklink natpf1 "snowluma-http,tcp,127.0.0.1,3102,,3000"
VBoxManage controlvm arklink natpf1 "snowluma-ws,tcp,127.0.0.1,3101,,3001"
```

然后装配行补一段（`cordis.patch.yml`，DSH 热重载，不用重启）：

```yaml
        snowluma:
          enabled: true
          httpUrl: http://127.0.0.1:3102
          wsUrl: ws://127.0.0.1:3101
          httpToken: <install.sh 打印的 httpToken>
          wsToken: <install.sh 打印的 wsToken>
```

自检（三处都该对得上）：

```bash
curl -s http://127.0.0.1:3010/api/status
#   "sentVia":"snowluma"、"eventVia":"snowluma"、"snowluma":{"connected":true,...}
```

`eventVia` 是 `snowluma` 说明收信走的是它；`sentVia` 是 `snowluma` 说明发送（含语音/引用）
走的是它。两个都空 = 它没连上，文字仍会退回 ArkLink。

**兜底（可选）**：`tools/arkbot-arkhub/` 里有个 ArkBot 插件，让 ArkBot 独立再连一份协议端，
把消息 `POST /dsh-arkhub/ingest` 塞进门面。门面按 `message_id` 去重，同一条不会进两次。
「协议层彻底不可用也还能收」需要官方机器人通道（`official_qq`，群聊只在被 @ 时收到），
要开放平台的 app_id / app_secret。

---

## 排障

安装器已经把大部分坑挡掉了。剩下这几个是「环境」问题，脚本改不了：

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `doctor` 说 ArkLink 不通 | 没启动，或 `~/.arklink/api.json` 里 token 过期 | 启动 ArkLink；重登一次让它写新 token。插件会在下次请求时自动重读，不用重启 DSH |
| 收得到、发不出去 | **ArkLink 在演练模式（dry-run）** | 在 ArkLink 内部关掉演练。`status` 里 `channel.dryRun: true` 就是它 |
| 发得出去、一条也收不到 | ArkLink 的 hook 管道没起来（没注入 / 模块跟 QQ 版本不兼容） | 见下面「收不到消息」一节，`doctor` 里也有一行专门的检查 |
| 装完谁说话都不理 | 白名单为空 = 谁都不理 | ArkLink 没连上时读不到允许列表，连上后重跑 `install`，或 `--private/--groups` 手工指定 |
| 群里不接话 | 默认 `groupTrigger: mention` | 要 @ 她或说到关键词（`groupKeywords`）。想全接改成 `all` |
| 一条回复发两遍 | dsh-world 的 `qqNative` / `qqBridge` 也连着同一个 QQ | 一个 QQ 只能有一条线。把 dsh-world 那侧的通道关掉，只留本插件 |
| `/dsh-arkhub/status` 打不开 | DSH 没重启，或端口不是 62560 | 重启；端口以 DSH 实际监听为准 |
| 回复内容被砍成多段 | 她一次说了好几句 | 正常行为：按空行切成几条发，间隔 260ms |

---

## 收不到消息：先查 ArkLink 的「收信」能力

这个故障最阴：**发送一切正常，就是一条消息也收不到**，面板上看不出任何异常。
原因是 ArkLink 收信靠 hook 注入 QQ 进程，用管道把消息送进总线；管道不在，入站就是空的。

### 三步自查（都不用登录控制台）

```bash
node bin/dsh-arkhub.mjs doctor          # 看「ArkLink 收信」这一行
curl -s http://127.0.0.1:6800/api/doctor # 6800 = API 端口 -100，无需 token
arklink hook --list                     # 「管道」列是 missing 还是 arklink.<pid>
```

客观指标只有一个：`curl -H "Authorization: Bearer <token>" http://127.0.0.1:6900/api/v1/status`
里的 `bus.total` 会不会涨。**别拿面板上的「上次收包」当证据** —— 那个数可能来自另一条通道（SnowLuma）。

### Windows

```bash
arklink hook --install          # 找主进程 → 编译 DLL → 注入 → 自检
```

### Linux

`arklink hook --install` 在 Linux 上会**永远报「没找到 QQ.exe」**，因为它的进程过滤写死了 `QQ.exe`，
而 Linux 上进程名是 `qq`。绕开它，手动三步：

```bash
cd /opt/ArkLink
python3 tools/build_hook.py                                  # 产物 hookdll/build/libarklink-hook-x64.so
sudo sysctl -w kernel.yama.ptrace_scope=0                    # Ubuntu 默认 1，注入第三方进程会被 EPERM 挡
arklink hook --inject --pid $(pgrep -f '/usr/bin/qq' | head -1) \
        --dll hookdll/build/libarklink-hook-x64.so
```

`ptrace_scope` 想永久生效：`echo 'kernel.yama.ptrace_scope = 0' | sudo tee /etc/sysctl.d/10-ptrace.conf`。

如果 `--inject` 报 `dlopen 返回 0`，是它自己的 ptrace 远程调用不可靠（返回值可能是地址空间的乱码）。
用 gdb 代替，效果相同且不动登录态：

```bash
gdb -q -p <主进程pid> -batch \
  -ex 'call (void*) dlopen("/opt/ArkLink/hookdll/build/libarklink-hook-x64.so", 2)' \
  -ex detach
```

### 判断「注入器坏了」还是「模块本身不兼容」

写一个只写文件的 10 行 `libprobe.so` 注入进去。**注入成功但 hook 模块仍崩**，说明问题在模块，
不在权限、也不在注入方式。已知：

> ArkLink 0.13.0 的 POSIX hook 在 **QQ 3.2.32（Electron 40）/ Ubuntu 24.04** 上加载即崩：
> `dlopen` 返回了非零句柄，紧接着在 `memcpy` 里 SIGSEGV，被 QQ 自带的 `libbugly.so` 崩溃处理器接住，
> 随后 QQ 退出（守护脚本会把它拉起来，登录态不丢）。管道始终不出现。
>
> 这种情况**在客户端侧无解**，只能等上游修，或者把 ArkLink 放到 Windows 上跑（那里是它的主战场）。
> 不要反复试注入 —— 每次都让 QQ 重启一次。

---

## 配置改在哪

装配行在 profile 的 `cordis.patch.yml` 里，标记块 `# === dsh-arkhub BEGIN ... END ===` 之间。
手改也行，但下次 `install` 会整段替换掉 —— 常改的几项（回不回、白名单）可以用接口热改，不用重启：

```bash
curl -X POST http://127.0.0.1:62560/dsh-arkhub/config \
  -H 'x-dsh-arkhub: 1' -H 'content-type: application/json' \
  -d '{"autoReply": true}'
```
