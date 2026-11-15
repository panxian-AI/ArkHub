/**
 * 纯函数层：谁能说话、她读到什么、她说的话怎么变成几条消息。
 *
 * 单独放一个文件，是为了能脱离 DSH 跑测试 —— 这一层出错，聊天就会悄悄错，
 * 而它自己不需要宿主。
 */

const pad = value => String(value ?? '').padStart(2, '0');
export const clock = date => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

/** 宿主塞进她回合里的东西，别发到 QQ 上。 */
const HOST_LINE = /^\s*(?:Time sampled|Browser time zone|Elapsed since|Elapsed from)\b/;
/** 模型把工具调用当正文写出来的那段标记（DeepSeek 的 <｜DSML｜…>）。 */
const TOOL_MARKUP = /<\/?[|｜]+\s*DSML\s*[|｜]+[\s\S]*$/;
/** 她把自己刚读到的聊天记录又念一遍。 */
const RECALL_LINE = /仅作引用数据|^\s*[[{].*"(?:role|speakerId)"\s*:.*[}\]]\s*$|^\s*(?:user|assistant)\s*$/;
/** 来源头：她复述了「【QQ「张三」，chatId 123】」这种行。 */
const HEADER_LINE = /^【[^【】\n]*，chatId [^【】\n]+】$/;
const MARK = /\[\[(img|face|at|sticker|qzone):([^[\]]+)\]\]/g;

/** 清掉不属于「她说的话」的部分。 */
export function stripHostNoise(text) {
  const kept = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(TOOL_MARKUP, '')
    .split('\n')
    .filter(line => !HOST_LINE.test(line) && !HEADER_LINE.test(line.trim()) && !RECALL_LINE.test(line));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 一句回答变成几条要发的话：空行分段；`[[…]]` 标记先拿掉（这一版只发文字）。 */
export function planReply(raw) {
  return stripHostNoise(raw)
    .replace(MARK, '')
    .split(/\n{2,}/)
    .map(chunk => chunk.trim())
    .filter(Boolean);
}

/** 她读到的那行来源：【QQ「张三」，chatId 10001】/【QQ群「一家人」 张三 说，chatId 20002】 */
export function identityPrefix(identity) {
  const group = identity.conversationType === 'group';
  const name =
    identity.conversationName || (group ? identity.conversationId : identity.speakerName) || identity.conversationId;
  const speaker = group ? ` ${identity.speakerName || identity.speakerId} 说` : '';
  return `【QQ${group ? '群' : ''}「${name}」${speaker}，chatId ${identity.conversationId}】\n`;
}

/** ArkLink 的一条消息 → 她读得懂的来源。 */
export function identityOf(item, accountUin, chatGroup = 2) {
  const group = Number(item.chat_type) === Number(chatGroup);
  return {
    channel: 'qq',
    accountId: String(accountUin || ''),
    conversationId: String(item.peer_uid || item.sender_uid || ''),
    speakerId: `qq:${item.sender_uid || item.peer_uid || 'unknown'}`,
    ...(item.sender_name ? { speakerName: String(item.sender_name) } : {}),
    conversationType: group ? 'group' : 'private',
    ...(item.peer_name ? { conversationName: String(item.peer_name) } : {}),
    ...(item.id ? { platformMessageId: String(item.id) } : {}),
  };
}

/**
 * 谁能进来。
 *
 * 白名单留空 = 谁都不理（照 dsh-world 的规矩，不偷偷放开）。
 * 唯一的例外是 owner：配置里写明的 ownerQQ（或本账号 uin）是持机人本人，
 * 显式信任 —— 私聊直接过、群里不用 @ 也算在叫她。静默照样管得住他。
 * 群里其他人默认只有被叫到才接：@ 她、或者命中关键词。
 */
export function gate(item, config, { nickname = '', uin = '' } = {}) {
  const group = Number(item.chat_type) === 2;
  const text = String(item.text ?? '');
  const sender = String(item.sender_uid || '');
  const peer = String(item.peer_uid || '');
  const owner = String(config.qq.ownerQQ || config.qq.accountUin || uin || '');
  const isOwner = Boolean(owner) && (sender === owner || (!group && peer === owner));
  const listeners = group ? config.qq.allowGroups : config.qq.allowPrivate;
  if (group) {
    // 群本身得在白名单里 —— owner 也一样，免检免的是「要不要 @ 他」这一关
    if (!listeners.length) return { ok: false, reason: '群白名单是空的（谁都不理）' };
    if (!listeners.includes(peer) && !listeners.includes(sender)) {
      return { ok: false, reason: `不在白名单：${peer}` };
    }
  } else if (!isOwner) {
    if (!listeners.length) return { ok: false, reason: '私聊白名单是空的（谁都不理）' };
    if (!listeners.includes(peer) && !listeners.includes(sender)) {
      return { ok: false, reason: `不在白名单：${sender}` };
    }
  }
  if (!group) return { ok: true };
  const mutedUntil = String(config.qq.mutedUntil || '');
  if (mutedUntil && Date.now() < Date.parse(mutedUntil)) return { ok: false, reason: '正在静默' };
  if (isOwner) return { ok: true };
  if (String(config.qq.groupTrigger || 'mention') === 'all') return { ok: true };
  const marks = [`@${nickname}`, nickname, `@${uin}`, ...(config.qq.groupKeywords || [])].filter(Boolean);
  if (marks.some(mark => text.includes(mark))) return { ok: true };
  return { ok: false, reason: '群里没叫她（只记上下文，不回）' };
}

/** 攒批：同一个会话连续说的话，静默 `quietMs` 之后当作一段。 */
export function createBatcher({ quietMs, onFlush, log = () => {} }) {
  const buckets = new Map();
  function push(key, item) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { items: [], timer: null };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => {
      const gathered = bucket.items.slice();
      buckets.delete(key);
      Promise.resolve(onFlush(key, gathered)).catch(error => log(`攒批投递失败：${error?.message || error}`));
    }, Math.max(Number(quietMs) || 0, 0));
  }
  function stop() {
    for (const bucket of buckets.values()) if (bucket.timer) clearTimeout(bucket.timer);
    buckets.clear();
  }
  return { push, stop, get size() { return buckets.size; } };
}
