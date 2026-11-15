#!/usr/bin/env node
/**
 * dsh-arkhub 的命令行：装、卸、看状态、体检。
 *
 * 设计原则：装一个 DSH 插件本来要人做四件事（改 package.json、改 cordis.patch.yml、
 * 跑 pnpm、填 QQ 号）。四件事里三件是机械的，机械的就该由命令做——
 * 所以 `dsh-arkhub install` 一条命令做完，人只剩「重启 DSH」这一下。
 *
 * 幂等：重复 install 不会重复登记、不会把配置翻倍；uninstall 只删自己那段。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  BUNDLE_ID,
  applyPatchBlock,
  backupOnce,
  buildPatchBlock,
  dshHome,
  dropBackup,
  ensureBundle,
  appendWorldBlock,
  findToolchain,
  linkSpec,
  WORLD_SPEC,
  listProfiles,
  pickProfile,
  readJson,
  removeBundle,
  removeIfExists,
  stripPatchBlock,
  writeJson,
} from '../lib/dsh-home.js';
import { detectArklink, detectWorld } from '../lib/detect.js';
import { normalizeConfig } from '../lib/config.js';
import { QqLink } from '../lib/arklink.js';
import { bridgeSwitchAndRestart } from '../lib/switch.js';
import { describeLines, switchLine } from '../lib/lines.js';
import { listDays, localDay, readDay, readState, sampleOnce, statePath, summarize } from '../lib/monitor.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `dsh-arkhub — 把 DSH 里的角色接上 QQ

用法：
  dsh-arkhub install      装进 DSH profile（自动选 profile、自动填账号）
  dsh-arkhub uninstall    撤回，把 profile 还原成装之前的样子
  dsh-arkhub status       看装了没、通道通没通
  dsh-arkhub doctor       体检：逐项告诉你哪里没通、怎么修
  dsh-arkhub monitor      盯稳定性：收到的消息 + 存活时间，一直记到 Ctrl+C
  dsh-arkhub monitor --once            采一次就走（看通不通）
  dsh-arkhub monitor --report          看今天（和前两天的总结）
  dsh-arkhub monitor --report --push 10001   看完直接推到 QQ，不问你
  dsh-arkhub lines        看有哪两条线（哪个号、桥现在指向谁）
  dsh-arkhub line vm      换成门面那条线（VM 里的号 + ArkHub 门面）
  dsh-arkhub line windows 换成原桥那条线（本机 SnowLuma 直连），本插件随之待命
  dsh-arkhub bridge use      = line vm（旧名字，留着不废）
  dsh-arkhub bridge rollback = line windows

安装参数：
  --profile <名字>   指定 profile（默认自动挑：装了 dsh-world 的那个）
  --home <路径>      DSH 根目录（默认 ~/.dsh，或 $DSH_HOME）
  --uin <QQ号>       账号 QQ（默认从 ArkLink 读）
  --private <a,b>    允许私聊的 QQ，逗号分隔（默认取 ArkLink 的允许列表）
  --groups <a,b>     允许的群，逗号分隔（默认取 ArkLink 的允许列表）
  --no-reply         装好先只收不回（观察用）
  --bridge           门面模式：只做 OneBot，让 qq-bridge 按它的机制投会话
                     （世界控制台那张 QQ 卡才是真的；见 INSTALL.md）
  --json             机器可读输出

装完需要重启 DSH 才生效（profile 是启动时读的）。`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const one = argv[i];
    if (!one.startsWith('--')) {
      args._.push(one);
      continue;
    }
    const key = one.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

/** 中文占两格宽，按字符数补空格会歪掉，所以按显示宽度对齐。 */
const displayWidth = value =>
  [...String(value)].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (label, cols = 16) => `${label}${' '.repeat(Math.max(cols - displayWidth(label), 1))}`;
const mark = ok => (ok ? '[ok]' : '[!!]');

function splitList(value) {
  if (!value || value === true) return null;
  return String(value)
    .split(/[,，\s]+/)
    .map(one => one.trim())
    .filter(Boolean);
}

