# 装到 DSH 上

这份文档是写给**替你动手的那个助手**看的。你只要把仓库链接贴给它，说「照 INSTALL.md 装」，它跑两条命令就够了。

---

## 给人看的三句话

1. 先确认 ArkLink 在跑、QQ 登着（这一步本来就要做，不是本插件要求的）。
2. 在仓库目录里跑 `node bin/dsh-arkhub.mjs install`。
3. 重启 DSH。

装完她会用**原来那个会话**回 QQ 消息，不新建角色、不另起进程。

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
`private:<QQ>` / `group:<群号>` 绑定）来投。**SnowLuma 不再需要参与。**

三步：

```bash
# 1. 让本插件开门面（OneBot 的 httpUrl / wsUrl 都指向 127.0.0.1:3010）
node bin/dsh-arkhub.mjs install --bridge
```

```bash
# 2. 把桥的上游指向门面（先停桥，改完再起；桥只在启动时读 config.json）
#    ~/.dsh/qq-bridge/config.json
#      snowluma.httpUrl  → http://127.0.0.1:3010
#      snowluma.wsUrl    → ws://127.0.0.1:3010
#      snowluma.accessToken → 与插件里的 bridge.token 一致（插件留空则随便填/留空）
#    重启桥：世界控制台 QQ 卡上的「重启」，或
curl -X POST http://127.0.0.1:62560/dsh-world/qq/halt -H 'x-dsh-world: 1' -d '{}'
curl -X POST http://127.0.0.1:62560/dsh-world/qq/start -H 'x-dsh-world: 1' -d '{}'
```

3. 重启 DSH，然后看 `node bin/dsh-arkhub.mjs status`：

```
接法            门面模式（OneBot → qq-bridge 投会话）
门面            127.0.0.1:3010 连着 1 个客户端
                事件 0 / 已发 0 / 游标 3
```

`连着 1 个客户端` 就是桥连上来了。此时世界控制台那张卡上的「上次收包」会每 30 秒走一次
（那是门面发的心跳），绑定的会话就是 `sessions.json` 里那几条 —— 也就是说，**对话还是按
dsh-world / qq-bridge 原来的机制存在真机本地**，本插件不另存一份。

> 门面能听懂的动作：`get_login_info`、`get_status`、`get_version_info`、
> `get_group_list`、`get_friend_list`、`send_msg`、`send_private_msg`、`send_group_msg`。
> 别的动作回 `retcode 1404`（桥会自己降级，不会崩）。图片、语音、表情这类富媒体暂不支持，
> 发出去会被降级成纯文本。

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
