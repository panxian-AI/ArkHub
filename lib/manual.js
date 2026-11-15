/**
 * 「人工接管」：把 VM 的桌面接到人眼前。
 *
 * 有些界面 watchdog 永远收录不全 —— 设备锁、新版验证页、风控提示、QQ 自己的更新弹窗。
 * 这些只能让人亲手点。做法是在 VM 里跑 x11vnc（绑 :99），宿主侧起一个 web 转发
 * （websockify + noVNC），浏览器里就是一个能点能敲的窗口。
 *
 * 本插件不搬画面，只做两件小事：
 *   1. 记住人配的地址：~/.dsh/arkhub/manual.json（本机文件，不进仓库 —— 地址里通常带
 *      VNC 密码，那东西只该待在这台机器上，界面和仓库里都不出现）
 *   2. /dsh-arkhub/manual 一跳：转发在跑就 302 过去；没配/没跑就给一张说明页，
 *      配了 start 的话页面上有个按钮能当场把转发拉起来
 *
 * 面板（世界控制台 QQ 卡）上那个按钮就指向这个跳转地址，于是点一下就开画面。
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

/** 探活给短超时：控制台一张卡片不该为了一个没开的端口等半天。 */
const PROBE_MS = 700;

/** 本机文件，不进仓库。 */
export function manualFile(home) {
  return join(home, 'arkhub', 'manual.json');
}

/**
 * 读人配的那份地址。没配、配坏了都只是「没有」——不该让面板跟着报错。
 */
export function readManual(home) {
  const file = manualFile(home);
  if (!existsSync(file)) return { file, configured: false, reason: '', start: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const url = String(raw?.vncUrl ?? raw?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { file, configured: false, reason: 'manual.json 里的 vncUrl 不是 http(s) 地址', start: [] };
    }
    return {
      file,
      configured: true,
      url,
      label: String(raw.label || '虚拟机画面'),
      note: String(raw.note || ''),
      start: Array.isArray(raw.start) ? raw.start.map(String).filter(Boolean) : [],
    };
  } catch (error) {
    return { file, configured: false, reason: `manual.json 读不了：${error?.message || error}`, start: [] };
  }
}

/** 写一份（CLI 用）。地址里有密码，文件权限按 600 给。 */
export function writeManual(home, { url, label = '虚拟机画面', note = '', start = [] } = {}) {
  const text = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(text)) throw new Error('地址要以 http:// 或 https:// 开头');
  const file = manualFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const body = { vncUrl: text, label, note, start: Array.isArray(start) ? start : [] };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows 上不认这个，无所谓：它本来也只在用户自己的目录里 */
  }
  return file;
}

export function clearManual(home) {
  const file = manualFile(home);
  if (existsSync(file)) rmSync(file, { force: true });
  return file;
}

/** `http://127.0.0.1:6080/vnc.html?...` → 127.0.0.1:6080。端口是唯一可靠的指纹。 */
export function targetOf(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    return { host: parsed.hostname, port, text: `${parsed.hostname}:${port}` };
  } catch {
    return { host: '', port: 0, text: '' };
  }
}