/** 运行 DSH 自带 pnpm；用户 PATH 里不一定有。 */
function runInstall(profileDir, home) {
  const { node, pnpm } = findToolchain(home);
  if (!pnpm) return { ok: false, output: '找不到 DSH 自带的 pnpm（~/.dsh/dsh-runtimes/*/dependencies/pnpm）' };
  const res = spawnSync(node, [pnpm, 'install', '--dir', profileDir], {
    encoding: 'utf8',
    timeout: 180_000,
    shell: false,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, output };
}

async function buildConfig(args, home) {
  const arklink = await detectArklink();
  const world = detectWorld(home);

  const uin = String(args.uin && args.uin !== true ? args.uin : arklink.uin || '');
  const allowPrivate = splitList(args.private) ?? arklink.allowPrivate;
  const allowGroups = splitList(args.groups) ?? arklink.allowGroups;

  return {
    arklink,
    world,
    config: {
      arklink: { baseUrl: arklink.baseUrl },
      qq: {
        accountUin: uin,
        allowPrivate,
        allowGroups,
        ownerQQ: uin,
        autoReply: args['no-reply'] !== true,
        groupKeywords: ['大肥鱼', '鲸鱼', '小鲸鱼', '在吗'],
      },
      session: { worldId: world.worldId },
      bridge: { enabled: args.bridge === true },
    },
  };
}

async function commandInstall(args) {
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();
  if (!existsSync(home)) {
    console.error(`DSH 目录不存在：${home}\n先装 DSH，或用 --home 指定。`);
    return 1;
  }

  const { profile, profiles, reason } = pickProfile(home, args.profile && args.profile !== true ? String(args.profile) : '');
  if (!profile) {
    console.error(reason);
    if (profiles.length) console.error(`现有 profile：${profiles.map(p => p.name).join(', ')}`);
    return 1;
  }

  const { arklink, world, config } = await buildConfig(args, home);

  console.log(`装到 profile：${profile.name}（${reason}）`);

  // 1) 依赖 + bundles。全新 DSH 上 dsh-world 多半不在 —— 世界控制台那张 QQ 卡就是它画的，
  //    「用哪个号」的选择器也在它身上，所以一并列进依赖，一次 pnpm 全落地。
  backupOnce(profile.file);
  const pkgText = readFileSync(profile.file, 'utf8');
  const pkg = readJson(profile.file);
  pkg.dependencies = pkg.dependencies || {};
  const worldWasInstalled = Boolean(pkg.dependencies['dsh-world']);
  if (!worldWasInstalled) pkg.dependencies['dsh-world'] = WORLD_SPEC;
  const worldBundleAdded = ensureBundle(pkg, 'dsh-world');
  pkg.dependencies[BUNDLE_ID] = linkSpec(REPO_ROOT);
  const bundleAdded = ensureBundle(pkg);
  writeJson(profile.file, pkg);

  // 2) 装配行。dsh-world 块只在全新状态补（已有 `- id: dsh-world` 就一字不动）
  const patchFile = profile.patchFile;
  const before = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '';
  backupOnce(patchFile);
  const worldBlockAdded = !worldWasInstalled && !/^-\s*id:\s*dsh-world\b/m.test(before);
  const patchBase = worldBlockAdded ? appendWorldBlock(before, home) : before;
  writeFileSync(patchFile, applyPatchBlock(patchBase, buildPatchBlock(config)), 'utf8');

  // 3) 依赖落地。失败就把刚写的两个文件退回原样，不给人留一个半装状态
  console.log('安装依赖…');
  const installed = runInstall(profile.dir, home);
  if (!installed.ok) {
    writeFileSync(profile.file, pkgText, 'utf8');
    writeFileSync(patchFile, before, 'utf8');
    console.error('依赖安装失败，已把 profile 退回原样。');
    console.error(installed.output.split('\n').slice(-12).join('\n'));
    return 1;
  }

  const linked = existsSync(join(profile.dir, 'node_modules', BUNDLE_ID));
  const worldLinked = existsSync(join(profile.dir, 'node_modules', 'dsh-world'));

  // 4) dsh-world 刚装上的话，顺手把「用哪个号」的补丁打上（幂等；失败不拦安装，
  //    QQ 卡少一行选择器而已，命令行换线照用）。已有 dsh-world 也不打 —— 那份可能
  //    是别处维护的版本，改之前该由人决定。
  let worldPatchNote = '';
  if (!worldWasInstalled && worldLinked) {
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'tools', 'dsh-world-patch', 'apply.mjs'), '--home', home, '--profile', profile.name], { encoding: 'utf8' });
    worldPatchNote = res.status === 0
      ? '（「用哪个号」选择器已打上）'
      : `（选择器补丁没全成，不影响使用：${String(res.stdout || res.stderr || '').split('\n').filter(Boolean).slice(-1).join(' ')}）`;
  }

  console.log('');
  console.log(`${mark(true)} profile      ${profile.file}${bundleAdded || worldBundleAdded ? '（已登记 bundle）' : '（bundle 早已登记）'}`);
  console.log(`${mark(worldLinked)} dsh-world    ${worldWasInstalled ? '本来就有，没动' : `已装（依赖 + bundle${worldBlockAdded ? ' + 装配行' : ''}）`}${worldLinked ? worldPatchNote : ''}`);
  console.log(`${mark(true)} 装配行       ${patchFile}`);
  console.log(`${mark(linked)} 依赖         ${linked ? `node_modules/${BUNDLE_ID} → ${REPO_ROOT}` : '未落地，检查 pnpm 输出'}`);
  console.log(`${mark(Boolean(config.qq.accountUin))} 账号         ${config.qq.accountUin || '未识别（ArkLink 没连上？装好后到面板里改）'}`);
  console.log(`${mark(config.qq.allowPrivate.length + config.qq.allowGroups.length > 0)} 白名单       私聊 ${config.qq.allowPrivate.join(' ') || '无'} / 群 ${config.qq.allowGroups.join(' ') || '无'}`);
  console.log(`${mark(Boolean(world.homeSessionId))} 角色         worldId=${world.worldId}${world.homeSessionId ? ` 会话 ${world.homeSessionId.slice(0, 18)}…` : '（还没建会话，首次说话时会自己建）'}`);
  console.log(`${mark(config.qq.autoReply)} 自动回复     ${config.qq.autoReply ? '开（收到就回）' : '关（只收不回，观察用）'}`);
  console.log(`${mark(true)} 接法         ${config.bridge.enabled ? `门面模式：OneBot 在 127.0.0.1:${config.bridge.port}，会话由 qq-bridge 投` : '会话模式：本插件直接把消息投进她的会话'}`);

  if (!config.qq.allowPrivate.length && !config.qq.allowGroups.length) {
    console.log('');
    console.log('注意：白名单是空的 —— 现在谁说话她都不会理。');
    console.log('      ArkLink 没连上时读不到允许列表，连上后重跑 install，或用 --private/--groups 指定。');
  }
  if (arklink.dryRun === true) {
    console.log('');
    console.log('注意：ArkLink 处于演练模式（dry-run）—— 收得到、发不出去，看起来一切正常但消息不出网。');
    console.log('      要先在 ArkLink 里关掉演练，这一步在它的虚拟机内部，命令行改不到。');
  }
  if (arklink.error) console.log(`\n提示：ArkLink 探测失败（${arklink.error}），账号/白名单需要手工补。`);

  console.log('');
  console.log('最后一步：重启 DSH。profile 只在启动时读一次。');
  console.log('重启后打开 http://127.0.0.1:62560/dsh-arkhub/status 能看到 running: true 就通了。');
  return 0;
}

