#!/usr/bin/env node
/**
 * 给 dsh-world 的世界控制台补一个「用哪个号（哪条线）」的选择器。
 *
 * 为什么要打补丁而不是让它自己长出来：世界控制台是 dsh-world 的客户端模块，
 * 装在 node_modules 里，没有对外暴露「往 QQ 卡上再加一行」的接口。这个补丁只做三件事：
 *
 *   1. 宿主侧路由 /dsh-world/qq/lines：把请求转给 dsh-arkhub 的 /dsh-arkhub/lines
 *      （换线的逻辑全在 dsh-arkhub 里，dsh-world 只当门房，不复制判断）
 *   2. 客户端 QQ 卡上一行按钮：两条线、各自活没活、现在用哪条，点一下换过去
 *   3. 什么都不改：不动桥自己的配置、不动 sessions、不加权限
 *
 * dsh-world 升级会把这些改动冲掉 —— 冲掉之后再跑一次这条命令就行，补丁是幂等的。
 *
 * 用法：
 *   node tools/dsh-world-patch/apply.mjs           装上/确认（默认 profile 自动挑）
 *   node tools/dsh-world-patch/apply.mjs --check   只看现在装了没
 *   --home <路径> / --profile <名字>               指定 DSH 根目录 / profile
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { dshHome, pickProfile } from '../../lib/dsh-home.js';

/** 补丁标记：看到它就说明这一段已经加过了（幂等的依据）。 */
const MARK = 'dsh-arkhub:lines';

const ROUTE_GET = `
                // ${MARK} —— 两条线（哪个号、桥的上游指哪儿）交给 dsh-arkhub 回答。
                // 这里只当门房：换线的逻辑全在插件里，dsh-world 不复制任何判断。
                if (req.method === 'GET' && path === '/lines') {
                    const base = String(origin?.() ?? '').replace(/\\/+$/, '');
                    if (!base) {
                        sendJson(res, { status: 503, body: { error: '不知道 DSH 自己的地址' } });
                        return;
                    }
                    try {
                        const response = await fetch(\`\${base}/dsh-arkhub/lines\`, { signal: AbortSignal.timeout(6000) });
                        const body = await response.json().catch(() => null);
                        if (!body || typeof body !== 'object') {
                            sendJson(res, { status: 502, body: { error: 'dsh-arkhub 的回话不是 JSON' } });
                            return;
                        }
                        sendJson(res, { status: 200, body });
                    }
                    catch {
                        // 插件没装、没起来、正在换线重启 —— 都不是错误，是「现在没有可选项」
                        sendJson(res, { status: 200, body: { ok: false, lines: [], error: 'dsh-arkhub 没响应' } });
                    }
                    return;
                }
`;

const ROUTE_POST = `        case '/lines': {
            if (!origin)
                return bad('不知道 DSH 自己的地址');
            const target = body?.target === 'vm' ? 'vm' : body?.target === 'windows' ? 'windows' : '';
            if (target === '')
                return bad('target 只能是 vm 或 windows');
            const base = String(origin()).replace(/\\/+$/, '');
            try {
                const response = await fetch(\`\${base}/dsh-arkhub/lines\`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-dsh-arkhub': '1' },
                    body: JSON.stringify({ target }),
                    signal: AbortSignal.timeout(8000),
                });
                const answer = await response.json().catch(() => ({}));
                if (!response.ok)
                    return { status: response.status, body: answer };
                return ok(answer);
            }
            catch (error) {
                return { status: 502, body: { error: \`dsh-arkhub 没响应：\${error instanceof Error ? error.message : String(error)}\` } };
            }
        }
`;

