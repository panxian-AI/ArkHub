/**
 * dsh-arkhub —— 把 DSH 里的「她」接上 QQ。
 *
 * 它不新建一个人，也不搬走她原来的家：消息进来走她已经在住的会话（世界里那间），
 * 她说的话原路回到 QQ。QQ 侧只认 ArkLink 一种通道，所以不需要 SnowLuma、不需要
 * 第二个进程、不需要扫码以外的任何人工步骤。
 *
 * 装配顺序（少一步都不工作，所以写在这里）：
 *   1. 读配置、算出白名单
 *   2. 等宿主的 sessionController —— 会话说到底由它开
 *   3. 起通道（ArkLink 轮询）
 *   4. 挂一条只读路由 /dsh-arkhub/status，面板和排障都看它
 */

import { describeConfig, normalizeConfig } from './config.js';
import { QqLink } from './arklink.js';
import { SnowLuma } from './snowluma.js';
import { createRuntime } from './runtime.js';
import { createFacade } from './facade.js';
import { VERSION, checkUpdate, muteUpdates } from './update.js';

export const name = 'dsh-arkhub';

/** 会话、事件、模型：她说话必须经过这几样。 */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];

const WRITE_HEADER = 'x-dsh-arkhub';
const MAX_BODY = 8 * 1024;

function makeLogger(ctx) {
  const write = (level, args) => {
    const line = args.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
    try {
      ctx.logger?.[level]?.(`[arkhub] ${line}`);
    } catch {
      /* 日志失败不该影响聊天 */
    }
  };
  return Object.assign((...args) => write('info', args), {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 只认本机 / 白名单 Host：别的网页不该能读她的 QQ 状态。 */
function allowedHost(req, extra = []) {
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false;
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const ok = ['127.0.0.1', 'localhost', '[::1]', ...extra.map(one => String(one).toLowerCase())];
  return ok.includes(host);
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const log = makeLogger(ctx);

  if (!config.enabled) {
    log('未启用（配置里 enabled: false）');
    return;
  }

  ctx.inject(['sessionController'], sc => {
    const host = { sessionController: sc.sessionController };
    const link = new QqLink(config, log);
    // 收信上游。没配 / 没起来都不影响发文字：SnowLuma 连不上就是一条日志。
    const snowluma = config.snowluma?.enabled ? new SnowLuma(config.snowluma, log) : null;

    // 两种接法，只开一种 —— 同时开会把每条回复发两遍。
    //   session（默认）：自己把消息投进她的会话，不需要 qq-bridge
    //   bridge：只做 OneBot 门面，让 qq-bridge 按它自己的机制（sessions.json 按入口绑定）去投
    const bridgeMode = config.bridge.enabled;
    const runtime = bridgeMode ? null : createRuntime({ ctx, config, host, link, snowluma, log });
    const facade = bridgeMode ? createFacade({ config, link, snowluma, log }) : null;
    const channel = facade ?? runtime;

    sc.effect(
      () => {
        void channel.start().catch(error => log(`QQ 通道没能起来：${error?.message || error}`));
        return () => {
          channel.stop();
          snowluma?.stop();
        };
      },
      'dsh-arkhub: qq channel',
    );

    if (bridgeMode) {
      log(`门面模式：qq-bridge 的 snowluma.httpUrl / wsUrl 指向 127.0.0.1:${config.bridge.port} 即可接管；会话绑定由 qq-bridge 维护`);
    }

    // 更新提示：后台查，查到有新版只说一句；查不到什么都不做
    void checkUpdate(config)
      .then(snapshot => {
        if (snapshot?.hasUpdate) log(`有新版本 ${snapshot.latest}（当前 ${VERSION}）：${snapshot.url}`);
      })
      .catch(() => {});

    ctx.inject(['webServer'], wc => {
      const webServer = wc.webServer;
      const route = {
        kind: 'prefix',
        path: '/dsh-arkhub',
        handler: async (req, res) => {
          if (!allowedHost(req)) {
            sendJson(res, 403, { error: 'forbidden' });
            return;
          }
          const url = new URL(req.url ?? '/dsh-arkhub', 'http://localhost');
          const path = url.pathname.replace(/^\/dsh-arkhub/, '') || '/';

          if (req.method === 'GET' && (path === '/' || path === '/status')) {
            const update = await checkUpdate(config, { fetch: false });
            const snap = channel.snapshot();
            const view = describeConfig(config);
            view.arklink.hasToken = Boolean(snap.hasToken ?? link.credential?.() ?? link.token);
            sendJson(res, 200, {
              ok: true,
              version: VERSION,
              // 哪种接法：session 自己投会话，bridge 交给 qq-bridge（世界控制台那张卡看的就是它）
              mode: bridgeMode ? 'bridge' : 'session',
              config: view,
              channel: snap,
              update,
            });
            return;
          }

          if (req.method === 'GET' && path === '/update') {
            const force = url.searchParams.get('force') === '1';
            sendJson(res, 200, await checkUpdate(config, { force }));
            return;
          }

          if (req.method === 'POST') {
            if (String(req.headers[WRITE_HEADER] ?? '') === '') {
              sendJson(res, 400, { error: `写操作必须带 ${WRITE_HEADER} 请求头` });
              return;
            }
            const body = (await readJson(req)) ?? undefined;
            if (body === undefined) {
              sendJson(res, 400, { error: '请求体不是合法 JSON（或超过 8KB）' });
              return;
            }
            if (path === '/ingest') {
              // ArkBot 兜底：它自己连协议端收信，再把 OneBot 事件 POST 进来。
              // 只认门面模式 —— session 模式没有要广播的 OneBot 客户端。
              if (!facade) {
                sendJson(res, 409, { error: '兜底入口只在门面模式（bridge.enabled）下有用' });
                return;
              }
              const accepted = facade.ingest(body);
              sendJson(res, accepted ? 202 : 409, { ok: accepted });
              return;
            }
            if (path === '/mute') {
              muteUpdates(body.muted !== false);
              sendJson(res, 200, { ok: true, muted: body.muted !== false });
              return;
            }
            if (path === '/config') {
              // 只允许改「活开关」：白名单、回不回、静默到几点。改完下一条消息就生效。
              if (typeof body.autoReply === 'boolean') config.qq.autoReply = body.autoReply;
              if (typeof body.mutedUntil === 'string') config.qq.mutedUntil = body.mutedUntil;
              for (const key of ['allowPrivate', 'allowGroups']) {
                if (body[key] === undefined) continue;
                try {
                  config.qq[key] = normalizeConfig({ qq: { [key]: body[key] } }).qq[key];
                } catch (error) {
                  sendJson(res, 400, { error: String(error?.message || error) });
                  return;
                }
              }
              sendJson(res, 200, { ok: true, config: describeConfig(config) });
              return;
            }
          }

          sendJson(res, 404, { error: 'not found', paths: ['/status', '/update', 'POST /mute', 'POST /config', 'POST /ingest'] });
        },
      };
      const unregister = webServer.register(route);
      wc.effect(() => () => unregister(), 'dsh-arkhub: route');
      log(`状态路由已挂在 /dsh-arkhub/status`);
    });

    log(`已装配：transport=${config.transport} ${link.label}，白名单 私聊${config.qq.allowPrivate.length}/群${config.qq.allowGroups.length}`);
  });
}
