/**
 * 配置归一化。
 *
 * DSH 的插件配置来自 profile 里 cordis.patch.yml 的那一段，形状可能被人手改坏。
 * 这里只做一件事：把「能缺的」补上、把「一定是错的」挑出来，让后面的代码不用到处判空。
 */

const DEFAULTS = {
  enabled: true,
  transport: 'arklink',
  arklink: {
    baseUrl: 'http://127.0.0.1:6900',
    token: '',
    tokenFile: '~/.arklink/api.json',
    pollMs: 2000,
    timeoutMs: 8000,
  },
  arkhub: {
    baseUrl: 'http://127.0.0.1:7090',
    apiKey: '',
  },
  /**
   * SnowLuma：收信的上游（也是语音/引用这些「富消息」的出口）。
   *
   * 它跟 ArkLink 是互补的，不是替代关系：
   *   ArkLink  会点界面的手 —— 发文字稳，收信要 hook 注入，Linux 上一直没通
   *   SnowLuma 会插协议的手 —— 收信、语音、引用、图片都在协议层，正好补 ArkLink 的缺口
   * 两个端口都是 VBox NAT 转出来的宿主机端口（guest 3000/3001 → host 3102/3101）。
   */
  snowluma: {
    enabled: true,
    httpUrl: 'http://127.0.0.1:3102',
    wsUrl: 'ws://127.0.0.1:3101',
    httpToken: '',
    wsToken: '',
    timeoutMs: 8000,
  },
  qq: {
    accountUin: '',
    allowPrivate: [],
    allowGroups: [],
    ownerQQ: '',
    autoReply: true,
    groupTrigger: 'mention',
    groupKeywords: [],
    contextMessages: 6,
    batchQuietMs: 4500,
    mutedUntil: '',
  },
  session: {
    dshHome: '~/.dsh',
    worldId: 'default',
    bindHomeSession: 'owner',
    agentPreset: 'standard',
    homeSessionId: '',
    groupTitlePrefix: 'QQ',
  },
  update: {
    check: true,
    repo: 'panxian-AI/ArkHub',
  },
  /**
   * OneBot 门面。开着的时候本插件不自己投会话，只把 ArkLink 翻译成 OneBot，
   * 由 qq-bridge 按它自己的机制（state/sessions.json 按入口绑定）去投。
   * 世界控制台那张 QQ 卡读的就是 qq-bridge，所以这条路下面卡片是真的。
   */
  bridge: {
    enabled: false,
    port: 3010,
    token: '',
    heartbeatMs: 30000,
  },
};

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** QQ 号白名单：只留数字串；空数组 = 谁都不理（这是原插件的规矩，我们照抄，别偷偷放开）。 */
export function qqNumbers(raw, label) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  for (const one of list) {
    const id = String(one ?? '').trim();
    if (!id) continue;
    if (!/^[0-9]+$/.test(id)) throw new Error(`${label} 里有个不是 QQ 号：${id}`);
    out.push(id);
  }
  return out;
}

export function normalizeConfig(raw = {}) {
  const config = deepMerge(DEFAULTS, raw ?? {});
  config.transport = String(config.transport || 'arklink').toLowerCase();
  if (!['arklink', 'arkhub'].includes(config.transport)) config.transport = 'arklink';
  config.qq.allowPrivate = qqNumbers(config.qq.allowPrivate, 'qq.allowPrivate');
  config.qq.allowGroups = qqNumbers(config.qq.allowGroups, 'qq.allowGroups');
  config.qq.groupKeywords = (Array.isArray(config.qq.groupKeywords) ? config.qq.groupKeywords : [])
    .map(item => String(item ?? '').trim())
    .filter(Boolean);
  config.qq.batchQuietMs = Math.min(Math.max(Number(config.qq.batchQuietMs) || 0, 0), 30000);
  config.qq.contextMessages = Math.min(Math.max(Number(config.qq.contextMessages) || 0, 0), 40);
  config.arklink.pollMs = Math.min(Math.max(Number(config.arklink.pollMs) || 2000, 500), 30000);
  config.snowluma.timeoutMs = Math.min(Math.max(Number(config.snowluma.timeoutMs) || 8000, 1000), 60000);
  config.session.bindHomeSession = ['owner', 'all', 'none'].includes(config.session.bindHomeSession)
    ? config.session.bindHomeSession
    : 'owner';
  return config;
}

/** 面板/CLI 要看的「现在到底开没开」。 */
export function describeConfig(config) {
  return {
    enabled: Boolean(config.enabled),
    transport: config.transport,
    arklink: {
      baseUrl: config.arklink.baseUrl,
      hasToken: Boolean(String(config.arklink.token || '').trim()),
      tokenFile: config.arklink.tokenFile,
    },
    allowPrivate: config.qq.allowPrivate,
    allowGroups: config.qq.allowGroups,
    ownerQQ: config.qq.ownerQQ,
    autoReply: Boolean(config.qq.autoReply),
    groupTrigger: config.qq.groupTrigger,
    groupKeywords: config.qq.groupKeywords,
    bindHomeSession: config.session.bindHomeSession,
    worldId: config.session.worldId,
    batchQuietMs: config.qq.batchQuietMs,
    contextMessages: config.qq.contextMessages,
    updateCheck: Boolean(config.update.check),
    snowluma: {
      enabled: Boolean(config.snowluma?.enabled),
      httpUrl: config.snowluma?.httpUrl || '',
      wsUrl: config.snowluma?.wsUrl || '',
      // token 只报「有没有」，不回显
      hasToken: Boolean(String(config.snowluma?.httpToken || config.snowluma?.wsToken || '').trim()),
    },
    bridge: {
      enabled: Boolean(config.bridge?.enabled),
      port: Number(config.bridge?.port) || 3010,
      // 不输出 token 明文
      hasToken: Boolean(String(config.bridge?.token || '').trim()),
    },
  };
}
