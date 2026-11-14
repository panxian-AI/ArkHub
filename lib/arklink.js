/**
 * 从 QQ 拿消息、往 QQ 发消息。
 *
 * 两个后端，形状一样：
 *   - `arklink`：直连 ArkLink（http://127.0.0.1:6900），不需要任何 Python 服务
 *   - `arkhub`：走 ArkHub 的开放面（http://127.0.0.1:7090），多一层面板和事件总线
 *
 * 只在需要的时候才连，连不上就说清楚为什么 —— 插件启动不该被 QQ 拖住。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 群聊 / 私聊的判据：ArkLink 用 chat_type=2 表示群，和 OneBot 的 message_type 对齐。 */
export const CHAT_PRIVATE = 1;
export const CHAT_GROUP = 2;

function expandHome(path) {
  const text = String(path ?? '');
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
  return text;
}

/** ArkLink 的 token 存在 `~/.arklink/api.json`（也可以直接在配置里写）。 */
export function readTokenFile(path) {
  const file = expandHome(path);
  if (!file) return '';
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return String(data.token || data.api_token || data.apiToken || '');
  } catch {
    return '';
  }
}

export class LinkError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LinkError';
    this.status = status;
  }
}

export class QqLink {
  constructor(config, log = () => {}) {
    this.mode = config.transport;
    this.baseUrl = String((config.transport === 'arkhub' ? config.arkhub?.baseUrl : config.arklink?.baseUrl) || '').replace(/\/+$/, '');
    this.token = config.transport === 'arkhub'
      ? String(config.arkhub?.apiKey || '')
      : String(config.arklink?.token || '') || readTokenFile(config.arklink?.tokenFile);
    this.tokenFile = config.transport === 'arkhub' ? '' : expandHome(config.arklink?.tokenFile);
    this.timeoutMs = Number(config.arklink?.timeoutMs) || 8000;
    this.log = log;
    this.lastError = '';
    this.since = 0;
    this.started = false;
  }

  get label() {
    return `${this.mode} ${this.baseUrl}`;
  }

  headers() {
    const headers = { Accept: 'application/json', 'User-Agent': 'dsh-arkhub/0.1' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(path, { method = 'GET', body } = {}) {
    const url = this.baseUrl + path;
    const init = { method, headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (error) {
      const reason = error?.cause?.code || error?.message || String(error);
      throw new LinkError(`连不上 ${url}：${reason}（ArkLink 起了吗？端口对吗？）`);
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* 有些端点返回空体 */
    }
    if (!res.ok) throw new LinkError(`${url} 返回 ${res.status}：${data?.error || data?.msg || '请求失败'}`, res.status);
    return data;
  }

  /** 账号 + 通道健康。 */
  async status() {
    try {
      if (this.mode === 'arkhub') {
        const data = await this.request('/api/v1/status');
        const qq = data.qq || {};
        return { ok: Boolean(qq.online ?? true), uin: String(qq.uin || ''), nickname: String(qq.nickname || ''), detail: data };
      }
      const data = await this.request('/api/v1/status');
      this.lastError = '';
      // ArkLink 的 status 没有顶层 uin：账号在 limits.allowed_uins 里（发送策略的那份）
      return {
        ok: data.ok !== false && data.available !== false,
        uin: String(data.uin || data.self_id || data.account || data.limits?.allowed_uins?.[0] || ''),
        nickname: String(data.nickname || data.name || ''),
        detail: data,
      };
    } catch (error) {
      this.lastError = error.message;
      return { ok: false, uin: '', nickname: '', error: error.message };
    }
  }

  /** 拉一批新消息。`since` 是 ArkLink 的 seq 游标，天然支持断线续传。 */
  async messages(since = this.since, limit = 50) {
    if (this.mode === 'arkhub') {
      const data = await this.request(`/api/v1/messages?since=${Number(since) || 0}&limit=${limit}`);
      return (data.items || []).map(toArkLinkShape).filter(Boolean);
    }
    const data = await this.request(`/api/v1/messages?since=${Number(since) || 0}&limit=${limit}`);
    return Array.isArray(data.items) ? data.items : [];
  }

  /**
   * 第一次只对齐游标，不重放历史。
   *
   * 插件重启时会拿到 ArkLink 里积压的消息；把三天前的话又回一遍是灾难，
   * 所以这里先取最新一条的 seq 当起点。
   */
  async primeCursor() {
    try {
      const items = await this.messages(0, 1);
      const last = items[items.length - 1];
      if (last && Number(last.seq) > 0) this.since = Number(last.seq);
      this.started = true;
      return this.since;
    } catch (error) {
      this.lastError = error.message;
      return this.since;
    }
  }

  async send({ to, text, group = false, uin = '' }) {
    if (!String(text ?? '').trim()) throw new LinkError('空消息不发送');
    if (this.mode === 'arkhub') {
      const data = await this.request('/api/v1/send', {
        method: 'POST',
        body: { to: String(to), text, group: Boolean(group), ...(uin ? { uin } : {}) },
      });
      if (data.ok === false) throw new LinkError(String(data.msg || data.error || '发送失败'));
      return data;
    }
    const data = await this.request('/api/v1/send', {
      method: 'POST',
      body: { to: String(to), text, ...(group ? { group: true } : {}), ...(uin ? { uin } : {}) },
    });
    if (data.ok === false) throw new LinkError(String(data.msg || data.error || '发送失败'));
    return data;
  }

  /** 群列表 / 好友列表：面板上用来给人挑白名单。 */
  async roster(kind) {
    try {
      const path = kind === 'group' ? '/api/v1/groups' : '/api/v1/friends';
      const data = await this.request(path);
      return Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  }
}

/** ArkHub 的事件（bus 事件）→ ArkLink 的消息形状，让上层只认一种。 */
function toArkLinkShape(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.chat_type !== undefined) return event;
  if (event.direction && event.direction !== 'in') return null;
  const conv = event.conversation || {};
  const sender = event.sender || {};
  const group = conv.type === 'group';
  return {
    seq: Number(event.seq) || 0,
    id: String(event.meta?.message_id || event.id || ''),
    ts: Number(event.ts) || Date.now() / 1000,
    chat_type: group ? CHAT_GROUP : CHAT_PRIVATE,
    peer_uid: String(conv.id || ''),
    peer_name: String(conv.name || ''),
    sender_uid: String(sender.id || conv.id || ''),
    sender_name: String(sender.name || ''),
    text: String(event.text || ''),
    source: String(event.channel || ''),
  };
}
