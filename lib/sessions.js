/**
 * 消息落在哪个会话里。
 *
 * 这是「把她接上 QQ」最关键的一条：QQ 里的人不该开一个新的人，她该是**原来那个她**。
 * 所以私聊默认走进她已经在住的家会话（`worlds/<worldId>/life.json` 里的 `homeSessionId`），
 * 群聊才各开一间屋子 —— 群里的话不能串进私聊。
 *
 * 找不到世界文件（没装 dsh-world、或没开始过）时退化成「QQ 专用会话」：
 * 一样能聊，只是不共享她原来的记忆。
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_MISSING = 'session/not-found';

function expandHome(path) {
  const text = String(path ?? '');
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
  return text;
}

export function worldDir(dshHome, worldId) {
  return join(expandHome(dshHome || '~/.dsh'), 'worlds', worldId || 'default');
}

/** 她的家会话 id：世界跑起来才有，没跑就是空。 */
export function readHomeSessionId(dshHome, worldId) {
  const file = join(worldDir(dshHome, worldId), 'life.json');
  try {
    if (!existsSync(file)) return '';
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return String(data.homeSessionId || '');
  } catch {
    return '';
  }
}

export function conversationKey(identity) {
  return JSON.stringify([
    identity.channel,
    identity.accountId,
    identity.conversationType ?? 'private',
    identity.conversationId,
  ]);
}

/**
 * 会话目录。`host` 是宿主服务的最小面（sessionController + 可选 workspaceRegistry），
 * 由 index.js 注入 —— 这里不直接摸 ctx，方便单测。
 */
export function createSessions({ host, config, log = () => {} }) {
  const opening = new Map();
  const keyToSession = new Map();
  const firstTitles = new Map();
  let stopped = false;
  let cachedHomeId = '';

  const sessionCfg = config.session || {};

  function homeId() {
    if (sessionCfg.homeSessionId) return String(sessionCfg.homeSessionId);
    if (!cachedHomeId) cachedHomeId = readHomeSessionId(sessionCfg.dshHome, sessionCfg.worldId);
    return cachedHomeId;
  }

  async function resolveAgent(sessionId) {
    const found = await host.sessionController.resolveAgent(sessionId);
    if (found && 'agent' in found) return found.agent;
    if (found && found.error && found.error.code === SESSION_MISSING) return undefined;
    throw new Error(`会话 ${sessionId} 打不开：${found?.error?.message ?? '未知原因'}`);
  }

  async function createSession(cwd, title) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      /* 目录已存在或没权限，交给宿主报错 */
    }
    const { sessionId } = await host.sessionController.create({ cwd, agentPreset: sessionCfg.agentPreset || 'standard' });
    if (title) {
      firstTitles.set(sessionId, title);
      void host.sessionController.rename({ sessionId, title }).catch(() => {});
    }
    return sessionId;
  }

  /** 她的家：优先用世界里那间，找不到就建一个 QQ 专用屋子并记住。 */
  async function home() {
    if (stopped) throw new Error('QQ 通道已停止');
    const wanted = homeId();
    if (wanted) {
      const agent = await resolveAgent(wanted);
      if (agent) return agent;
      log(`家会话 ${wanted} 不在了，改用 QQ 专用会话`);
    }
    const room = join(worldDir(sessionCfg.dshHome, sessionCfg.worldId), 'room');
    const id = keyToSession.get('__home__') ?? (await createSession(room, `${config.session?.groupTitlePrefix || 'QQ'} · 私聊`));
    keyToSession.set('__home__', id);
    const agent = await resolveAgent(id);
    if (!agent) throw new Error('QQ 私聊会话建不起来');
    return agent;
  }

  /** 一个群 / 一个人的独立会话（群聊默认走这里）。 */
  async function channel(identity) {
    if (stopped) throw new Error('QQ 通道已停止');
    const key = conversationKey(identity);
    const known = keyToSession.get(key);
    if (known) {
      const agent = await resolveAgent(known);
      if (agent) return agent;
      keyToSession.delete(key);
    }
    const room = join(worldDir(sessionCfg.dshHome, sessionCfg.worldId), 'room');
    const label = `${config.session?.groupTitlePrefix || 'QQ'}${identity.conversationType === 'group' ? '群' : ''}「${identity.conversationName || identity.conversationId}」`;
    const id = await createSession(room, label);
    keyToSession.set(key, id);
    return (await resolveAgent(id)) ?? Promise.reject(new Error('QQ 会话建不起来'));
  }

  async function open(identity) {
    const pendingKey = conversationKey(identity);
    let pending = opening.get(pendingKey);
    if (pending) return pending;
    const isPrivate = identity.conversationType !== 'group';
    const bind = sessionCfg.bindHomeSession || 'owner';
    const work = (isPrivate && bind !== 'none' ? home() : channel(identity)).finally(() => opening.delete(pendingKey));
    opening.set(pendingKey, work);
    return work;
  }

  return {
    open,
    home,
    homeId,
    get bound() {
      return Boolean(homeId());
    },
    /** 她在家里自己说的话要不要也推给他的 QQ。 */
    stamp() {
      return { homeId: homeId(), stopped };
    },
    stop() {
      stopped = true;
      opening.clear();
    },
    forget(identity) {
      keyToSession.delete(conversationKey(identity));
    },
  };
}