async function commandUninstall(args) {
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();
  const list = listProfiles(home);
  const target = args.profile && args.profile !== true
    ? list.find(p => p.name === String(args.profile))
    : list.find(p => p.installed || p.bundles.includes(BUNDLE_ID));

  if (!target) {
    console.log('没有找到装过 dsh-arkhub 的 profile，无需撤回。');
    return 0;
  }

  const pkg = readJson(target.file);
  const hadDep = Boolean(pkg.dependencies?.[BUNDLE_ID]);
  if (pkg.dependencies) delete pkg.dependencies[BUNDLE_ID];
  const bundleRemoved = removeBundle(pkg);
  writeJson(target.file, pkg);

  if (existsSync(target.patchFile)) {
    const after = stripPatchBlock(readFileSync(target.patchFile, 'utf8'));
    writeFileSync(target.patchFile, after, 'utf8');
  }

  const off = runInstall(target.dir, home);
  const leftover = removeIfExists(join(target.dir, 'node_modules', BUNDLE_ID));

  dropBackup(target.file);
  dropBackup(target.patchFile);

  console.log(`已从 profile ${target.name} 撤回：`);
  console.log(`  依赖          ${hadDep ? '已移除' : '本来就没有'}`);
  console.log(`  bundle 登记   ${bundleRemoved ? '已移除' : '本来就没有'}`);
  console.log(`  装配行        ${existsSync(target.patchFile) ? '已删掉本插件那一段（其余原样保留）' : '没有 cordis.patch.yml'}`);
  console.log(`  落地的文件    ${leftover ? '已删除' : '没有残留'}`);
  if (!off.ok) console.log(`  pnpm 同步    失败（不影响撤回）：${off.output.split('\n').slice(-3).join(' ')}`);
  console.log('重启 DSH 后这个插件就彻底不在了。');
  return 0;
}

