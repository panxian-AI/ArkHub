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
    this.lastSeq = 0;
    this.started = false;
  }

  get label() {
    return `${this.mode} ${this.baseUrl}`;
  }

  /**
   * 凭据按需取，不只在构造函数里取一次。
   * DSH 常驻运行，token 往往是在插件装配之后才写进磁盘的（第一登录/换 token），
   * 构造时空缓存会让通道一直 401，直到重启 DSH —— 这里每次要用时再看一眼文件。
   */
  credential() {
    if (this.mode === 'arkhub') return this.token;
    if (this.token) return this.token;
    if (!this.tokenFile) return '';
    const fresh = readTokenFile(this.tokenFile);
    if (fresh) {
      this.token = fresh;
      this.log(`已从 ${this.tokenFile} 读到 ArkLink 凭据`);
    }
    return this.token;
  }

  /** token 换了（比如 ArkLink 重装）：丢掉旧值，下次请求重读文件。 */
  forgetCredential() {
    if (this.mode === 'arkhub') return;
    this.token = '';
  }

  headers() {
    const headers = { Accept: 'application/json', 'User-Agent': 'dsh-arkhub/0.1' };
    const token = this.credential();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async request(path, { method = 'GET', body, retried = false } = {}) {
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
    if (!res.ok) {
      // 401 一般两种原因：token 过期，或 ArkLink 重启后换了新 token 而我们还拿着旧的。
      // 重读一次磁盘凭据，确实变了就重试一次（只一次，避免死循环）。
      if (res.status === 401 && !retried) {
        const previous = this.token;
        this.forgetCredential();
        const fresh = this.credential();
        if (fresh && fresh !== previous) {
          this.log('ArkLink 凭据已更新，重试一次');
          return this.request(path, { method, body, retried: true });
        }
        this.token = previous;
      }
      throw new LinkError(`${url} 返回 ${res.status}：${data?.error || data?.msg || '请求失败'}`, res.status);
    }
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
    const data = await this.request(`/api/v1/messages?since=${Number(since) || 0}&limit=${limit}`);
    // 响应里自带 last_seq（总线末尾），比 items 里的 seq 更准：空页也能知道「现在到哪了」
    const tail = Number(data.last_seq) || 0;
    if (tail > this.lastSeq) this.lastSeq = tail;
    if (this.mode === 'arkhub') return (data.items || []).map(toArkLinkShape).filter(Boolean);
    return Array.isArray(data.items) ? data.items : [];
  }

  /**
   * 第一次只对齐游标，不重放历史。
   *
   * 插件重启时会拿到 ArkLink 里积压的消息；把三天前的话又回一遍是灾难，
   * 所以这里先跳到「最新」，之后才从新消息开始接。
   *
   * 认 `last_seq` 而不是 items 里的 seq：语义上是同一个游标空间，
   * 且空页/满页都对，不必假设返回是升序还是降序。
   */
  async primeCursor() {
    try {
      await this.messages(0, 1); // 只为读出 last_seq；这一页的 items 一律丢弃
      if (this.lastSeq > 0) this.since = this.lastSeq;
      this.started = true;
      this.lastError = '';
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
