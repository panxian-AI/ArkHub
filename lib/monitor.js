/**
 * 夜间稳定性监控：只看、不动。
 *
 * 它回答两个问题：
 *   1. 今晚到底收到了什么（每条 QQ 消息按 seq 记下来）
 *   2. 这条链路有没有断过（ArkLink 的 uptime、每次探测的耗时、总线有没有丢包/重复）
 *
 * 为什么不用事件订阅：ArkLink 的 /api/v1/messages?since= 是拉取式的、带游标，
 * 读它不会消费掉总线上的数据（qq-bridge / 本插件照样能拿到），所以监控可以和它们并存。
 * 代价是要自己记游标 —— 存在 `~/.dsh/arkhub/monitor.json`，重启接着走，不重复记。
 *
 * 产物：`~/.dsh/arkhub/monitor/YYYY-MM-DD.jsonl`，一行一个事件，坏了半行也不影响前面。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function monitorDir(home = join(homedir(), '.dsh')) {
  return join(home, 'arkhub');
}

export function statePath(home) {
  return join(monitorDir(home), 'monitor.json');
}

/** 按**本地**日期分文件：晚上跑到凌晨属于同一晚，不该被 UTC 劈成两天。 */
export function localDay(date = new Date()) {
  const pad2 = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dayFile(home, date = new Date()) {
  return join(monitorDir(home), 'monitor', `${localDay(date)}.jsonl`);
}

export function readState(home) {
  try {
    return JSON.parse(readFileSync(statePath(home), 'utf8'));
  } catch {
    return { since: 0, startedAt: 0, samples: 0 };
  }
}

export function writeState(home, state) {
  mkdirSync(monitorDir(home), { recursive: true });
  writeFileSync(statePath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function appendLine(home, record) {
  const file = dayFile(home);
  mkdirSync(join(monitorDir(home), 'monitor'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

const nowIso = () => new Date().toISOString();

/**
 * 采一次。`link` 是 arklink.js 的 QqLink —— 复用它的 token 管理与 401 重试。
 */
export async function sampleOnce({ link, home, state, log = () => {} }) {
  const startedAt = Date.now();
  let status = null;
  let error = '';
  try {
    status = await link.status();
    if (status.ok === false) error = status.error || 'ArkLink 自报不可用';
  } catch (caught) {
    error = String(caught?.message || caught);
  }
  const latencyMs = Date.now() - startedAt;
  const detail = status?.detail || {};
  const bus = detail.bus || {};
  const queue = detail.queue || {};

  appendLine(home, {
    t: 'sample',
    at: nowIso(),
    ok: Boolean(status?.ok),
    latencyMs,
    ...(error ? { error } : {}),
    available: detail.available !== false,
    uptimeSec: Number(detail.uptime) || 0,
    bus: {
      total: Number(bus.total) || 0,
      last_seq: Number(bus.last_seq) || 0,
      dropped: Number(bus.dropped) || 0,
      duplicates: Number(bus.duplicates) || 0,
      buffered: Number(bus.buffered) || 0,
    },
    queue: { pending: Number(queue.pending) || 0, depth: Number(queue.depth) || 0 },
    sends: Number(detail.sends?.count) || 0,
  });

  // 收消息：只记新的，游标自己维护
  let received = 0;
  if (status?.ok) {
    try {
      const items = await link.messages(state.since, 50);
      for (const item of items) {
        const seq = Number(item.seq) || 0;
        if (seq > state.since) state.since = seq;
        received += 1;
        appendLine(home, {
          t: 'msg',
          at: nowIso(),
          seq,
          chat: Number(item.chat_type) === 2 ? 'group' : 'private',
          peer: String(item.peer_uid || ''),
          sender: String(item.sender_name || item.sender_uid || ''),
          text: String(item.text || '').slice(0, 300),
        });
      }
    } catch (caught) {
      error = error || String(caught?.message || caught);
    }
  }

  state.samples = (state.samples || 0) + 1;
  state.startedAt = state.startedAt || Date.now();
  state.lastAt = Date.now();
  state.lastOk = Boolean(status?.ok);
  writeState(home, state);

  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] `
    + `${status?.ok ? '在线' : '离线'}`
    + ` uptime=${Math.round((Number(detail.uptime) || 0) / 60)}m`
    + ` 延迟=${latencyMs}ms`
    + ` 新消息=${received}`
    + ` 总收包=${Number(bus.total) || 0}`
    + (error ? ` 错误=${error}` : '');
  log(line);
  return { ok: Boolean(status?.ok), received, latencyMs, error };
}

/** 从 jsonl 里算一份总结：这是给人看的那一页。 */
export function summarize(lines) {
  const samples = lines.filter(one => one.t === 'sample');
  const messages = lines.filter(one => one.t === 'msg');
  const outages = [];
  let lastOk = null;
  for (const one of samples) {
    if (lastOk === true && one.ok === false) outages.push({ down: one.at, up: null, reason: one.error || '' });
    if (lastOk === false && one.ok === true && outages.length) outages[outages.length - 1].up = one.at;
    lastOk = one.ok;
  }
  const byPeer = new Map();
  for (const one of messages) {
    const key = `${one.chat}:${one.peer}`;
    byPeer.set(key, (byPeer.get(key) || 0) + 1);
  }
  const latencies = samples.map(one => one.latencyMs).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const pct = p => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] : 0);
  const span = samples.length >= 2 ? (Date.parse(samples[samples.length - 1].at) - Date.parse(samples[0].at)) / 60000 : 0;
  return {
    from: samples[0]?.at || '',
    to: samples[samples.length - 1]?.at || '',
    samples: samples.length,
    okCount: samples.filter(one => one.ok).length,
    okRate: samples.length ? (samples.filter(one => one.ok).length / samples.length) * 100 : 0,
    spanMinutes: Math.round(span * 10) / 10,
    uptimeMinutes: Math.round((samples[samples.length - 1]?.uptimeSec || 0) / 60),
    latency: { p50: pct(50), p95: pct(95), max: latencies[latencies.length - 1] || 0 },
    bus: samples[samples.length - 1]?.bus || { total: 0, dropped: 0, duplicates: 0 },
    droppedDelta: (samples[samples.length - 1]?.bus?.dropped || 0) - (samples[0]?.bus?.dropped || 0),
    messages: messages.length,
    byPeer: [...byPeer.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    outages,
  };
}

export function readDay(home, day) {
  const file = join(monitorDir(home), 'monitor', `${day}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // 半行（进程被强杀时会有）直接跳过
      }
    })
    .filter(Boolean);
}

export function listDays(home) {
  const dir = join(monitorDir(home), 'monitor');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => name.replace('.jsonl', '')).sort();
}