async function commandStatus(args) {
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();
  const list = listProfiles(home);
  const target = list.find(p => p.installed || p.bundles.includes(BUNDLE_ID));
  const world = detectWorld(home);
  const arklink = await detectArklink();
  const endpoint = 'http://127.0.0.1:62560/dsh-arkhub/status';

  let live = null;
  let liveStatus = 0;
  let liveError = '';
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(2500) });
    liveStatus = res.status;
    if (res.ok) live = await res.json();
  } catch (error) {
    liveError = error?.cause?.code || error?.message || String(error);
  }

  const out = {
    repo: REPO_ROOT,
    dshHome: home,
    profiles: list.map(p => ({ name: p.name, installed: p.installed, hasBundle: p.bundles.includes(BUNDLE_ID) })),
    profile: target?.name ?? null,
    world,
    arklink,
    live: live
      ? {
          mode: live.mode || 'session',
          running: Boolean(live.channel?.running),
          homeBound: Boolean(live.channel?.homeBound),
          uin: live.channel?.account?.uin || live.channel?.account || '',
          cursor: live.channel?.cursor ?? null,
          counts: live.channel?.counts ?? null,
          // 门面模式没有「收到/回复」，只有事件与发送计数；把它们的数接过来好一起显示
          events: live.channel?.events ?? null,
          sent: live.channel?.sent ?? null,
          clients: live.channel?.clients ?? null,
          bridgePort: live.channel?.port ?? null,
          lastError: live.channel?.lastError || '',
        }
      : null,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  console.log(`${pad('插件')}${target ? `已装进 profile ${target.name}` : '未安装（跑 install）'}`);
  console.log(`${pad('ArkLink')}${arklink.ok ? `通，账号 ${arklink.uin || '未知'}` : `不通：${arklink.error}`}`);
  if (arklink.dryRun === true) console.log(`${pad('')}发送引擎：${arklink.engine || 'dry-run'}（演练，消息不出网）`);
  if (arklink.receive?.known) {
    console.log(`${pad('')}收信：${arklink.receive.pipeOk ? 'hook 管道在' : 'hook 管道不在，收不到消息（跑 doctor 看怎么补）'}`);
  }
  console.log(`${pad('角色')}worldId=${world.worldId}${world.homeSessionId ? ` 会话 ${world.homeSessionId.slice(0, 18)}…` : ' 未绑定'}`);
  if (live) {
    if (out.live.mode === 'bridge') {
      console.log(`${pad('接法')}门面模式（OneBot → qq-bridge 投会话）`);
      console.log(`${pad('门面')}127.0.0.1:${out.live.bridgePort} 连着 ${out.live.clients ?? 0} 个客户端`);
      console.log(`${pad('')}事件 ${out.live.events ?? 0} / 已发 ${out.live.sent ?? 0} / 游标 ${out.live.cursor}`);
    } else {
      console.log(`${pad('接法')}会话模式（本插件直接把消息投进她的会话）`);
      console.log(`${pad('通道')}running=${out.live.running} homeBound=${out.live.homeBound} 游标=${out.live.cursor}`);
      console.log(`${pad('')}收 ${out.live.counts?.received ?? 0} / 回 ${out.live.counts?.replied ?? 0} / 发 ${out.live.counts?.sent ?? 0} / 拦 ${out.live.counts?.blocked ?? 0} / 失败 ${out.live.counts?.failed ?? 0}`);
    }
    if (out.live.lastError) console.log(`${pad('')}最近错误：${out.live.lastError}`);
  } else {
    // 连不上分三种：端口没人听 / 服务在但路由不在（插件没加载）/ 别的错
    const why = liveStatus === 404
      ? 'DSH 在跑，但 /dsh-arkhub 这段路由不在 —— 插件没被加载（没装，或装完还没重启）'
      : liveStatus
        ? `端口有响应，但返回 ${liveStatus}`
        : `连不上 ${endpoint}（${liveError || 'DSH 没启动？端口不对？'}）`;
    console.log(`${pad('通道')}${why}`);
  }
  return 0;
}

