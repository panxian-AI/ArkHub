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

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeConfig, normalizeConfig } from './config.js';
import { persistConfig } from './dsh-home.js';
import { QqLink } from './arklink.js';
import { SnowLuma } from './snowluma.js';
import { createRuntime } from './runtime.js';
import { createFacade } from './facade.js';
import { describeLines } from './lines.js';
import { describeManual, manualPage, readManual, startRelay } from './manual.js';
import { VERSION, checkUpdate, muteUpdates } from './update.js';

export const name = 'dsh-arkhub';

/** 换线要重启本插件（装配行变了），所以干活的那个进程得从包装目录里找 CLI。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function expandHome(path) {
  const text = String(path ?? '');
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
  return text;
}

/** 换线的流水账：出问题第一眼看这个文件，比翻 DSH 日志快。 */
export function lineSwitchLog(home) {
  return join(home, 'arkhub', 'line-switch.log');
}

/**
 * 把「换到哪条线」交给一个独立进程去做。
 *
 * 为什么不在这里直接调 switchLine：换线要改 cordis.patch.yml，DSH 会当场重载本插件，
 * 正在跑的这个函数会连同 Promise 一起被丢掉 —— 桥的重启那一步就没人做了。
 */
function spawnLineSwitch(target, home, log = () => {}, userAgent = '') {
  try {
    const cli = join(PKG_ROOT, 'bin', 'dsh-arkhub.mjs');
    mkdirSync(join(home, 'arkhub'), { recursive: true });
    const stamp = new Date().toISOString();
    appendFileSync(lineSwitchLog(home), `\n[${stamp}] 换线 → ${target}（UA: ${String(userAgent || '未知').slice(0, 70)}）\n`, 'utf8');
    const fd = openSync(lineSwitchLog(home), 'a');
    const child = spawn(process.execPath, [cli, 'line', target, '--home', home], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    log(`换线（${target}）交给独立进程了，进度看 ${lineSwitchLog(home)}`);
    return true;
  } catch (error) {
    log(`换线进程没起来：${error?.message || error}`);
    return false;
  }
}

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
    //
    // 第三种是「待命」：channel.enabled=false。只在纯会话用户退回原桥时出现；门面世界里
    // 是「双线常驻」—— 门面和真 SnowLuma 两条线都挂着，桥的上游接谁，说话的就是谁的号。
    // 门面挂着但桥接了真 SnowLuma 时，事件推不出去（没有客户端），号在线但不说话，
    // 不会出现「两个号一起回话」。
    const channelOn = config.channel?.enabled !== false;
    const bridgeMode = channelOn && config.bridge.enabled;
    const runtime = channelOn && !bridgeMode ? createRuntime({ ctx, config, host, link, snowluma, log }) : null;
    const facade = channelOn && bridgeMode ? createFacade({ config, link, snowluma, log }) : null;
    const channel = facade ?? runtime;
    const DORMANT = Object.freeze({ running: false, dormant: true });

    if (channel) {
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
    } else {
      log('待命：channel.enabled 关着（世界控制台选的是「原桥」），本插件不轮询、不开门面，只留状态与换线路由');
    }

    if (bridgeMode) {
      log(`门面（默认，只做收发管道）：qq-bridge 的 snowluma.httpUrl / wsUrl 指到 127.0.0.1:${config.bridge.port} 即可接管；说什么由 DSH 那头和桥的会话绑定决定`);
    }

    // 更新提示：后台查，查到有新版只说一句；查不到什么都不做
    void checkUpdate(config)
      .then(snapshot => {
        if (snapshot?.hasUpdate) log(`有新版本 ${snapshot.latest}（当前 ${VERSION}）：${snapshot.url}`);
      })
      .catch(() => {});

    ctx.inject(['webServer'], wc => {
      const webServer = wc.webServer;
      // 人工接管的转发多久前拉过一次：连点面板不该开出一堆转发进程
      let relayTriedAt = 0;
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
            const snap = channel ? channel.snapshot() : { ...DORMANT };
            const view = describeConfig(config);
            view.arklink.hasToken = Boolean(snap.hasToken ?? link.credential?.() ?? link.token);
            sendJson(res, 200, {
              ok: true,
              version: VERSION,
              // 哪种接法：session 自己投会话，bridge 交给 qq-bridge（世界控制台那张卡看的就是它）
              // dormant = 待命（选的是原桥那条线）
              mode: channelOn ? (bridgeMode ? 'bridge' : 'session') : 'dormant',
              config: view,
              channel: snap,
              manual: await describeManual({ home: expandHome(config.session.dshHome || '~/.dsh') }),
              update,
            });
            return;
          }

          // 两条线（哪个号、桥的上游指哪儿）：世界控制台那张 QQ 卡直接读它。
          // 只读文件 + 探活，不改任何东西。
          if (req.method === 'GET' && path === '/lines') {
            try {
              const lines = await describeLines({
                home: expandHome(config.session.dshHome || '~/.dsh'),
                config,
              });
              sendJson(res, 200, { ok: true, ...lines });
            } catch (error) {
              sendJson(res, 200, { ok: false, error: String(error?.message || error), lines: [] });
            }
            return;
          }

          // 人工接管：VM 的桌面搬进浏览器，watchdog 收录不到的界面（设备锁、验证页）
          // 靠人亲手点。这里只做一次跳转 —— 地址和 VNC 密码都在本机
          // ~/.dsh/arkhub/manual.json 里，界面、仓库、日志里都不出现。
          if (req.method === 'GET' && (path === '/manual' || path === '/manual.json')) {
            const home = expandHome(config.session.dshHome || '~/.dsh');
            const info = await describeManual({ home });
            if (path === '/manual.json') {
              sendJson(res, 200, { ok: true, ...info });
              return;
            }
            const manual = readManual(home);
            const redirect = () => {
              res.writeHead(302, { location: manual.url, 'cache-control': 'no-store' });
              res.end();
            };
            if (manual.configured && info.reachable) {
              redirect();
              return;
            }
            // 转发没起、而人配了拉起命令：顺手拉一次再跳（面板上点一下就该有画面）。
            // 5 秒内只拉一次 —— 连点不该开出一堆进程；起不来就退到说明页，不装作成功。
            if (manual.configured && manual.start.length && Date.now() - relayTriedAt > 5000) {
              relayTriedAt = Date.now();
              if (startRelay({ home, logger: log }).ok) {
                await new Promise(done => setTimeout(done, 1200));
                if ((await describeManual({ home })).reachable) {
                  redirect();
                  return;
                }
              }
            }
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(manualPage(info));
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
            if (path === '/manual/start') {
              // 转发没起时说明页上那个按钮走这里。命令只来自人自己写进 manual.json 的
              // start 数组，本进程不拼任何字符串；起不出来照实回原因。
              const result = startRelay({ home: expandHome(config.session.dshHome || '~/.dsh'), logger: log });
              sendJson(res, result.ok ? 200 : 400, result);
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
            if (path === '/lines') {
              const target = String(body.target ?? '').trim();
              if (!['vm', 'windows'].includes(target)) {
                sendJson(res, 400, { error: 'target 只能是 vm（门面）或 windows（原桥）' });
                return;
              }
              // 换线要改装配行 → DSH 会热重载本插件，这条 HTTP 连接多半活不到「做完」那一刻。
              // 所以先回「收了」，再把这件活交给独立进程：它的寿命不跟着插件走，插件重启它照样跑完。
              const home = expandHome(config.session.dshHome || '~/.dsh');
              sendJson(res, 202, { ok: true, accepted: true, target, log: lineSwitchLog(home) });
              // 谁点的写进日志：换线是「她突然换了个号说话」这类怪事的唯一解释来源，
              // 光有时间不够，还得知道是界面点的、还是别的什么东西打的接口。
              setTimeout(() => spawnLineSwitch(target, home, log, req.headers['user-agent']), 200);
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
              // 落盘：改的是内存里的 config，DSH 一重启就回到装配行的旧值。
              // 写不进去不拦响应（活着的那份照样生效），但要在回执和日志里说清楚。
              const saved = persistConfig({
                home: expandHome(config.session.dshHome || '~/.dsh'),
                config,
              });
              if (!saved.ok) log(`配置改动没能写回装配行：${saved.reason}`);
              sendJson(res, 200, { ok: true, config: describeConfig(config), persisted: saved.ok, persistError: saved.reason || '' });
              return;
            }
          }

          sendJson(res, 404, { error: 'not found', paths: ['/status', '/lines', '/manual', '/update', 'POST /lines', 'POST /mute', 'POST /config', 'POST /ingest', 'POST /manual/start'] });
        },
      };
      const unregister = webServer.register(route);
      wc.effect(() => () => unregister(), 'dsh-arkhub: route');
      log(`状态路由已挂在 /dsh-arkhub/status`);
    });

    log(`已装配：transport=${config.transport} ${link.label}，白名单 私聊${config.qq.allowPrivate.length}/群${config.qq.allowGroups.length}`);
  });
}
