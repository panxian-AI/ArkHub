/**
 * 一键换桥：会话模式 ⇄ 门面模式。
 *
 * 会话模式（默认）：本插件自己把消息投进她的会话，但世界控制台那张 QQ 卡
 * 读的是 qq-bridge，所以卡片显示「未运行」。
 *
 * 门面模式：本插件只做 OneBot 服务端（:3010），qq-bridge 按它自己的机制
 * （state/sessions.json 按 private:<QQ> / group:<群号> 绑定）投会话；
 * 卡片上「运行中 / 上次收包 / 会话绑定 / 主动聊天」都是真的。
 *
 * 换桥 = 三处改动，全部由这里一条命令做完、一条命令退回：
 *   1. profile 的装配行里 bridge.enabled 翻一下（DSH 热重载，门面当场起来）
 *   2. qq-bridge 的 config.json：snowluma.httpUrl / wsUrl 指向门面，
 *      accessToken 对齐，followDiscoveredEndpoint 关掉 —— 这条最关键：
 *      桥的自愈机制默认会「发现」真实 SnowLuma 并悄悄连回去、把配置改掉
 *      （bridge.js 的 discoverSnowLumaConnection），不关等于没换。
 *   3. 重启桥（世界控制台的门：POST /dsh-world/qq/halt → /start），
 *      桥只在启动时读 config.json，不重启等于也没换。
 *
 * 退回（rollback）= 恢复 config.json 的换桥前备份 + 把 enabled 翻回去。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  applyPatchBlock,
  backupOnce,
  pickProfile,
  restoreBackup,
} from './dsh-home.js';

/** 从装配行里抠出本插件的配置块（BEGIN/END 之间的那段）。 */
function arkhubBlock(patchText) {
  const begin = patchText.indexOf(BLOCK_BEGIN_TEXT);
  const end = patchText.indexOf(BLOCK_END_TEXT);
  if (begin < 0 || end <= begin) return '';
  // 只取标记行**之后**的内容：applyPatchBlock 会自己补 BEGIN。把它留在块里，
  // 每写一次就多一行标记（2026-11-15 实测叠了 7 行）。
  const inner = patchText.slice(begin, end);
  return inner.replace(/^# === dsh-arkhub BEGIN[^\n]*\n/, '');
}

const BLOCK_BEGIN_TEXT = '# === dsh-arkhub BEGIN';
const BLOCK_END_TEXT = '# === dsh-arkhub END ===';

/** 从装配行里抠出 dsh-world 那一项的配置（qqBridgeDir / qqBridgePort）。 */
function worldBridge(patchText) {
  const match = patchText.match(/- id: dsh-world\n  name: dsh-world\n  config:\n((?:    .*\n)+)/);
  if (!match) return {};
  const grab = key => {
    const m = match[1].match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim().replace(/^'(.*)'$/, '$1') : '';
  };
  return { dir: grab('qqBridgeDir'), port: Number(grab('qqBridgePort')) || 3100 };
}

/** 配置块里的 bridge.port / bridge.token。 */
function bridgePortAndToken(block) {
  const port = Number(block.match(/\n          port: (\d+)/)?.[1]) || 3010;
  const tokenRaw = block.match(/\n          token: '(.*)'/)?.[1] ?? '';
  return { port, token: tokenRaw.replace(/''/g, "'") };
}

/** 翻 bridge.enabled；老装配行（0.2.x，没有 bridge 段）就补一段。 */
function flipBridge(block, enabled, port = 3010, token = '') {
  const next = enabled ? 'true' : 'false';
  const flipped = block.replace(
    /(\n        bridge:\n          enabled: )(true|false)/,
    `$1${next}`,
  );
  if (flipped !== block) return flipped;
  const stanza = [
    '        bridge:',
    `          enabled: ${next}`,
    `          port: ${port}`,
    `          token: '${token.replace(/'/g, "''")}'`,
    '          heartbeatMs: 30000',
  ].join('\n');
  return `${block.trimEnd()}\n${stanza}\n`;
}

/**
 * 翻 channel.enabled：本插件自己要不要在跑。
 *
 * 选「原桥」那条线时，桥的上游是真 SnowLuma，这时候本插件必须待命 —— 不然它还会
 * 用 ArkLink 轮询另一个号，两个号同时回话，谁都说不清哪句是谁说的。
 * 老装配行没有这一段，插在 `config:` 后面就行（YAML 里顺序无所谓）。
 */
function flipChannel(block, enabled) {
  const next = String(Boolean(enabled));
  const flipped = block.replace(/(\n        channel:\n          enabled: )(true|false)/, `$1${next}`);
  if (flipped !== block) return flipped;
  return block.replace('      config:\n', `      config:\n        channel:\n          enabled: ${next}\n`);
}

/**
 * 把「装在哪、桥在哪、现在指向谁」一次读出来。
 *
 * lines.js 和换桥流程都要这几样，与其各读一遍装配行，不如都从这里拿；
 * 读的是文件本身，所以插件待命（channel 关着）时也能用。
 */
export function inspectBridge({ home, profile = '' }) {
  const picked = pickProfile(home, profile || '');
  if (!picked || !picked.profile) {
    throw new Error(picked?.reason || '没找到可用的 profile');
  }
  const prof = picked.profile;
  const patchText = readFileSync(prof.patchFile, 'utf8');
  const block = arkhubBlock(patchText);
  if (!block) throw new Error(`装配行里没有 dsh-arkhub 块，先跑 install：${prof.patchFile}`);
  const world = worldBridge(patchText);
  const { port, token } = bridgePortAndToken(block);
  return {
    profile: prof,
    patchFile: prof.patchFile,
    patchText,
    block,
    world,
    port,
    token,
    bridgeEnabled: /(\n        bridge:\n          enabled: )(true|false)/.exec(block)?.[2] === 'true',
    channelEnabled: /(\n        channel:\n          enabled: )(true|false)/.exec(block)?.[2] !== 'false',
    configFile: world.dir ? join(world.dir, 'config.json') : '',
  };
}

async function restartBridge(configFile) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch {
    return { ok: false, reason: 'config.json 读不到' };
  }
  // 桥自己的重启端点最可靠：先拉起接力子进程再退出，起来后按新 config.json 连上游。
  // 世界控制台的两扇门（halt/start）不顶用——halt 会把连接打断，start 又只看「活着没」，
  // 桥只要还喘气就回 already-running，配置改了也不重读。
  const token = readConsoleToken(configFile);
  const port = config.consolePort || 3100;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/restart${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) return { ok: true, how: 'restart-endpoint' };
  } catch { /* 落到下面的门 */ }
  // 兜底：世界控制台的门（DSH 每次重启都换端口，config.dsh.baseUrl 可能是旧的）
  const base = String(config?.dsh?.baseUrl || '').replace(/\/+$/, '');
  if (/^http:\/\/127\.0\.0\.1:\d+/.test(base)) {
    try {
      let halted = false;
      for (const door of ['halt', 'start']) {
        const res = await fetch(`${base}/dsh-world/qq/${door}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-world': '1' },
          body: '{}',
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 200 && door === 'start') return { ok: true, how: 'doors' };
        if (res.status === 200) halted = true;
      }
      if (halted) return { ok: true, how: 'doors-halt-only' };
    } catch { /* 都不行就算了 */ }
  }
  return { ok: false, reason: '自动重启没走通' };
}

/** 桥的控制台令牌：config.json 优先，其次 state/console-token（每次启动重写）。 */
function readConsoleToken(configFile) {
  try {
    const fromConfig = JSON.parse(readFileSync(configFile, 'utf8'))?.consoleToken?.trim();
    if (fromConfig) return fromConfig;
  } catch { /* 读不到就看文件那份 */ }
  try {
    return readFileSync(join(dirname(configFile), 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 换桥主流程。幂等：再跑一次接着走，不悄悄全退。
 *
 * `channel` 只在「换到原桥」时用得上：桥的上游变回真 SnowLuma 之后，本插件不该再
 * 用自己的号轮询（那样会两个号一起回话），所以整段停掉、只留状态路由。
 *
 * 返回 { configFile, bridgeDir, port } 供 CLI 打印与重启桥。
 */
export function bridgeSwitch({ home, use, profile, channel = true, logger = console }) {
  const info = inspectBridge({ home, profile });
  const { profile: prof, patchText, block, world, port, token } = info;
  if (!world.dir) {
    throw new Error('装配行里没找到 dsh-world 的 qqBridgeDir —— 没装 dsh-world 就不需要换桥');
  }
  const configFile = info.configFile;
  if (!existsSync(configFile)) throw new Error(`桥的配置不存在：${configFile}`);

  // 1) 装配行：翻 bridge.enabled / channel.enabled（老块没有这些段就补一段）
  const nextBlock = flipChannel(flipBridge(block, use, port, token), channel);
  const nextText = applyPatchBlock(patchText, nextBlock);
  if (nextText !== patchText) {
    writeFileSync(prof.patchFile, nextText, 'utf8');
  }
  logger.log?.(`[1/3] 装配行 bridge.enabled → ${use}、channel.enabled → ${channel}（DSH 热重载，立刻生效）`);

  // 2) 桥的 config.json：指向门面 / 恢复备份
  if (use) {
    const bridgeConfig = JSON.parse(readFileSync(configFile, 'utf8'));
    backupOnce(configFile);
    bridgeConfig.snowluma = bridgeConfig.snowluma ?? {};
    bridgeConfig.snowluma.httpUrl = `http://127.0.0.1:${port}`;
    bridgeConfig.snowluma.wsUrl = `ws://127.0.0.1:${port}`;
    bridgeConfig.snowluma.accessToken = token;
    // 不关这个，桥的自愈会把端点改回真 SnowLuma（bridge.js 里的端点跟随）
    bridgeConfig.snowluma.followDiscoveredEndpoint = false;
    writeFileSync(configFile, `${JSON.stringify(bridgeConfig, null, 2)}\n`, 'utf8');
    logger.log?.(`[2/3] ${configFile}：snowluma.httpUrl / wsUrl → 127.0.0.1:${port}，端点跟随已关（原样存了 .dsh-arkhub.bak）`);
  } else {
    // 备份是「换桥之前」的样子，那时候 DSH 的端口可能不是现在这个；把 dsh 这一段
    // 用现在的盖回去，否则桥起来就找不到 DSH，界面看着像连上了其实一帧都不来。
    const live = readJsonSafe(configFile);
    restoreBackup(configFile);
    if (live?.dsh) {
      const restored = readJsonSafe(configFile);
      restored.dsh = live.dsh;
      writeFileSync(configFile, `${JSON.stringify(restored, null, 2)}\n`, 'utf8');
    }
    logger.log?.(`[2/3] ${configFile}：已恢复换桥前的备份（DSH 端点保留现在的）`);
  }

  return { configFile, bridgeDir: world.dir, port };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 换桥 + 重启桥一条龙。 */
export async function bridgeSwitchAndRestart(options) {
  const result = bridgeSwitch(options);
  const restarted = await restartBridge(result.configFile);
  if (restarted.ok) {
    options.logger?.log?.('[3/3] 桥已重启（桥自己的 /api/restart），几秒后按新配置连上游');
  } else {
    options.logger?.log?.('[3/3] 桥没能自动重启：世界控制台 QQ 卡上点一下「重启」即可。');
  }
  return { ...result, restarted };
}
