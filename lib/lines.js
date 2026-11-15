/**
 * 「用哪个号」= 一条线。
 *
 * 一条线 = 一个 QQ 号 + 桥的上游从哪儿取协议。现在有两条：
 *
 *   vm       ArkHub 门面（127.0.0.1:3010）。门面后面是 VM 里的 SnowLuma（收信、语音、引用）
 *            和 ArkLink（发文字，失败才用）。号是 VM 里登录的那个。
 *   windows  真 SnowLuma 直连（换桥前 config.json 里的地址，通常是 127.0.0.1:3001）。
 *            号是那台 SnowLuma 登录的那个。
 *
 * 号不用单独选：桥的上游指向谁，说话的就是谁的号，所以「选账号」和「选线」是同一件事。
 * 这也是唯一说得通的切法 —— 号登录在哪台机器、由谁收信，本来就是绑在一起的。
 *
 * 这里只读文件 + 探活，不改任何东西；改东西的是 switch.js（换线要动装配行和桥配置）。
 */

import { existsSync, readFileSync } from 'node:fs';

import { inspectBridge } from './switch.js';

/** 探活给短超时：控制台一张卡片不该为了一个没开的端口等半天。 */
const PROBE_TIMEOUT_MS = 2500;

export const LINE_IDS = ['vm', 'windows'];

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** `ws://127.0.0.1:3010` → 3010。端口是这套东西里唯一可靠的指纹。 */
export function portOf(url) {
  const text = String(url ?? '').trim();
  if (!text) return 0;
  try {
    const parsed = new URL(text);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80;
  } catch {
    const matched = text.match(/:(\d{2,5})(?:\/|$)/);
    return matched ? Number(matched[1]) : 0;
  }
}

/**
 * 两条线的静态描述 + 现在指向哪条。同步、不联网，文件读不到也照常返回。
 */
export function describeLocalLines({ home, profile = '', config = {} }) {
  const info = inspectBridge({ home, profile });
  const bridgeDir = info.world.dir;
  const liveConfig = readJsonSafe(info.configFile);
  const backupFile = `${info.configFile}.dsh-arkhub.bak`;
  const backup = readJsonSafe(backupFile);
  const facadePort = Number(info.port) || 3010;

  const liveWs = String(liveConfig?.snowluma?.wsUrl ?? '');
  const livePort = portOf(liveWs);
  const backupWs = String(backup?.snowluma?.wsUrl ?? '');
  const backupPort = portOf(backupWs);

  let current = 'unknown';
  if (livePort && livePort === facadePort) current = 'vm';
  else if (backupPort && livePort === backupPort) current = 'windows';
  else if (!livePort) current = info.bridgeEnabled ? 'vm' : 'windows';

  const lines = [
    {
      id: 'vm',
      title: '门面（VM 里的号）',
      via: 'ArkHub 门面',
      upstream: `ws://127.0.0.1:${facadePort}`,
      http: `http://127.0.0.1:${facadePort}`,
      port: facadePort,
      account: String(config?.qq?.accountUin || ''),
      nickname: String(config?.qq?.nickname || ''),
      note: '收信走 VM 里的 SnowLuma，语音、引用、图片都在协议层；发文字失败才退回 ArkLink',
      probe: 'facade',
      available: true,
    },
    {
      id: 'windows',
      title: '原桥（本机 SnowLuma）',
      via: 'SnowLuma 直连',
      upstream: backupWs,
      http: String(backup?.snowluma?.httpUrl ?? ''),
      token: String(backup?.snowluma?.accessToken ?? ''),
      port: backupPort,
      account: '',
      nickname: '',
      note: backup
        ? '换桥之前的样子：本机 SnowLuma 一个号，不经过 ArkHub'
        : '没有换桥前的备份（从没跑过 bridge use），退不回这条线',
      probe: 'snowluma',
      available: Boolean(backupWs && backupPort),
    },
  ];

  return {
    current,
    bridgeDir,
    bridgeEnabled: info.bridgeEnabled,
    channelEnabled: info.channelEnabled,
    bridgeConfig: info.configFile,
    facadePort,
    liveUpstream: liveWs,
    canRollback: existsSync(backupFile),
    lines,
  };
}

/** 探一条线活没活、上面是哪个号。失败不算异常：没开就是没开。 */
async function probeLine(line, fetchImpl = fetch) {
  if (!line.available || !line.http) return { ...line, alive: false, error: line.available ? '' : '没有地址' };
  const headers = line.token ? { authorization: `Bearer ${line.token}` } : {};
  const url = line.probe === 'facade' ? `${line.http}/api/status` : `${line.http}/get_login_info`;
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ...line, alive: false, error: `HTTP ${response.status}` };
    const body = await response.json().catch(() => ({}));
    if (line.probe === 'facade') {
      const data = body?.data ?? {};
      const account = String(data.account || line.account || '');
      return {
        ...line,
        alive: true,
        account,
        nickname: String(data.nickname || line.nickname || ''),
        detail: account ? `已收 ${Number(data.events) || 0} 条 · ${Number(data.clients) || 0} 个客户端` : '门面在，但账号没上来',
      };
    }
    const data = body?.data ?? {};
    const account = String(data.user_id || '');
    return {
      ...line,
      alive: Boolean(account),
      account,
      nickname: String(data.nickname || ''),
      error: account ? '' : 'SnowLuma 在，但号没登录',
    };
  } catch (error) {
    return { ...line, alive: false, error: String(error?.message || error) };
  }
}

/** 显示的标题：有昵称就用「昵称 · 号」，没有就退回「QQ 号」，都没有就用线自己的名字。 */
function labelOf(line) {
  if (line.nickname && line.account) return `${line.nickname} · ${line.account}`;
  if (line.account) return `QQ ${line.account}`;
  return line.title;
}

/**
 * 世界控制台那张卡要的东西：两条线、各自活没活、现在是哪条。
 * 两个探活并行，任何一个挂掉都只影响它自己那一行。
 */
export async function describeLines({ home, profile = '', config = {}, fetchImpl = fetch }) {
  const base = describeLocalLines({ home, profile, config });
  const probed = await Promise.all(base.lines.map(line => probeLine(line, fetchImpl)));
  const lines = probed.map(line => {
    // 令牌留在服务端：界面只需要知道「有没有配」，不需要能拿它去连 SnowLuma
    const { token, ...rest } = line;
    return { ...rest, hasToken: Boolean(token), label: labelOf(line), current: line.id === base.current };
  });
  return { ...base, lines };
}

/** 换线：改桥的上游（+ 视情况钉装配行开关）+ 重启桥。真正干活的是 switch.js。 */
export async function switchLine({ home, profile = '', target, logger = console }) {
  if (!LINE_IDS.includes(target)) {
    throw new Error(`不认识的线：${target}（只认 ${LINE_IDS.join(' / ')}）`);
  }
  const { bridgeSwitchAndRestart } = await import('./switch.js');
  // 双线常驻：门面一直挂着，选线只是把桥的上游接到哪条；不再需要「原桥线插件待命」
  return bridgeSwitchAndRestart({ home, profile, use: target === 'vm', logger });
}
