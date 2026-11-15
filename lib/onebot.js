/**
 * OneBot 11 与 ArkLink 之间的翻译。
 *
 * 为什么要这一层：qq-bridge（dsh-world 管的那条桥）说的是 OneBot —— 它 POST
 * `send_group_msg`、从 WebSocket 收 `post_type: 'message'`。它已经学会了把消息投进
 * 她的会话、按 `private:<QQ>` / `group:<群号>` 记绑定、算主动聊天的账。
 * 这些机制都值得照搬，所以这里只把「上游是谁」换掉：ArkLink 当 OneBot 服务端。
 *
 * 全部是纯函数：不发请求、不碰文件，方便单测。
 */

/** OneBot 的 content-type；CQ 码里有 `&` 和 `[`，别被 HTML 转义吃掉。 */
export const ONEBOT_CONTENT_TYPE = 'application/json; charset=utf-8';

/** ArkLink 的 chat_type：1 私聊，2 群。 */
export const CHAT_PRIVATE = 1;
export const CHAT_GROUP = 2;

/** 消息段拼回纯文本：qq-bridge 认 raw_message / message 两种，尽量都给。 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map(segment => {
      if (!segment || typeof segment !== 'object') return '';
      const type = String(segment.type || '');
      const data = segment.data || {};
      if (type === 'text') return String(data.text ?? '');
      if (type === 'at') return `@${data.qq ?? data.user_id ?? ''}`;
      if (type === 'face') return '';
      return '';
    })
    .join('');
}

/** OneBot 里 `message` 可能是一段字符串、也可能是消息段数组。 */
export function messageToText(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return segmentsToText(message);
  return '';
}

/**
 * 收到的 QQ 消息 → OneBot 事件。
 *
 * 字段照 OneBot 11 的 message 事件摆：`post_type/message_type/sub_type/message_id/user_id/
 * group_id/raw_message/message/sender/time/self_id`。桥按 `message_type` 分流，
 * 所以这个字段错了会导致「私聊被当成群聊」——最难查的一类。
 */
export function toEvent(item, selfId = '', subType = 'friend') {
  if (!item) return null;
  const group = Number(item.chat_type) === CHAT_GROUP;
  const text = String(item.text ?? '');
  const userId = String(item.sender_uid || item.uid || item.peer_uid || '');
  const groupId = group ? String(item.peer_uid || item.group_id || '') : '';
  if (!userId && !groupId) return null;
  const ts = Number(item.ts) || Math.floor(Date.now() / 1000);
  return {
    time: ts,
    self_id: Number(selfId) || 0,
    post_type: 'message',
    message_type: group ? 'group' : 'private',
    sub_type: group ? 'normal' : subType,
    message_id: Number(item.message_id || item.id || 0) || 0,
    user_id: Number(userId) || 0,
    ...(group ? { group_id: Number(groupId) || 0, anonymous: null } : {}),
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: {
      user_id: Number(userId) || 0,
      nickname: String(item.sender_name || item.nickname || ''),
      card: '',
    },
  };
}

/**
 * OneBot 的发送动作 → ArkLink 的发送参数。
 *
 * 支持 `send_msg` / `send_private_msg` / `send_group_msg` 三个动作；
 * `send_msg` 没有显式 `message_type` 时按有没有 `group_id` 判断。
 */
export function sendRequest(action, params = {}) {
  const kind = String(action || '');
  const hasGroup = params.group_id !== undefined && params.group_id !== null && params.group_id !== '';
  const isGroup = kind === 'send_group_msg' || (kind !== 'send_private_msg' && hasGroup);
  if (kind !== 'send_msg' && kind !== 'send_private_msg' && kind !== 'send_group_msg') {
    return { ok: false, reason: `不认识的动作：${kind || '(空)'}` };
  }
  const text = messageToText(params.message).trim();
  if (!text) return { ok: false, reason: '空消息不发送' };
  const to = isGroup ? params.group_id : params.user_id;
  if (to === undefined || to === null || String(to) === '') {
    return { ok: false, reason: isGroup ? '群号没给' : 'QQ 号没给' };
  }
  return { ok: true, body: { to: String(to), text, ...(isGroup ? { group: true } : {}) } };
}

/** ArkLink 的发送结果 → OneBot 的返回形状（status/retcode/data）。 */
export function sendResponse(result, action = '') {
  const ok = result?.ok !== false;
  const messageId = Number(result?.message_id ?? result?.msg_id ?? 0) || 0;
  if (!ok) {
    return { status: 'failed', retcode: 100, data: null, wording: String(result?.msg || result?.error || '发送失败') };
  }
  return {
    status: 'ok',
    retcode: 0,
    data: { message_id: messageId, ...(action === 'send_group_msg' || action === 'send_private_msg' ? {} : {}) },
  };
}

/**
 * OneBot 事件 → ArkLink 那种「一条消息」的形状。
 *
 * SnowLuma 给的是标准 OneBot 事件，而 runtime（session 模式）吃的是 ArkLink 的
 * item：`chat_type` 判群/私聊、`peer_uid` 是会话对端、`sender_uid` 是发言人。
 * 这两个形状说到底是同一件事，转一下就能让两条上游共用同一套 gate/batcher/会话绑定。
 *
 * `seq` 恒为 0：OneBot 没有游标，去重靠 `id`（runtime 就是这么用的）。
 */
export function itemFromEvent(event) {
  if (!event || event.post_type !== 'message') return null;
  const group = event.message_type === 'group';
  const peer = group ? event.group_id : event.user_id;
  if (peer === undefined || peer === null || String(peer) === '') return null;
  const sender = event.sender && typeof event.sender === 'object' ? event.sender : {};
  const text = typeof event.raw_message === 'string' && event.raw_message
    ? event.raw_message
    : messageToText(event.message);
  return {
    id: `ob:${event.message_type}:${peer}:${event.message_id ?? ''}`,
    seq: 0,
    chat_type: group ? CHAT_GROUP : CHAT_PRIVATE,
    peer_uid: String(peer),
    sender_uid: String(event.user_id ?? ''),
    sender_name: String(sender.card || sender.nickname || ''),
    text,
    ts: Number(event.time) || Math.floor(Date.now() / 1000),
    // 原始消息段留着：引用、语音这些要原样给出去的段，不能塌成文本
    segments: Array.isArray(event.message) ? event.message : undefined,
    raw: event,
  };
}

/** 心跳：桥靠它刷新「上次收包」的时间，卡片上那个「29 秒前」就是它。 */
export function heartbeat(selfId = '', online = true) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(selfId) || 0,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online, good: online, app_enabled: true },
    interval: 30000,
  };
}

/** 进群 / 退群之类的事件，桥只在意 notice_type 的几个值；给不出的就返回 null。 */
export function toNotice(item) {
  const kind = String(item?.notice_type || '');
  if (!kind) return null;
  return { time: Math.floor(Date.now() / 1000), post_type: 'notice', notice_type: kind, ...(item.group_id ? { group_id: Number(item.group_id) } : {}) };
}
