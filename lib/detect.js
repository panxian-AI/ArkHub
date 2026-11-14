/**
 * 装之前先把「该填什么」问出来，别让人手填 QQ 号。
 *
 * 两个来源：
 *   ArkLink   账号 uin、允许的会话、以及它是不是在演练模式
 *   DSH world 那条鱼住哪儿（worlds/<id>/life.json 的 homeSessionId）
 *
 * 这一层只读不写，探测失败也只是少填几个值，不影响安装。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ARKLINK = 'http://127.0.0.1:6900';

/** 控制台（带 /api/doctor）通常是 API 端口 -100，6900 → 6800。 */
export function webuiOf(baseUrl) {
  const m = /^http:\/\/([^/:]+):(\d+)/.exec(String(baseUrl || ''));
  if (!m) return '';
  return `http://${m[1]}:${Math.max(Number(m[2]) - 100, 1)}`;
}

/**
 * 收信能力：ArkLink 靠 hook 注入 QQ 进程，用管道把消息送进总线。
 *
 * 这一步失败的表现最隐蔽 —— 发送一切正常，就是收不到任何消息（bus.total 永远是 0）。
 * 它的 /api/doctor 会直接告诉你「hook 模块」「hook 管道」两项的状态，不用登录控制台。
 */
export async function detectArklinkReceive(baseUrl, { timeoutMs = 2500 } = {}) {
  const url = `${webuiOf(baseUrl)}/api/doctor`;
  const out = { known: false, pipeOk: null, pipeDetail: '', moduleOk: null, moduleDetail: '', url };
  if (!webuiOf(baseUrl)) return out;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return out;
    const data = await res.json();
    const checks = Array.isArray(data?.checks) ? data.checks : [];
    const pipe = checks.find(c => String(c.name || '').includes('hook 管道'));
    const mod = checks.find(c => String(c.name || '').includes('hook 模块'));
    if (pipe) {
      out.pipeOk = String(pipe.status || '') === 'OK';  // 注意：WARN 也带 ok:true，只能看 status
      out.pipeDetail = String(pipe.detail || '');
      out.pipeHint = String(pipe.hint || '');
      out.known = true;
    }
    if (mod) {
      out.moduleOk = String(mod.status || "") === "OK";
      out.moduleDetail = String(mod.detail || '');
    }
    return out;
  } catch {
    return out;
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** ArkLink 的凭据一般落在 ~/.arklink/api.json（base_url + token）。 */
export function readArklinkCredentials() {
  const file = join(homedir(), '.arklink', 'api.json');
  const data = readJsonSafe(file);
  return {
    file,
    baseUrl: String(data?.base_url || data?.baseUrl || DEFAULT_ARKLINK).replace(/\/+$/, ''),
    token: String(data?.token || data?.api_token || ''),
  };
}

/**
 * 探一下 ArkLink：能不能连、账号是谁、允许跟谁说话、是不是在演练。
 *
 * `dryRun` 三态：true/false 来自它上一次发送的真实记录，null 表示还没发过、看不出来。
 * 这个值很重要 —— 演练模式下一切「正常」但消息根本不会出网。
 */
export async function detectArklink({ timeoutMs = 4000 } = {}) {
  const cred = readArklinkCredentials();
  const out = {
    baseUrl: cred.baseUrl,
    tokenFile: cred.file,
    hasToken: Boolean(cred.token),
    ok: false,
    uin: '',
    nickname: '',
    allowPrivate: [],
    allowGroups: [],
    allowGroup: false,
    dryRun: null,
    engine: '',
    receive: null,
    error: '',
  };
  if (!cred.token) {
    out.error = `没有找到 token：${cred.file}`;
    return out;
  }
  try {
    const res = await fetch(`${cred.baseUrl}/api/v1/status`, {
      headers: { Authorization: `Bearer ${cred.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!res.ok) {
      out.error = `${cred.baseUrl} 返回 ${res.status}：${data?.error || data?.msg || '请求失败'}`;
      return out;
    }
    const limits = data.limits || {};
    const last = data.sends?.last;
    out.ok = data.ok !== false && data.available !== false;
    out.uin = String(data.uin || data.self_id || limits.allowed_uins?.[0] || '');
    out.nickname = String(data.nickname || data.name || '');
    out.allowPrivate = (limits.allowed_peers || []).map(String);
    out.allowGroups = (limits.allowed_groups || []).map(String);
    out.allowGroup = Boolean(limits.allow_group);
    out.engine = String(data.engine || '');
    // 当前是否演练：看现在生效的引擎，而不是「上一次发送」那张历史快照。
    // 换成真引擎之后旧记录还写着 dry-run，按旧记录判断会一直误报。
    if (out.engine) out.dryRun = out.engine === 'dry-run';
    else if (last) out.dryRun = last.dry_run === true || String(last.engine || '') === 'dry-run';
    out.receive = await detectArklinkReceive(cred.baseUrl);
    return out;
  } catch (error) {
    out.error = `连不上 ${cred.baseUrl}：${error?.cause?.code || error?.message || error}`;
    return out;
  }
}

/**
 * 找那条鱼：worlds/<worldId>/life.json 里的 homeSessionId。
 *
 * 优先 worldId=default（dsh-world 的默认世界），否则挑第一个真的绑过会话的。
 */
export function detectWorld(home = join(homedir(), '.dsh')) {
  const root = join(home, 'worlds');
  const out = { worldId: 'default', homeSessionId: '', companionName: '', path: '' };
  if (!existsSync(root)) return out;
  const candidates = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name, 'life.json');
    if (!existsSync(file)) continue;
    const life = readJsonSafe(file);
    if (!life) continue;
    candidates.push({
      worldId: name,
      homeSessionId: String(life.homeSessionId || ''),
      companionName: String(life.companionName || ''),
      path: file,
    });
  }
  const preferred = candidates.find(one => one.worldId === 'default' && one.homeSessionId);
  const firstBound = candidates.find(one => one.homeSessionId);
  const chosen = preferred || firstBound || candidates.find(one => one.worldId === 'default') || candidates[0];
  return chosen ? { ...chosen } : out;
}