async function commandDoctor(args) {
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();
  const checks = [];
  const add = (ok, name, detail, fix) => checks.push({ ok, name, detail, fix });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22, 'Node 版本', `v${process.versions.node}`, '需要 Node >= 22（DSH 自带的那份就够）');

  add(existsSync(home), 'DSH 目录', home, '先装 DSH，或用 --home 指定');

  const list = listProfiles(home);
  add(list.length > 0, 'profile', list.length ? list.map(p => p.name).join(', ') : '一个都没找到', 'profile 由 DSH 自己创建，先启动一次 DSH');

  const target = list.find(p => p.installed || p.bundles.includes(BUNDLE_ID));
  add(Boolean(target), '本插件', target ? `已登记在 ${target.name}` : '未安装', '跑 dsh-arkhub install');

  if (target) {
    const linked = existsSync(join(target.dir, 'node_modules', BUNDLE_ID));
    add(linked, '依赖落地', linked ? `node_modules/${BUNDLE_ID}` : '缺文件', '跑 dsh-arkhub install 重新装一次');
    const patch = existsSync(target.patchFile) ? readFileSync(target.patchFile, 'utf8') : '';
    add(patch.includes(BUNDLE_ID), '装配行', patch.includes(BUNDLE_ID) ? 'cordis.patch.yml 里有' : '没有', '跑 dsh-arkhub install 重写');
  }

  const { node, pnpm } = findToolchain(home);
  add(Boolean(pnpm), 'DSH 工具链', pnpm ? `${node}` : '没找到 node/pnpm', 'DSH 运行时会自带，重装 DSH 可恢复');

  const arklink = await detectArklink();
  add(arklink.ok, 'ArkLink', arklink.ok ? `账号 ${arklink.uin || '未知'}` : arklink.error, '确认 ArkLink 在跑，且 ~/.arklink/api.json 里的 token 是新的');
  add(Boolean(arklink.uin), '账号识别', arklink.uin || '读不到 uin', '用 --uin 手工指定');
  add(arklink.dryRun !== true, '发送引擎', arklink.engine ? `${arklink.engine}${arklink.dryRun === true ? '（演练，消息不出网）' : '（真发送）'}` : '看不出来（还没发过消息）', '在 ArkLink 内部切换发送引擎');

  // 收信：ArkLink 靠 hook 注入 QQ 进程，管道不在就一条消息也收不到（发送却一切正常）
  const recv = arklink.receive;
  const recvOk = recv?.known ? recv.pipeOk === true : true;
  add(
    recvOk,
    'ArkLink 收信',
    recvOk
      ? (recv?.known ? 'hook 管道在' : '看不出来（ArkLink 没给体检结果）')
      : `hook 管道不存在${recv?.pipeDetail ? `（${recv.pipeDetail}）` : ''}：发得出去，收不到`,
    process.platform === 'win32'
      ? 'arklink hook --install（找不到进程就手动 --inject --pid <QQ 主进程>）'
      : 'Linux：python tools/build_hook.py → sudo sysctl -w kernel.yama.ptrace_scope=0 → arklink hook --inject --pid <主进程> --dll hookdll/build/libarklink-hook-x64.so',
  );

  const world = detectWorld(home);
  add(Boolean(world.homeSessionId), '角色的家', world.homeSessionId ? `worldId=${world.worldId}` : 'life.json 里没有 homeSessionId', '先让角色在 DSH 里说过一句话，或让插件自己建一间');

  for (const one of checks) {
    console.log(`${mark(one.ok)} ${pad(one.name)} ${one.detail}`);
    if (!one.ok && one.fix) console.log(`     └ 处理：${one.fix}`);
  }
  const bad = checks.filter(one => !one.ok);
  console.log('');
  console.log(bad.length ? `${bad.length} 项待处理。` : '全部正常。');
  return bad.length ? 1 : 0;
}

