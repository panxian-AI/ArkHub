/**
 * OneBot 门面：让 qq-bridge 以为自己在跟 SnowLuma 说话，实际后面是 ArkLink。
 *
 * 为什么走这条路而不是自己再写一条通道：qq-bridge 已经把这些事做完了 ——
 * 按 `private:<QQ>` / `group:<群号>` 记住每个入口用哪个会话（`state/sessions.json`）、
 * 把消息投进她家里那间、给出主动聊天的统计、挂 qq_send 之类的工具。
 * 世界控制台左下角那张 QQ 卡读的也是它的 `/api/status`。
 * 所以这里只替换「上游」：ArkLink 出来的是 HTTP 消息流，翻译成 OneBot 事件推给桥；
 * 桥发出去的 `send_group_msg` 翻译成 ArkLink 的 `/api/v1/send`。
 *
 * 一个端口同时干两件事：HTTP 动作（OneBot 的 action）、WebSocket 事件推送。
 * 不引第三方依赖 —— 握手和帧格式都在下面这几十行里。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { heartbeat, sendRequest, sendResponse, toEvent } from './onebot.js';
import { detectArklinkReceive } from './detect.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 服务器 → 客户端的文本帧（不掩码，长度分三档）。 */
function encodeFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, data]);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const ok = data => ({ status: 'ok', retcode: 0, data });
const fail = (reason, retcode = 100) => ({ status: 'failed', retcode, data: null, wording: reason });

/** ArkLink 只会打字：除了这三段，别的一律算「富消息」，要 SnowLuma 才发得出去。 */
const PLAIN_SEGMENTS = new Set(['text', 'at', 'face']);

export function richSegments(params = {}) {
  const message = params?.message;
  if (!Array.isArray(message)) return [];
  const kinds = new Set();
  for (const segment of message) {
    const type = String(segment?.type ?? '');
    if (type && !PLAIN_SEGMENTS.has(type)) kinds.add(type);
  }
  return [...kinds];
}

