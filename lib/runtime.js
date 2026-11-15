/**
 * 通道的心脏：收一条 QQ 消息 → 交给她 → 把她说的话发回去。
 *
 * 分工：
 *   gate      谁能跟她说话（白名单 + 群里什么时候算在叫她）
 *   batcher   连着发的几句攒成一段，别让她为半句话回三次
 *   runtime   轮询、去重、排队、统计、状态快照
 *
 * 这里刻意不碰宿主细节：`ctx` 只用来发 askTurn 和读事件，会话由 sessions.js 给。
 */

import { createSessions } from './sessions.js';
import { itemFromEvent } from './onebot.js';
import { askTurn, createQueue, wordsFor } from './turn.js';
import { createBatcher, gate, identityOf, identityPrefix, planReply } from './text.js';

export { clock, createBatcher, gate, identityOf, identityPrefix, planReply, stripHostNoise } from './text.js';

/**
 * 整个通道。
 *
 * `host` 只有两样：sessionController（开/找会话）和可选的 workspaceRegistry。
 * `link` 是 arklink.js 的 QqLink —— 换成别家实现也能跑，只要接口一样。
 */
export function createRuntime({ ctx, config, host, link, snowluma = null, log = () => {} }) {
  const sessions = createSessions({ host, config, log });
  const queue = createQueue('QQ', { limit: 8 });
  const stats = {
    received: 0,
    replied: 0,
    blocked: 0,
    failed: 0,
    sent: 0,
    lastError: '',
    lastEventAt: '',
    lastBlockedAt: '',
    lastBlockedReason: '',
    lastReplyAt: '',
  };
  const seenIds = new Set();
  // 最近被白名单拦下的人：光有 lastBlockedReason 一条，看不出「都有谁被冷落了」，
  // 想把谁加进白名单时得有名单可抄。只留最近的，去重按发送者合并计数。
  const blockedRecent = new Map();
  let timer = null;
  let running = false;
  let stopped = false;
  let busy = false;
  let unsubscribe = null;
  let nickname = '';
  let uin = String(config.qq.accountUin || '');
  let dryRun = null;

  const nowIso = () => new Date().toISOString();
  const swallow = error => String(error?.message || error);

  const batcher = createBatcher({
    quietMs: config.qq.batchQuietMs,
    log,
    onFlush: (key, items) => answer(key, items),
  });

  /** 一段话 → 一轮 → 发回去。 */
  async function answer(key, items) {
    if (stopped || !config.qq.autoReply) return;
    const first = items[0];
    const identity = identityOf(first, uin || config.qq.accountUin);
    const group = identity.conversationType === 'group';
    const text =
      items.length === 1
        ? String(first.text ?? '')
        : items
            .map(item => (group && item.sender_name ? `${item.sender_name}: ${item.text}` : String(item.text ?? '')))
            .join('\n');
    if (!text.trim()) return;

    try {
      const reply = await queue.run(async cancelled => {
        const agent = await sessions.open(identity);
        queue.alive();
        const words = wordsFor(identityPrefix(identity) + text, { kind: 'user', identity });
        return askTurn(ctx, agent, words, { name: 'QQ', cancelled });
      });
      const parts = planReply(reply);
      if (!parts.length) {
        stats.failed += 1;
        stats.lastError = '她说了一轮，但过滤后没有能发到 QQ 的正文';
        log(`QQ ${key} 没有可发送的正文`);
        return;
      }
      for (const [index, part] of parts.entries()) {
        if (stopped) return;
        const receipt = await link.send({ to: identity.conversationId, text: part, group });
        // ArkLink 演练时返回 ok: true 但带 dry_run —— 不当场记下来，之后查起来会很费劲
        if (receipt && (receipt.dry_run === true || String(receipt.engine || '') === 'dry-run')) {
          if (dryRun !== true) log('ArkLink 在演练模式：这条回复没有真的发到 QQ');
          dryRun = true;
        }
        stats.sent += 1;
        // 分开的几句之间喘口气，别让对面觉得是机器人连发
        if (index < parts.length - 1) await new Promise(resolve => setTimeout(resolve, 260));
      }
      stats.replied += 1;
      stats.lastReplyAt = nowIso();
      stats.lastError = '';
    } catch (error) {
      stats.failed += 1;
      stats.lastError = swallow(error);
      log(`QQ ${key} 回复失败：${stats.lastError}`);
    }
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      // 上次开机没对上游标（ArkLink 还没起来、token 还没落地）：先只对齐、不处理。
      // 否则等 ArkLink 半夜回来，几十条积压会被当成刚发生的消息挨个回一遍。
      if (!link.started) {
        await link.primeCursor();
        if (!link.started) {
          stats.lastError = link.lastError || 'ArkLink 还没连上，等下一轮';
          return;
        }
      }
      const items = await link.messages(link.since);
      for (const item of items) handleItem(item);
    } catch (error) {
      stats.lastError = swallow(error);
    } finally {
      busy = false;
    }
  }

  /**
   * 一条消息进门之后的全部处理：去重 → 白名单/叫她的判据 → 攒一批。
   *
   * 两条上游共用它：ArkLink 轮询下来的 item 本来就是这形状；SnowLuma 的 OneBot
   * 事件由 itemFromEvent() 转成同样的形状再进来。
   */
  function handleItem(item) {
    if (stopped || !item) return;
    const seq = Number(item.seq) || 0;
    if (seq > link.since) link.since = seq;
    const id = String(item.id || '') || `fp:${seq}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    if (seenIds.size > 800) {
      // 只留最近的 400 条；Set 没有 LRU，直接重建够用
      const keep = [...seenIds].slice(-400);
      seenIds.clear();
      for (const one of keep) seenIds.add(one);
    }
    stats.received += 1;
    stats.lastEventAt = nowIso();
    const verdict = gate(item, config, { nickname, uin });
    if (!verdict.ok) {
      stats.blocked += 1;
      stats.lastBlockedAt = nowIso();
      stats.lastBlockedReason = verdict.reason;
      const who = String(item.sender_uid || item.peer_uid || '');
      if (who) {
        const prev = blockedRecent.get(who);
        blockedRecent.set(who, {
          id: who,
          group: Number(item.chat_type) === 2,
          name: String(item.sender_name || item.peer_name || ''),
          reason: verdict.reason,
          text: String(item.text ?? '').slice(0, 60),
          count: (prev?.count || 0) + 1,
          firstAt: prev?.firstAt || stats.lastBlockedAt,
          lastAt: stats.lastBlockedAt,
        });
        if (blockedRecent.size > 20) {
          const oldest = [...blockedRecent.entries()].sort((a, b) => String(a[1].lastAt).localeCompare(String(b[1].lastAt)))[0][0];
          blockedRecent.delete(oldest);
        }
      }
      return;
    }
    batcher.push(`${item.chat_type}:${item.peer_uid}`, item);
  }

  async function start() {
    if (running || stopped) return;
    const status = await link.status();
    nickname = String(status.nickname || '');
    uin = String(status.uin || uin || '');
    dryRun = readDryRun(status.detail);
    await link.primeCursor();
    running = true;

    // SnowLuma 在线时它是主收信：ArkLink 在 Linux 上收不到（hook 撞墙），
    // 但发文字仍然走它（会点界面，比协议层更容易被风控摸到）。
    if (snowluma?.enabled) {
      unsubscribe = snowluma.onEvent(event => {
        const item = itemFromEvent(event);
        if (item) handleItem(item);
      });
      snowluma.start();
      log(`收信走 SnowLuma（${snowluma.wsUrl}）：语音/引用也是这条；ArkLink 负责发文字`);
    }

    timer = setInterval(() => void tick(), Math.max(Number(config.arklink.pollMs) || 2000, 500));
    void tick();
    log(`QQ 通道已开：${link.label}（uin=${uin || '未知'}，游标 ${link.since}）`);
    // 演练模式下「一切正常」但消息不出网 —— 这是最难自己发现的一类故障，宁可提前吵一句
    if (dryRun === true) log('注意：ArkLink 在演练模式（dry-run），收得到、发不出去。要真发得在 ArkLink 里关掉它。');
  }

  /**
   * 判断当前是否在演练：以 ArkLink 现在生效的发送引擎为准。
   *
   * 原来读的是「上一次发送记录」，可那是历史快照 —— 引擎换成真的之后，
   * 那条旧记录仍写着 dry-run，会一直误报成「发不出去」。
   * 只有引擎字段缺失时，才退回去看历史记录。
   */
  function readDryRun(detail) {
    const engine = String(detail?.engine || '');
    if (engine) return engine === 'dry-run';
    const last = detail?.sends?.last;
    if (!last) return null;
    return last.dry_run === true || String(last.engine || '') === 'dry-run';
  }

  function stop() {
    stopped = true;
    running = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (timer) clearInterval(timer);
    timer = null;
    batcher.stop();
    queue.stop();
    sessions.stop();
  }

  function snapshot() {
    return {
      running: running && !stopped,
      transport: link.mode,
      endpoint: link.baseUrl,
      account: { uin, nickname },
      // 实际持有的凭据，而不是「配置里写没写 token」——首次登录后 token 是落在文件里的
      hasToken: Boolean(link.credential ? link.credential() : link.token),
      cursor: link.since,
      homeBound: sessions.bound,
      homeSessionId: sessions.homeId(),
      autoReply: Boolean(config.qq.autoReply),
      // 演练模式下「发送成功」是假的，状态里必须说清楚，否则最难排查
      dryRun,
      counts: {
        received: stats.received,
        replied: stats.replied,
        sent: stats.sent,
        blocked: stats.blocked,
        failed: stats.failed,
      },
      lastError: stats.lastError || link.lastError || '',
      snowluma: snowluma?.snapshot?.() ?? null,
      lastEventAt: stats.lastEventAt,
      lastBlockedAt: stats.lastBlockedAt,
      lastBlockedReason: stats.lastBlockedReason,
      // 最近被拦的人，最近说话的在前；想把谁放进白名单，照这里的 id 加就行
      blockedRecent: [...blockedRecent.values()]
        .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
        .slice(0, 10),
      lastReplyAt: stats.lastReplyAt,
      gates: {
        allowPrivate: config.qq.allowPrivate,
        allowGroups: config.qq.allowGroups,
        groupTrigger: config.qq.groupTrigger,
        groupKeywords: config.qq.groupKeywords,
      },
    };
  }

  return { start, stop, tick, snapshot, sessions };
}