function printSummary(sum, day) {
  const line = (label, value) => console.log(`${pad(label, 10)}${value}`);
  const when = at => (at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—');
  console.log(`\n== ${day} 稳定性 ==`);
  line('时段', `${when(sum.from)} → ${when(sum.to)}（${sum.spanMinutes} 分钟，${sum.samples} 次采样）`);
  line('在线率', `${sum.okRate.toFixed(2)}%（${sum.okCount}/${sum.samples}）`);
  line('ArkLink', `已连续存活 ${sum.uptimeMinutes} 分钟`);
  line('探测延迟', `p50 ${sum.latency.p50}ms / p95 ${sum.latency.p95}ms / 最大 ${sum.latency.max}ms`);
  line('总线', `收包 ${sum.bus.total}，丢 ${sum.droppedDelta}，重复 ${sum.bus.duplicates}`);
  line('消息', `${sum.messages} 条`);
  for (const one of sum.byPeer) console.log(`${pad('', 10)}${one.key} × ${one.count}`);
  if (!sum.outages.length) {
    line('掉线', '没有');
    return;
  }
  line('掉线', `${sum.outages.length} 次`);
  for (const one of sum.outages) {
    console.log(`${pad('', 10)}${when(one.down)} → ${one.up ? when(one.up) : '（到采样结束仍未恢复）'}${one.reason ? `  ${one.reason}` : ''}`);
  }
}

async function commandMonitor(args) {
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();

  if (args.report) {
    const days = args.day && args.day !== true ? [String(args.day)] : listDays(home).slice(-3);
    if (!days.length) {
      console.log('还没有监控数据。先跑 dsh-arkhub monitor 攒一会儿，再回来看。');
      return 0;
    }
    const texts = [];
    for (const day of days) {
      printSummary(summarize(readDay(home, day)), day);
      const sum = summarize(readDay(home, day));
      texts.push(
        `【${day} 稳定性】在线率 ${sum.okRate.toFixed(1)}%，ArkLink 存活 ${sum.uptimeMinutes} 分钟，`
          + `收包 ${sum.bus.total}（丢 ${sum.droppedDelta}），消息 ${sum.messages} 条，`
          + `掉线 ${sum.outages.length} 次`,
      );
    }
    // 推送不问人：给了 --push 就直接发。发送走 ArkLink，和正常回复是同一条路。
    if (args.push) {
      const config = normalizeConfig({});
      const to = args.push === true ? String(config.qq.ownerQQ || '') : String(args.push);
      if (!to) {
        console.log('\n要推送得给个 QQ 号：--push 10001');
        return 1;
      }
      try {
        const receipt = await new QqLink(config, () => {}).send({ to, text: texts.join('\n') });
        const dry = receipt && (receipt.dry_run === true || String(receipt.engine || '') === 'dry-run');
        console.log(dry
          ? `\n已交给 ArkLink，但它在演练模式（dry-run）：这条没有真的发到 ${to}`
          : `\n已推送到 ${to}（没有二次确认，直接发的）`);
      } catch (error) {
        console.log(`\n推送失败：${error?.message || error}`);
        return 1;
      }
    }
    return 0;
  }

  const link = new QqLink(normalizeConfig({}), () => {});
  const state = readState(home);
  const everyMs = Math.max((Number(args.interval) || 30) * 1000, 5000);

  if (args.once) {
    const one = await sampleOnce({ link, home, state, log: console.log });
    return one.ok ? 0 : 1;
  }

  const dir = statePath(home).replace(/monitor\.json$/, 'monitor');
  console.log(`监控中：每 ${Math.round(everyMs / 1000)} 秒采一次，Ctrl+C 结束`);
  console.log(`记录放：${dir}\\${localDay()}.jsonl`);
  console.log(`接着上次的游标 ${state.since} 走，不会重复记。\n`);

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    printSummary(summarize(readDay(home, localDay())), '本次');
    process.exit(0);
  });

  while (!stopping) {
    await sampleOnce({ link, home, state, log: console.log });
    if (stopping) break;
    await new Promise(done => setTimeout(done, everyMs));
  }
  return 0;
}