const CLIENT_STATE = `
      // ${MARK} —— 两条线：哪个号在说话、桥的上游从哪儿取协议。
      // 数据和换线都问 dsh-arkhub（宿主侧 /dsh-world/qq/lines 是个门房），这里只负责画。
      var linesState = useState(null), lines = linesState[0], setLines = linesState[1]
      var pickState = useState(''), picking = pickState[0], setPicking = pickState[1]
      function loadLines() {
        qqGet('lines').then(function (r) {
          if (r && Array.isArray(r.lines)) setLines(r)
        }, function () { setLines({ lines: [], error: '读不到' }) })
      }
      useEffect(function () { loadLines() }, [])
      function pickLine(line) {
        if (picking) return
        setPicking(line.id); setMsg('')
        qqPost('lines', { target: line.id }).then(function () {
          setMsg('正在切到「' + line.label + '」，桥会重启，十几秒…')
          var tries = 0
          var timer = setInterval(function () {
            tries += 1
            qqGet('lines').then(function (r) {
              if (r && Array.isArray(r.lines)) setLines(r)
              if (r && r.current === line.id) {
                clearInterval(timer); setPicking(''); setMsg('已切到「' + line.label + '」')
                if (props.onSaved) props.onSaved()
              } else if (tries > 20) {
                clearInterval(timer); setPicking('')
                setMsg('还没切过来：看 ~/.dsh/arkhub/line-switch.log')
              }
            }, function () {})
          }, 1500)
        }, function (e) {
          setPicking(''); setMsg('失败：' + ((e && e.message) || e))
        })
      }
`;

