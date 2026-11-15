/**
 * 有新版本说一句，没网就闭嘴，随时能关。
 *
 * 三个开关，任意一个都能关掉它：
 *   1. 配置里 `update.check: false`
 *   2. 环境变量 `DSH_ARKHUB_NO_UPDATE_CHECK=1`
 *   3. 在 DSH 里对她说「ArkHub 别再提醒更新」→ 面板/路由把 muted 写进状态文件
 *
 * 一天最多查一次；失败记六小时。启动路径上绝不 await 网络。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.7.0';
const OK_TTL = 24 * 3600;
const FAIL_TTL = 6 * 3600;
const TIMEOUT_MS = 3500;

function stateDir() {
  return join(homedir(), '.dsh', 'arkhub');
}

function stateFile() {
  return join(stateDir(), 'update.json');
}

export function parseVersion(text) {
  const nums = String(text ?? '').match(/\d+/g) ?? [];
  return nums.slice(0, 4).map(Number);
}

export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 读取/写入更新状态（供路由和面板用）。 */
export function readUpdateState() {
  try {
    if (!existsSync(stateFile())) return {};
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeUpdateState(patch) {
  const data = { ...readUpdateState(), ...patch };
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${stateFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    renameSync(tmp, stateFile());
  } catch {
    /* 写不进去不影响聊天，别让更新提示把插件搞挂 */
  }
  return data;
}

export function muteUpdates(muted = true) {
  writeUpdateState({ muted: Boolean(muted), mutedAt: muted ? Math.floor(Date.now() / 1000) : 0 });
}

function disabledByEnv() {
  const raw = String(process.env.DSH_ARKHUB_NO_UPDATE_CHECK ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

async function fetchLatest(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-arkhub-update' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const data = await res.json();
  return { tag: String(data.tag_name || ''), url: String(data.html_url || '') };
}

/**
 * 返回一个快照。`fetch: false` 时只读缓存，绝不联网（状态接口每几秒被调一次）。
 */
export async function checkUpdate(config, { fetch: allowFetch = true, force = false } = {}) {
  const repo = String(config?.update?.repo || 'panxian-AI/ArkHub');
  const homepage = `https://github.com/${repo}`;
  const state = readUpdateState();

  if (!config?.update?.check || disabledByEnv()) {
    return { ok: true, disabled: true, reason: '配置或环境变量关掉了更新检查', current: VERSION, hasUpdate: false, homepage };
  }
  if (state.muted) {
    return { ok: true, disabled: true, reason: '已经点了「别再提醒」', current: VERSION, hasUpdate: false, homepage };
  }

  const now = Math.floor(Date.now() / 1000);
  const last = Number(state.checkedAt || 0);
  const fresh = now - last < (state.ok === false ? FAIL_TTL : OK_TTL);
  const cached = { ...state, current: VERSION, homepage, disabled: false, cached: true };
  if (fresh && !force) {
    return { ...cached, hasUpdate: Boolean(cached.latest) && isNewer(cached.latest, VERSION) };
  }
  if (!allowFetch) {
    return { ok: false, pending: true, current: VERSION, hasUpdate: false, homepage, error: '还没查过' };
  }

  let latest = '';
  let url = homepage;
  let ok = false;
  try {
    const got = await fetchLatest(repo);
    latest = got.tag;
    url = got.url || homepage;
    ok = Boolean(latest);
  } catch (error) {
    writeUpdateState({ ok: false, checkedAt: now, error: String(error?.message || error) });
    return { ok: false, current: VERSION, hasUpdate: false, homepage, error: String(error?.message || error) };
  }

  const snapshot = {
    ok,
    checkedAt: now,
    current: VERSION,
    latest,
    hasUpdate: Boolean(latest) && isNewer(latest, VERSION),
    url,
    homepage,
    updateCommand: `dsh plugin update dsh-arkhub`,
    disabled: false,
    cached: false,
  };
  writeUpdateState(snapshot);
  return snapshot;
}
