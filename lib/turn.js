/**
 * 把一段话交给「她」，等她说完，把这一轮说的话取回来。
 *
 * 这段逻辑照 dsh-world 的做法写：她可能正忙（闹钟、压缩、别的门），所以不能「新建一轮」，
 * 只能往她当前的会话里递一句话，然后按**顺序**等这一轮结束 —— 递进去之后的下一个
 * `turn/end` 就是这句话的回音。中途要是有人插话（真正的人，不是宿主注入的运行时快照），
 * 那就不是她对我说的了，立刻停。
 *
 * 为什么要自己写：DSH 没有「发一句话给我回复」这样的同步 API，只有事件流。
 * 判断「这轮是不是在回我」靠的是 user/message 的 id 对得上，这是唯一可靠的锚点。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 第一次回合常要跑过三分钟（快照、技能表、人格、回忆），给足时间。 */
export const REPLY_TIMEOUT_MS = 10 * 60_000;

/** 一次只跑一个请求：她的家是一间屋子，不是群聊广场。 */
export function createQueue(name, { limit = 8, timeoutMs = REPLY_TIMEOUT_MS } = {}) {
  const cancellations = new Set();
  let pending = Promise.resolve();
  let stopped = false;
  let queued = 0;
  const stoppedError = () => new Error(`${name} 模块已停止`);

  function run(work) {
    if (stopped) return Promise.reject(stoppedError());
    if (queued >= limit) return Promise.reject(new Error(`${name} 排队太多，先不收了`));
    queued += 1;
    const result = pending
      .then(async () => {
        if (stopped) throw stoppedError();
        let timer;
        let cancel;
        const cancelled = new Promise((_, reject) => {
          cancel = () => reject(stoppedError());
          timer = setTimeout(() => reject(new Error(`${name} 等回复超时`)), timeoutMs);
        });
        cancelled.catch(() => {});
        cancellations.add(cancel);
        try {
          return await work(cancelled);
        } finally {
          cancellations.delete(cancel);
          clearTimeout(timer);
        }
      })
      .finally(() => {
        queued -= 1;
      });
    pending = result.catch(() => {});
    return result;
  }

  return {
    run,
    get stopped() {
      return stopped;
    },
    alive() {
      if (stopped) throw stoppedError();
    },
    stop() {
      stopped = true;
      for (const cancel of cancellations) cancel();
    },
  };
}

const textOf = message =>
  (message?.content ?? []).flatMap(block => (block?.type === 'text' ? [block.text] : [])).join('\n');

/**
 * 递一句话，等她的回音。
 *
 * `words` 是 createUserMessage 造的（带 source，宿主据此判断「这是人说的」）。
 */
export async function askTurn(ctx, agent, words, { name = 'QQ', cancelled, context } = {}) {
  const abort = cancelled ?? new Promise(() => {});
  let admitted = false;
  let failed = false;
  let cut = false;
  let reply = '';
  let seen = 0;
  let last = 'none';
  let finish;
  const finished = new Promise(resolve => {
    finish = resolve;
  });

  const dispose = ctx.on('session/event', (session, event) => {
    if (session.id !== agent.id || cut) return;
    seen += 1;
    if (event.type === 'turn/end') last = `end/${event.data.reason.kind}`;
    if (event.type === 'user/message') {
      if (event.data.id === words.id) {
        admitted = true;
      } else {
        last = `inject/${event.data.source?.kind ?? '?'}`;
        // 真正的人插话 → 这一轮不再是在回我
        if (admitted && event.data.source?.kind === 'user') {
          cut = true;
          finish();
          return;
        }
      }
    }
    if (!admitted) return;
    if (event.type === 'assistant/message') {
      last = 'reply';
      reply = textOf(event.data.message);
      if (event.data.interrupted) failed = true;
    }
    if (event.type === 'turn/end') {
      if (event.data.reason?.kind !== 'completed') failed = true;
      finish();
    }
  });

  const trace = () => `事件=${seen} admitted=${admitted} failed=${failed} 最后=${last}`;
  try {
    if (typeof agent.whenIdle === 'function') await Promise.race([agent.whenIdle(), abort]);
    if (context) agent.inject(context);
    agent.followup(words);
    await Promise.race([finished, abort]).catch(error => {
      throw new Error(`${error.message}（${trace()}）`, { cause: error });
    });
    if (!admitted || failed || (cut && !reply.trim())) {
      throw new Error(`${name} 这一轮没能说完（${trace()}）`);
    }
  } finally {
    dispose();
  }
  try {
    await Promise.race([ctx.sessions.flush(agent.session), abort]);
  } catch {
    /* flush 失败不影响已经拿到的回复 */
  }
  return reply;
}

/** 造一条「人说的话」，带上她需要的那行来源说明。 */
export function wordsFor(text, source) {
  return createUserMessage({ source, content: [{ type: 'text', text }] });
}