/** TCP 探活：开没开。连上就算活，不看它说什么（noVNC 的首页没什么好看的）。 */
export function probePort({ host, port, timeoutMs = PROBE_MS } = {}) {
  if (!host || !port) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * 给面板/状态用的一份描述。
 * 注意：url 不在这里返回 —— 它通常带着 VNC 密码，界面只需要知道「配了没、通没通」。
 */
export async function describeManual({ home }) {
  const manual = readManual(home);
  const target = targetOf(manual.url);
  const reachable = manual.configured ? await probePort(target) : false;
  return {
    configured: manual.configured,
    reachable,
    target: target.text,
    label: manual.label || '虚拟机画面',
    note: manual.configured
      ? manual.note || (reachable ? '就绪：点开就是 VM 的桌面，鼠标键盘直通' : '本机转发没在跑（端口没应答，点开有说明）')
      : manual.reason || '还没配置：dsh-arkhub manual set <VNC 地址>',
    canStart: manual.start.length > 0,
  };
}

/**
 * 起本机转发（manual.json 里配的 start 命令，例如 websockify 那句）。
 *
 * 独立进程、脱离本进程：它得活过插件重启，也不该被 DSH 退出带走。
 * 只有本机 POST（带 x-dsh-arkhub 头）能触发，命令也只来自人自己写的那份文件。
 */
export function startRelay({ home, logger = console } = {}) {
  const manual = readManual(home);
  if (!manual.configured || !manual.start.length) {
    return { ok: false, reason: 'manual.json 里没配 start 命令' };
  }
  const [cmd, ...args] = manual.start;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    logger.log?.(`人工接管：已拉起本机转发 ${cmd} ${args.join(' ')}`.trim());
    return { ok: true, command: [cmd, ...args].join(' ') };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

const esc = text => String(text ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

/**
 * 没接通时给人看的那张页。
 * 不写命令细节以外的任何东西：密码不出现在这里（它只在 manual.json 里）。
 */
export function manualPage(info) {
  const rows = [];
  if (!info.configured) {
    rows.push(`<p>还没配置。在这台机器上跑一次（地址里带 VNC 密码，只会写进本机文件）：</p>
      <pre>dsh-arkhub manual set "http://127.0.0.1:6080/vnc.html?autoconnect=1&amp;resize=scale&amp;password=你的VNC密码"</pre>`);
  } else if (!info.reachable) {
    rows.push(`<p>地址配好了（<code>${esc(info.target)}</code>），但那个端口没人应答 —— 本机转发没在跑。</p>`);
    if (info.canStart) {
      rows.push('<p><button id="start">启动本机转发</button><span id="tip"></span></p>');
    } else {
      rows.push(`<p>手动起一下转发（VM 里的 x11vnc 要活着，宿主 NAT 一般把 5903 转到 VM 的 5900）：</p>
        <pre>websockify 6080 127.0.0.1:5903 --web &lt;noVNC 目录&gt;</pre>
        <p>想让这个按钮自己起，就把命令写进 <code>manual.json</code> 的 <code>start</code>（数组形式）。</p>`);
    }
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.label || '虚拟机画面')}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1d2129; }
  main { width: min(640px, calc(100vw - 48px)); background: #fff; border: 1px solid #e5e6eb;
         border-radius: 14px; padding: 26px 28px; box-shadow: 0 8px 28px rgba(0,0,0,.06); }
  h1 { font-size: 18px; margin: 0 0 14px; }
  p { margin: 10px 0; color: #4e5969; }
  code, pre { font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  code { background: #f2f3f5; padding: 1px 5px; border-radius: 4px; }
  pre { background: #f2f3f5; padding: 10px 12px; border-radius: 8px; overflow-x: auto; color: #1d2129; }
  button { font: inherit; padding: 7px 16px; border-radius: 8px; border: 1px solid #165dff;
           background: #165dff; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .tip { margin-left: 10px; color: #86909c; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    body { background: #17171a; color: #e8e8ea; }
    main { background: #1f1f23; border-color: #2e2e33; box-shadow: none; }
    p { color: #a9a9b2; }
    code, pre { background: #26262b; color: #e8e8ea; }
  }
</style></head>
<body><main>
<h1>${esc(info.label || '虚拟机画面')}：还没接通</h1>
${rows.join('\n')}
<p class="tip">VM 那边的 x11vnc 由 <code>tools/vm-manual/install.sh</code> 装（systemd 自启，绑 :99）。</p>
</main>
<script>
  var button = document.getElementById('start');
  var tip = document.getElementById('tip');
  if (button) button.addEventListener('click', function () {
    button.disabled = true;
    tip.textContent = ' 正在起…';
    fetch('/dsh-arkhub/manual/start', { method: 'POST', headers: { 'x-dsh-arkhub': '1' } })
      .then(function (r) { return r.json() })
      .then(function (body) {
        if (!body || !body.ok) throw new Error((body && body.reason) || '没起来');
        setTimeout(function () { location.reload() }, 2200);
      })
      .catch(function (e) { button.disabled = false; tip.textContent = ' 失败：' + (e.message || e) });
  });
</script>
</body></html>`;
}