export function createFacade({ config, link, snowluma = null, log = () => {} }) {
  const port = Number(config.bridge?.port) || 3010;
  const token = String(config.bridge?.token || '');
  const pollMs = Math.max(Number(config.arklink?.pollMs) || 2000, 500);
  const beatMs = Math.max(Number(config.bridge?.heartbeatMs) || 30000, 5000);

  const clients = new Set();
  let server = null;
  let timer = null;
  let beatTimer = null;
  let running = false;
  let stopped = false;
  let selfId = String(config.qq?.accountUin || '');
  let nickname = String(config.qq?.nickname || '');
  let unsubscribe = null;
  let sendSeq = 0;
  const recentSends = [];
  const stats = { actions: 0, sent: 0, events: 0, failed: 0, lastError: '', lastEventAt: '', sentVia: '' };

  function authorized(req, url) {
    if (!token) return true;
    const header = String(req.headers.authorization || '');
    const bearer = header.replace(/^Bearer\s+/i, '').trim();
    if (bearer && bearer === token) return true;
    const fromQuery = String(url.searchParams.get('access_token') || '').trim();
    return Boolean(fromQuery) && fromQuery === token;
  }

  function broadcast(event) {
    if (!clients.size) return;
    const frame = encodeFrame(JSON.stringify(event));
    for (const socket of clients) {
      if (socket.destroyed) {
        clients.delete(socket);
        continue;
      }
      try {
        socket.write(frame);
      } catch {
        clients.delete(socket);
      }
    }
  }

  /**
   * 发送台账：发出方（人、AI 工具）不该对着一个黑盒猜「发没发、发给谁、排第几」。
   * 每次发送发一个流水号，收件人、走的哪条路、协议端受理用了多少毫秒、开了头几
   * 个字，都记下来；快照里带出去（/dsh-arkhub/status 和门面 GET / 都能看到），
   * OneBot 回执里也带一份（arkhub 段，桥和工具愿意读就读）。
   */
  function noteSend({ seq, target, isGroup, via, ok, waitMs, text, error = '' }) {
    const entry = {
      seq,
      at: new Date().toISOString(),
      to: isGroup ? `群 ${target}` : `私聊 ${target}`,
      via,
      ok,
      waitMs,
      text: String(text || '').slice(0, 40),
      error,
    };
    recentSends.unshift(entry);
    if (recentSends.length > 30) recentSends.length = 30;
    log(ok
      ? `发送 #${seq} → ${entry.to}（via ${via}，受理 ${waitMs}ms）：${entry.text}`
      : `发送 #${seq} → ${entry.to} 失败（via ${via}，${waitMs}ms）：${error}`);
    return entry;
  }

  /** OneBot 的动作表。认不出的动作回 1404，让桥自己降级，而不是整个挂掉。 */
  async function handleAction(action, params) {
    stats.actions += 1;
    switch (action) {
      case 'get_login_info':
        if (snowluma?.connected) {
          try {
            const data = await snowluma.callAction(action, params);
            if (data?.user_id) selfId = String(data.user_id);
            return ok({ user_id: Number(selfId) || 0, nickname: String(data?.nickname || config.qq?.nickname || '') });
          } catch {
            /* 退回本地答案，后面还有一份 */
          }
        }
        return ok({ user_id: Number(selfId) || 0, nickname });
      case 'get_status':
        return ok({ online: snowluma ? snowluma.connected : true, good: snowluma ? snowluma.connected : true });
      case 'get_version_info':
        return ok({ app_name: 'arkhub-onebot', app_version: '0.3.0', protocol_version: 'v11' });
      case 'get_group_list':
        if (snowluma?.connected) {
          try {
            return ok(await snowluma.callAction(action, params));
          } catch {
            /* 用白名单兜底 */
          }
        }
        return ok((config.qq?.allowGroups || []).map(id => ({ group_id: Number(id) || 0, group_name: '' })));
      case 'get_friend_list':
        if (snowluma?.connected) {
          try {
            return ok(await snowluma.callAction(action, params));
          } catch {
            /* 用白名单兜底 */
          }
        }
        return ok((config.qq?.allowPrivate || []).map(id => ({ user_id: Number(id) || 0, nickname: '' })));
      case 'send_msg':
      case 'send_private_msg':
      case 'send_group_msg': {
        const parsed = sendRequest(action, params);
        if (!parsed.ok) {
          stats.failed += 1;
          stats.lastError = parsed.reason;
          return fail(parsed.reason);
        }
        const isGroup = action === 'send_group_msg' || (action !== 'send_private_msg' && params.group_id !== undefined);
        const target = String(isGroup ? params.group_id : params.user_id);
        const seq = ++sendSeq;
        const startedAt = Date.now();
        // 先走 SnowLuma：它说的是同一门语言（OneBot → OneBot），语音、引用、图片
        // 这些段原样进去就行。ArkLink 的 x11 引擎只会「打一段字」，做不到这些。
        if (snowluma?.connected) {
          try {
            const data = await snowluma.callAction(action, params);
            const waitMs = Date.now() - startedAt;
            stats.sent += 1;
            stats.sentVia = 'snowluma';
            stats.lastError = '';
            const receipt = noteSend({ seq, target, isGroup, via: 'snowluma', ok: true, waitMs, text: parsed.body.text });
            return ok({ ...(data ?? {}), arkhub: receipt });
          } catch (error) {
            const waitMs = Date.now() - startedAt;
            stats.lastError = String(error?.message || error);
            noteSend({ seq, target, isGroup, via: 'snowluma', ok: false, waitMs, text: parsed.body.text, error: stats.lastError });
            log(`SnowLuma 发送失败，退回 ArkLink：${stats.lastError}`);
          }
        }
        const rich = richSegments(params);
        if (rich.length) log(`ArkLink 发不了 ${rich.join('/')}（要先让 SnowLuma 在线），这条只发文字`);
        const arklinkAt = Date.now();
        try {
          const result = await link.send(parsed.body);
          const waitMs = Date.now() - arklinkAt;
          stats.sent += 1;
          stats.sentVia = 'arklink';
          const receipt = noteSend({ seq, target, isGroup, via: 'arklink', ok: true, waitMs, text: parsed.body.text });
          const response = sendResponse(result, action);
          if (response.status === 'ok' && response.data) response.data.arkhub = receipt;
          return response;
        } catch (error) {
          const waitMs = Date.now() - arklinkAt;
          stats.failed += 1;
          stats.lastError = String(error?.message || error);
          noteSend({ seq, target, isGroup, via: 'arklink', ok: false, waitMs, text: parsed.body.text, error: stats.lastError });
          return fail(stats.lastError);
        }
      }
      default:
        return fail(`未实现的动作：${action || '(空)'}`, 1404);
    }
  }

  function attachWebSocket(req, socket) {
    const key = String(req.headers['sec-websocket-key'] || '');
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    clients.add(socket);
    log(`OneBot 客户端连上（现在 ${clients.size} 个）`);
    // 连上先给一次心跳和账号信息，桥不用等下一个周期
    socket.write(encodeFrame(JSON.stringify(heartbeat(selfId))));

    socket.on('data', chunk => {
      // 只处理控制帧：ping → pong，close → 断开。数据帧桥不会发。
      let offset = 0;
      while (offset + 2 <= chunk.length) {
        const opcode = chunk[offset] & 0x0f;
        const masked = (chunk[offset + 1] & 0x80) !== 0;
        let len = chunk[offset + 1] & 0x7f;
        let cursor = offset + 2;
        if (len === 126) {
          len = chunk.readUInt16BE(cursor);
          cursor += 2;
        } else if (len === 127) {
          len = Number(chunk.readBigUInt64BE(cursor));
          cursor += 8;
        }
        if (masked) cursor += 4;
        const end = cursor + len;
        if (end > chunk.length) break; // 半帧，等下一段
        if (opcode === 0x8) {
          socket.end();
          clients.delete(socket);
          return;
        }
        if (opcode === 0x9) {
          const pong = Buffer.alloc(2);
          pong[0] = 0x8a;
          pong[1] = 0;
          socket.write(pong);
        }
        offset = end;
      }
    });
    const drop = () => clients.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
  }

  /** 同一条消息可能从两条上游都来（SnowLuma 直连 + ArkBot 兜底），按 id 只放一次。 */
  const delivered = new Map();
  function firstTime(event) {
    const id = event?.message_id;
    if (!id) return true;
    const key = `${event.message_type}:${event.group_id || event.user_id}:${id}`;
    const now = Date.now();
    const seen = delivered.get(key);
    if (seen && now - seen < 5 * 60 * 1000) return false;
    delivered.set(key, now);
    if (delivered.size > 400) {
      for (const [oldKey, at] of delivered) {
        if (now - at > 5 * 60 * 1000) delivered.delete(oldKey);
      }
    }
    return true;
  }

  function deliver(event, via) {
    if (stopped || !event || !firstTime(event)) return false;
    if (event.self_id) selfId = String(event.self_id);
    stats.events += 1;
    stats.lastEventAt = new Date().toISOString();
    stats.eventVia = via;
    broadcast(event);
    return true;
  }

  /** ArkBot 兜底：它自己连协议端，收到消息后 POST 进来（见 tools/arkbot-arkhub/）。 */
  function ingest(event) {
    if (!event || event.post_type !== 'message') return false;
    return deliver(event, 'arkbot');
  }

  async function tick() {
    if (stopped) return;
    try {
      const items = await link.messages(link.since);
      for (const item of items) {
        const seq = Number(item.seq) || 0;
        if (seq > link.since) link.since = seq;
        const event = toEvent(item, selfId);
        if (!event) continue;
        deliver(event, 'arklink');
      }
      stats.lastError = '';
    } catch (error) {
      stats.lastError = String(error?.message || error);
    }
  }

  async function start() {
    if (running || stopped) return;
    const status = await link.status();
    selfId = String(status.uin || selfId || '');
    await link.primeCursor();

    // 收信交给 SnowLuma：它把 QQ 的收包在协议层解出来，一条不漏。
    // ArkLink 那边收不到（hook 注入在 Linux 上撞墙），但它发文字仍然好用 —— 两条并存。
    if (snowluma?.enabled) {
      unsubscribe = snowluma.onEvent(event => {
        if (event.self_id) selfId = String(event.self_id);
        deliver(event, 'snowluma');
      });
      snowluma.start();
      const snap = snowluma.snapshot();
      if (snap.selfId) selfId = snap.selfId;
      // 昵称只为了界面上认得出来是谁（世界控制台那张卡要写「小暖 · 100010002」）。
      // 拿不到就算了，不挡任何事。
      void snowluma.callAction('get_login_info')
        .then(info => {
          const data = info?.data ?? info;
          if (data?.user_id) selfId = String(data.user_id);
          if (data?.nickname) nickname = String(data.nickname);
        })
        .catch(() => {});
      log(`收信走 SnowLuma（${snap.wsUrl}）：语音、引用、图片也走这条；ArkLink 留作发文字的老路`);
    }

    // 收信全靠 ArkLink 的 hook 管道。管道不在时，门面「发得出去、一条也收不到」，
    // 而面板上看不出任何异常 —— 这种故障必须提前喊一声，别等人半夜发现她不回话。
    const recv = await detectArklinkReceive(config.arklink?.baseUrl || '');
    if (recv.known && recv.pipeOk === false && !snowluma?.connected) {
      log('注意：ArkLink 的 hook 管道不存在，SnowLuma 也没连上 —— 现在一条消息都收不到。排查见 INSTALL.md「收不到消息」一节');
    }

    server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const send = body => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      if (!authorized(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(fail('未授权：token 不对', 1401)));
        return;
      }
      if (req.method === 'GET') {
        // OneBot 实现常提供一个 GET 首页；桥不用，但人会用浏览器点进来看看是不是活的
        send(ok({ app: 'arkhub-onebot', account: selfId, nickname, clients: clients.size, ...stats, sends: recentSends }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(fail('只收 POST', 1405)));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const action = url.pathname.replace(/^\/+/, '');
        send(await handleAction(action, body));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(fail(String(error?.message || error))));
      }
    });

    server.on('upgrade', (req, socket) => attachWebSocket(req, socket));

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    running = true;
    timer = setInterval(() => void tick(), pollMs);
    beatTimer = setInterval(() => broadcast(heartbeat(selfId)), beatMs);
    void tick();
    log(`OneBot 门面已开：127.0.0.1:${port}（OneBot 的 httpUrl / wsUrl 都指向这里），账号 ${selfId || '未知'}`);
  }

  function stop() {
    stopped = true;
    running = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (timer) clearInterval(timer);
    if (beatTimer) clearInterval(beatTimer);
    timer = null;
    beatTimer = null;
    for (const socket of clients) {
      try {
        socket.destroy();
      } catch {
        /* 已经断了 */
      }
    }
    clients.clear();
    if (server) {
      try {
        server.close();
      } catch {
        /* 已经关了 */
      }
      server = null;
    }
  }

  function snapshot() {
    return {
      running: running && !stopped,
      port,
      account: selfId,
      nickname,
      clients: clients.size,
      cursor: link.since,
      ...stats,
      sends: recentSends.slice(0, 10),
      snowluma: snowluma?.snapshot?.() ?? null,
    };
  }

  return { start, stop, snapshot, tick, ingest };
}
