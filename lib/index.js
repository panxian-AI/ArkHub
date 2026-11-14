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
import { createRuntime } from './runtime.js';
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
    const runtime = createRuntime({ ctx, config, host, link, log });

    sc.effect(
      () => {
        void runtime.start().catch(error => log(`QQ 通道没能起来：${error?.message || error}`));
        return () => runtime.stop();
      },
      'dsh-arkhub: qq channel',
    );

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
            sendJson(res, 200, {
              ok: true,
              version: VERSION,
              config: describeConfig(config),
              channel: runtime.snapshot(),
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

          sendJson(res, 404, { error: 'not found', paths: ['/status', '/update', 'POST /mute', 'POST /config'] });
        },
      };
      const unregister = webServer.register(route);
      wc.effect(() => () => unregister(), 'dsh-arkhub: route');
      log(`状态路由已挂在 /dsh-arkhub/status`);
    });

    log(`已装配：transport=${config.transport} ${link.label}，白名单 私聊${config.qq.allowPrivate.length}/群${config.qq.allowGroups.length}`);
  });
}
