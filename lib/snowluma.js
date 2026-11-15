/**
 * SnowLuma 上游：真收信的那一半。
 *
 * 为什么要有它：ArkLink 在无头 Linux 上「发得出去、收不回来」——收信要靠 hook 注入
 * QQ 进程，那条路在 Electron 40 上撞墙（详见 ArkLink docs/无头Linux运行.md）。
 * SnowLuma 是同一套思路的另一份实现：注入器 + 进程内 hook + MsgPush 解析，
 * 只是它把注入放在运行期（不是 pre-main），所以能进得去。
 *
 * 它对外就是标准 OneBot 11：HTTP 动作 + WebSocket 事件推送。所以这里不需要
 * 理解 QQ 协议，只要两件事：
 *   1. 订阅 WS，把事件原样交给门面（qq-bridge 说的就是 OneBot，不用翻译）；
 *   2. 把桥发下来的动作转过去 —— 语音（record）、引用（reply）、图片这些
 *      ArkLink 的 x11 引擎做不到的段，在协议层是天然支持的。
 *
 * 断线自己重连，不抛错、不阻塞启动：SnowLuma 没起来的时候，插件照旧能发文字。
 */

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const SEEN_LIMIT = 512;

function joinToken(url, token) {
  const text = String(url || '').trim();
  if (!text) return '';
  if (!token) return text;
  const hasQuery = text.includes('?');
  return `${text}${hasQuery ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
}

const stripSlash = text => String(text || '').trim().replace(/\/+$/, '');

export class SnowLuma {
  constructor(config = {}, log = () => {}) {
    this.httpUrl = stripSlash(config.httpUrl);
    this.wsUrl = String(config.wsUrl || '').trim();
    this.httpToken = String(config.httpToken || config.token || '');
    this.wsToken = String(config.wsToken || config.token || '');
    this.timeoutMs = Math.max(Number(config.timeoutMs) || 8000, 1000);
    this.log = log;

    this.socket = null;
    this.started = false;
    this.stopped = false;
    this.connected = false;
    this.selfId = '';
    this.lastError = '';
    this.lastEventAt = '';
    this.received = 0;
    this.actions = 0;
    this.attempt = 0;
    this.timer = null;
    this.handlers = new Set();
    this.seen = [];
    this.seenSet = new Set();
    this.warnedDown = false;
  }

  get enabled() {
    return Boolean(this.wsUrl);
  }

  /** 门面 / runtime 挂事件回调；返回退订函数。 */
  onEvent(handler) {
    if (typeof handler !== 'function') return () => {};
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event) {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.log(`SnowLuma 事件处理出错：${error?.message || error}`);
      }
    }
  }

  /** 同一条消息只放过去一次（重连后 SnowLuma 可能重放最近的事件）。 */
  fresh(event) {
    const key = `${event.message_type || ''}:${event.group_id || event.user_id || ''}:${event.message_id ?? ''}`;
    if (!event.message_id) return true;
    if (this.seenSet.has(key)) return false;
    this.seenSet.add(key);
    this.seen.push(key);
    if (this.seen.length > SEEN_LIMIT) {
      const drop = this.seen.shift();
      this.seenSet.delete(drop);
    }
    return true;
  }

  attach() {
    if (this.stopped || !this.wsUrl) return;
    if (typeof WebSocket !== 'function') {
      this.lastError = '当前 Node 没有内置 WebSocket（需要 node >= 22）';
      this.log(this.lastError);
      return;
    }
    const url = joinToken(this.wsUrl, this.wsToken);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.lastError = String(error?.message || error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connected = true;
      this.attempt = 0;
      this.warnedDown = false;
      this.lastError = '';
      this.log(`SnowLuma 收信已连上：${this.wsUrl}`);
    });

    socket.addEventListener('message', raw => {
      let event;
      try {
        event = JSON.parse(typeof raw.data === 'string' ? raw.data : Buffer.from(raw.data).toString('utf8'));
      } catch {
        return;
      }
      if (!event || typeof event !== 'object') return;
      if (event.self_id) this.selfId = String(event.self_id);
      if (event.post_type === 'meta_event') return;
      if (event.post_type !== 'message' && event.post_type !== 'message_sent') return;
      if (!this.fresh(event)) return;
      this.received += 1;
      this.lastEventAt = new Date().toISOString();
      this.emit(event);
    });

    const down = reason => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.connected) this.log(`SnowLuma 收信断开（${reason}）`);
      this.connected = false;
      this.scheduleReconnect();
    };
    socket.addEventListener('close', () => down('closed'));
    socket.addEventListener('error', event => down(String(event?.message || 'error')));
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.timer) return;
    const wait = Math.min(RECONNECT_MIN_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    if (!this.warnedDown) {
      this.warnedDown = true;
      this.log(`SnowLuma 收信没连上（${this.wsUrl}）：文字照发，先按 ${Math.round(RECONNECT_MIN_MS / 1000)}s 起退避重试`);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.attach();
    }, wait);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.enabled) return;
    this.attach();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* 已经断了 */
      }
    }
  }

  /** OneBot 动作：语音、引用、图片这些 ArkLink 引擎做不到的东西都从这儿走。 */
  async callAction(action, params = {}) {
    if (!this.httpUrl) throw new Error('SnowLuma 的 httpUrl 没配');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {}),
        },
        body: JSON.stringify(params ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`SnowLuma 返回的不是 JSON：${text.slice(0, 120)}`);
      }
      if (body && body.status === 'failed') throw new Error(String(body.wording || body.error || '动作失败'));
      if (body && body.retcode !== undefined && Number(body.retcode) !== 0) {
        throw new Error(String(body.wording || body.error || `retcode=${body.retcode}`));
      }
      if (body && body.ok === false) throw new Error(String(body.error || '动作失败'));
      this.actions += 1;
      this.lastError = '';
      return body?.data !== undefined ? body.data : body;
    } finally {
      clearTimeout(timer);
    }
  }

  snapshot() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      selfId: this.selfId,
      wsUrl: this.wsUrl,
      httpUrl: this.httpUrl,
      received: this.received,
      actions: this.actions,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }
}