const CLIENT_VIEW = `        // ${MARK} —— 用哪个号。一条线 = 一个号 + 桥的上游；点一下两条一起换。
        h('div', { key: 'l', className: 'dw-setting' },
          h('div', { className: 'dw-muted', style: { marginBottom: 6 } }, '用哪个号（桥的上游跟着换）'),
          list(lines && lines.lines).map(function (line) {
            var active = line.current === true
            var off = line.available === false
            return h('button', {
              key: line.id,
              className: 'dw-btn',
              disabled: busy || Boolean(picking) || active || off,
              title: line.note || '',
              style: { marginRight: 8, marginBottom: 6, opacity: off ? .45 : 1 },
              onClick: function () { pickLine(line) }
            }, (active ? '✓ ' : '') + (line.label || line.title) + (line.alive ? '' : off ? '' : '（没连上）'))
          }),
          lines && lines.error ? h('span', { className: 'dw-muted' }, ' · ' + lines.error) : null,
          picking ? h('span', { className: 'dw-muted' }, ' · 切换中…') : null),
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function patchFile(file, edits, { apply }) {
  if (!existsSync(file)) return { file, missing: true, changed: false };
  const before = readFileSync(file, 'utf8');
  let after = before;
  const notes = [];
  // 行尾自适应：锚点串都是 \n 写的，可 0.7.5 的 client 是 CRLF —— 锚点命中不该看行尾脸色。
  const newline = after.includes('\r\n') ? '\r\n' : '\n';
  const adapt = text => text.replace(/\r\n/g, '\n').replace(/\n/g, newline);
  for (const edit of edits) {
    const variants = edit.variants ?? [{ find: edit.find, replace: edit.replace }];
    // 「已装」的判定：显式 marker，或任何一个 variant 的替换结果已经在文件里。
    // （npm 版和自带版的替换结果不一样，只认一个 marker 会对另一版重复打、然后报锚点丢失。）
    const markers = [...(edit.markers ?? (edit.marker ? [edit.marker] : [])), ...variants.map(one => one.replace)];
    if (markers.some(marker => after.includes(adapt(marker)))) {
      notes.push('已装');
      continue;
    }
    // 锚点按代际给候选（dsh-world 0.5.x 是 DSH 自带的一份、0.6.4+ 才上 npm，函数签名
    // 不一样；0.7.x 又把 worldPrefix 加进了第一个参数）。哪个候选在文件里找得到用哪个。
    const hit = variants.find(one => after.includes(adapt(one.find)));
    if (!hit) {
      notes.push(`找不到锚点：${edit.label}`);
      continue;
    }
    after = after.replace(adapt(hit.find), adapt(hit.replace));
    notes.push(`+ ${edit.label}`);
  }
  const changed = after !== before;
  // 原件留一份：dsh-world 升级把它盖掉之后，至少还能看出原来长什么样
  if (changed && apply) {
    const orig = `${file}.dsh-arkhub.orig`;
    if (!existsSync(orig)) copyFileSync(file, orig);
    writeFileSync(file, after, 'utf8');
  }
  return { file, changed, notes };
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const flag = name => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : '';
  };
  const home = flag('home') ? resolve(flag('home')) : dshHome();
  const wanted = flag('profile');
  const picked = pickProfile(home, wanted);
  if (!picked?.profile) fail(picked?.reason || '没找到 DSH profile');

  const pkg = join(picked.profile.dir, 'node_modules', 'dsh-world');
  if (!existsSync(pkg)) fail(`这个 profile 里没装 dsh-world：${pkg}`);

  const version = (() => {
    try { return JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version; } catch { return '?'; }
  })();

  const results = [
    patchFile(join(pkg, 'lib', 'ecosystem', 'qq', 'route.js'), [
      {
        label: '宿主：qqRoute 多接一个 origin',
        marker: "export function qqRoute(qq, allowedHosts = [], doors, origin = () => '') {",
        variants: [
          // 0.5.x（DSH 自带的那份）：第一个参数是 qq
          {
            find: 'export function qqRoute(qq, allowedHosts = [], doors) {',
            replace: 'export function qqRoute(qq, allowedHosts = [], doors, origin = () => \'\') {',
          },
          // 0.6.x（npm）：没有 qq，多一对 native/setNative
          {
            find: 'export function qqRoute(allowedHosts = [], doors, native, setNative) {',
            replace: 'export function qqRoute(allowedHosts = [], doors, native, setNative, origin = () => \'\') {',
          },
          // 0.7.x（npm）：最前面又多了一个 worldPrefix
          {
            find: 'export function qqRoute(worldPrefix, allowedHosts = [], doors, native, setNative) {',
            replace: 'export function qqRoute(worldPrefix, allowedHosts = [], doors, native, setNative, origin = () => \'\') {',
          },
        ],
      },
      {
        label: '宿主：write() 多接一个 origin',
        marker: 'async function write(qq, doors, path, body, origin) {',
        variants: [
          {
            find: 'async function write(qq, doors, path, body) {',
            replace: 'async function write(qq, doors, path, body, origin) {',
          },
          {
            find: 'async function write(doors, path, body, setNative) {',
            replace: 'async function write(doors, path, body, setNative, origin) {',
          },
        ],
      },
      {
        label: '宿主：GET /lines',
        marker: `${MARK} —— 两条线`,
        find: '                if (req.method !== \'POST\') {',
        replace: `${ROUTE_GET.trimEnd()}\n                if (req.method !== 'POST') {`,
      },
      {
        label: '宿主：POST /lines',
        marker: "return bad('不知道 DSH 自己的地址');",
        variants: [
          // 0.5.x：write() 的分支里有 /bind 可锚
          {
            find: '        case \'/bind\': {',
            replace: `${ROUTE_POST.trimEnd()}\n        case '/bind': {`,
          },
          // 0.6.x / 0.7.x（npm）：没有 /bind，锚在收尾的 default 前面
          {
            find: '        default: return undefined;',
            replace: `${ROUTE_POST.trimEnd()}\n        default: return undefined;`,
          },
        ],
      },
      {
        label: '宿主：把 origin 传进 write()',
        marker: 'const result = await write(qq, doors, path, body, origin);',
        variants: [
          {
            find: 'const result = await write(qq, doors, path, body);',
            replace: 'const result = await write(qq, doors, path, body, origin);',
          },
          {
            find: 'const result = await write(doors, path, body, setNative);',
            replace: 'const result = await write(doors, path, body, setNative, origin);',
          },
        ],
      },
    ], { apply: !check }),
    patchFile(join(pkg, 'lib', 'index.js'), [
      {
        label: '宿主：注册路由时给出自己的地址',
        marker: 'qqRoute(service, config.allowedHosts, doors, () => host.origin())',
        variants: [
          // 0.5.x：注册时还带着 service
          {
            find: 'unregisterQq = webServer.register(qqRoute(service, config.allowedHosts, doors));',
            replace: 'unregisterQq = webServer.register(qqRoute(service, config.allowedHosts, doors, () => host.origin()));',
          },
          // 0.6.x / 0.7.x（npm）：注册时带 native / setNative，origin 追在最后
          // （host 在同一作用域里更靠后定义，回调是收请求时才跑，不踩暂时性死区）
          {
            find: 'webServer.register(qqRoute(config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => qqNative?.update(patch) ?? null));',
            replace: 'webServer.register(qqRoute(config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => qqNative?.update(patch) ?? null, () => host.origin()));',
          },
          {
            find: 'webServer.register(qqRoute(prefix, config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => qqNative?.update(patch) ?? null));',
            replace: 'webServer.register(qqRoute(prefix, config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => qqNative?.update(patch) ?? null, () => host.origin()));',
          },
        ],
      },
    ], { apply: !check }),
    patchFile(join(pkg, 'client', 'index.js'), [
      {
        label: '界面：状态与换线动作',
        markers: [`${MARK}:state`],
        variants: [
          // 0.5.x：Qq 先取 props.qq
          {
            find: '    function Qq(props) {\n      var qq = props.qq || {}',
            replace: `    function Qq(props) {\n      var qq = props.qq || {}${CLIENT_STATE.replace(MARK, `${MARK}:state`)}`,
          },
          // 0.6.x / 0.7.x（npm）：Qq 直接从 busyState 开头
          {
            find: '    function Qq(props) {\n      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]',
            replace: `    function Qq(props) {\n      var busyState = useState(false), busy = busyState[0], setBusy = busyState[1]${CLIENT_STATE.replace(MARK, `${MARK}:state`)}`,
          },
        ],
      },
      {
        label: '界面：QQ 卡上的选择器',
        marker: `${MARK}:view`,
        find: '        h(\'div\', { key: \'k\', className: \'dw-setting\' },',
        replace: `${CLIENT_VIEW.replace(MARK, `${MARK}:view`).trimEnd()}\n        h('div', { key: 'k', className: 'dw-setting' },`,
      },
    ], { apply: !check }),
  ];

  let bad = 0;
  let done = 0;
  let total = 0;
  for (const one of results) {
    if (one.missing) {
      console.log(`✗ 缺文件：${one.file}`);
      bad += 1;
      continue;
    }
    const anchorsLost = one.notes.some(note => note.startsWith('找不到锚点'));
    const state = anchorsLost ? '✗' : one.changed ? '+' : '·';
    if (anchorsLost) bad += 1;
    total += one.notes.length;
    done += one.notes.filter(note => note === '已装').length;
    console.log(`${state} ${one.file.replace(pkg, 'dsh-world')}  ${one.notes.join('，')}`);
  }

  if (check) {
    console.log(bad
      ? `\n有补不上的地方（dsh-world ${version} 可能改过结构），上面标 ✗ 的就是`
      : `\ndsh-world ${version}：${done}/${total} 段已装${done < total ? '（跑一次不带 --check 的命令装上）' : ''}`);
    process.exit(bad ? 1 : 0);
  }

  console.log(bad
    ? `\n补了一半（dsh-world ${version}）。标 ✗ 的地方要人工看一眼，其余已经装好。`
    : `\n装好了（dsh-world ${version}）。重启 DSH 后，设置 → 世界控制台 → QQ 卡上会多一行「用哪个号」。`);
  process.exit(bad ? 1 : 0);
}

main();