/** 换桥：bridge use / bridge rollback。选一条线接入；两条线都挂着，切换互不拆台。 */
async function commandBridge(args) {
  const action = String(args._[1] || '');
  if (action !== 'use' && action !== 'rollback') {
    console.error('用法：dsh-arkhub bridge use ｜ dsh-arkhub bridge rollback');
    return 1;
  }
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();
  const use = action === 'use';
  try {
    const { port } = await bridgeSwitchAndRestart({
      home,
      use,
      profile: args.profile && args.profile !== true ? String(args.profile) : '',
      logger: console,
    });
    console.log('');
    if (use) {
      console.log(`${mark(true)} 门面        127.0.0.1:${port}（OneBot，qq-bridge 的上游已指到这里）`);
      console.log(`${mark(true)} 会话        由 qq-bridge 按它自己的机制投（真机本地 sessions.json）`);
      console.log(`   验证       世界控制台 → 设置 → 接入 → QQ：卡片应显示运行中、上次收包在走；`);
      console.log(`              或 node bin/dsh-arkhub.mjs status 看「门面 连着 N 个客户端」。`);
      console.log(`   双线常驻   本机 SnowLuma 那条线还挂着，bridge rollback 随时切过去，不用重起门面。`);
    } else {
      console.log(`${mark(true)} 已接入      原桥那条线（本机 SnowLuma 直连）`);
      console.log(`${mark(true)} 门面        还挂在 127.0.0.1:${port}（双线常驻，只是暂时没人连），随时 bridge use 切回`);
    }
    return 0;
  } catch (error) {
    console.error(`换桥失败：${error.message}`);
    return 1;
  }
}

/** 换线：line vm / line windows。三处改动一条命令做完，换回来也是一条。 */
async function commandLine(args) {
  const target = String(args._[1] || '');
  if (!['vm', 'windows'].includes(target)) {
    console.error('用法：dsh-arkhub line vm ｜ dsh-arkhub line windows（不带参数 = 只看现在在哪条线）');
    if (target === '') return commandLines(args);
    return 1;
  }
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();
  try {
    const { port, restarted } = await switchLine({
      home,
      target,
      profile: args.profile && args.profile !== true ? String(args.profile) : '',
      logger: console,
    });
    console.log('');
    if (target === 'vm') {
      console.log(`${mark(true)} 线          门面（VM 里的号），OneBot 在 127.0.0.1:${port}`);
      console.log(`${mark(true)} 收信        VM 里的 SnowLuma：语音、引用、图片都在协议层`);
      console.log(`${mark(true)} 发文字      先走 SnowLuma，失败退回 ArkLink`);
    } else {
      console.log(`${mark(true)} 线          原桥（本机 SnowLuma 直连），本插件已待命`);
      console.log(`${mark(true)} 收信/发信   全由 qq-bridge + 本机 SnowLuma 负责，不经过本插件`);
    }
    console.log(`${mark(restarted?.ok)} 桥          ${restarted?.ok ? '已重启，几秒后按新配置连上游' : '没自动重启：世界控制台 QQ 卡上点一下「重启」'}`);
    return 0;
  } catch (error) {
    console.error(`换线失败：${error.message}`);
    return 1;
  }
}

/** 只看：两条线各自活没活、现在用的是哪条。 */
async function commandLines(args) {
  const home = args.home && args.home !== true ? resolve(String(args.home)) : dshHome();
  try {
    const view = await describeLines({ home, profile: args.profile && args.profile !== true ? String(args.profile) : '' });
    console.log(`现在：${view.current === 'vm' ? '门面（VM 里的号）' : view.current === 'windows' ? '原桥（本机 SnowLuma）' : '看不出来'}`);
    for (const line of view.lines) {
      const flags = [line.current ? '← 当前' : '', line.alive ? '在线' : '没连上', line.available ? '' : '不可用'].filter(Boolean).join(' · ');
      console.log(`${mark(line.alive)} ${line.label.padEnd(22)} ${line.upstream || '—'}  ${flags}`);
      if (line.error) console.log(`    ${line.error}`);
    }
    return 0;
  } catch (error) {
    console.error(`读不到：${error.message}`);
    return 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0] || (args.help || args.h ? 'help' : 'help');

  if (command === 'help' || args.help || args.h) {
    console.log(HELP);
    return 0;
  }
  if (command === 'install') return commandInstall(args);
  if (command === 'uninstall' || command === 'remove') return commandUninstall(args);
  if (command === 'status') return commandStatus(args);
  if (command === 'doctor' || command === 'check') return commandDoctor(args);
  if (command === 'monitor' || command === 'watch') return commandMonitor(args);
  if (command === 'bridge') return commandBridge(args);
  if (command === 'line') return commandLine(args);
  if (command === 'lines') return commandLines(args);

  console.error(`不认识的命令：${command}`);
  console.log(HELP);
  return 1;
}

main()
  .then(code => process.exit(code ?? 0))
  .catch(error => {
    console.error(`出错了：${error?.message || error}`);
    process.exit(1);
  });
