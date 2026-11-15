/**
 * 「人工接管」（VM 桌面）的宿主侧逻辑：地址存哪、通没通、密码不外泄。
 *
 * 钉住四件事：
 *   1. 地址只在本机文件里（~/.dsh/arkhub/manual.json），面板拿到的那份描述里没有它
 *   2. 没配、配坏、端口没开，都只是「没接通」，不该抛错 —— 面板不能跟着挂
 *   3. 探活就是连端口：连上算活，不看对面说什么
 *   4. 说明页里不出现密码，只出现目标 host:port
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearManual,
  describeManual,
  manualFile,
  manualPage,
  probePort,
  readManual,
  startRelay,
  targetOf,
  writeManual,
} from '../lib/manual.js';

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-manual-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 占一个端口然后放掉，拿来当「没人应答」的地址。 */
function deadPort() {
  return new Promise(done => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function liveServer() {
  return new Promise(done => {
    const server = createServer((req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

test('targetOf：host:port 是唯一可靠的指纹', () => {
  assert.equal(targetOf('http://127.0.0.1:6080/vnc.html?password=x').text, '127.0.0.1:6080');
  assert.equal(targetOf('https://example.com/vnc').port, 443);
  assert.equal(targetOf('http://example.com/vnc').port, 80);
  assert.equal(targetOf('').text, '');
});

test('writeManual / readManual：只落本机文件，地址原样带回', () => {
  const f = tempHome();
  try {
    const file = writeManual(f.home, {
      url: 'http://127.0.0.1:6080/vnc.html?autoconnect=1&password=secret',
      label: '虚拟机画面',
      start: ['python', '-m', 'websockify', '6080', '127.0.0.1:5903'],
    });
    assert.equal(file, manualFile(f.home));
    assert.match(file.replace(/\\/g, '/'), /\/arkhub\/manual\.json$/);

    const manual = readManual(f.home);
    assert.equal(manual.configured, true);
    assert.match(manual.url, /password=secret/);
    assert.deepEqual(manual.start, ['python', '-m', 'websockify', '6080', '127.0.0.1:5903']);
  } finally {
    f.cleanup();
  }
});

test('writeManual：不是 http(s) 就拒绝（免得把一句命令当成地址存进去）', () => {
  const f = tempHome();
  try {
    assert.throws(() => writeManual(f.home, { url: 'vncviewer 127.0.0.1' }), /http/);
  } finally {
    f.cleanup();
  }
});

test('没配 / 配坏都只是「没接通」，不抛错', () => {
  const f = tempHome();
  try {
    const none = readManual(f.home);
    assert.equal(none.configured, false);
    assert.equal(none.reason, '');

    // 直接写文件（绕过 writeManual 的校验），模拟人手改坏的情况
    mkdirSync(join(f.home, 'arkhub'), { recursive: true });
    writeFileSync(manualFile(f.home), '{ 这不是 JSON', 'utf8');
    const broken = readManual(f.home);
    assert.equal(broken.configured, false);
    assert.match(broken.reason, /读不了/);

    // 地址不是 http(s)：也算没配，但要说得清为什么
    writeFileSync(manualFile(f.home), JSON.stringify({ vncUrl: 'not-a-url' }), 'utf8');
    assert.match(readManual(f.home).reason, /http/);
  } finally {
    f.cleanup();
  }
});

test('probePort：开着的连得上，关掉的连不上', async () => {
  const { server, port } = await liveServer();
  try {
    assert.equal(await probePort({ host: '127.0.0.1', port }), true);
  } finally {
    server.close();
  }
  const closed = await deadPort();
  assert.equal(await probePort({ host: '127.0.0.1', port: closed, timeoutMs: 400 }), false);
  assert.equal(await probePort({ host: '', port: 0 }), false);
});

test('describeManual：通没通、目标是谁，但绝不把地址（含密码）交给界面', async () => {
  const f = tempHome();
  const { server, port } = await liveServer();
  try {
    writeManual(f.home, { url: `http://127.0.0.1:${port}/vnc.html?password=secret`, label: '虚拟机画面' });
    const info = await describeManual({ home: f.home });
    assert.equal(info.configured, true);
    assert.equal(info.reachable, true);
    assert.equal(info.target, `127.0.0.1:${port}`);
    assert.equal(JSON.stringify(info).includes('secret'), false);
    assert.equal('url' in info, false);
  } finally {
    server.close();
    f.cleanup();
  }
});

test('describeManual：配了但没起，提示要起转发', async () => {
  const f = tempHome();
  try {
    const closed = await deadPort();
    writeManual(f.home, { url: `http://127.0.0.1:${closed}/vnc.html`, start: ['python', '-m', 'websockify'] });
    const info = await describeManual({ home: f.home });
    assert.equal(info.configured, true);
    assert.equal(info.reachable, false);
    assert.equal(info.canStart, true);
    assert.match(info.note, /转发|没起/);
  } finally {
    f.cleanup();
  }
});

test('manualPage：说明页里只有目标地址，没有密码；配了 start 才有那个按钮', () => {
  const withStart = manualPage({ configured: true, reachable: false, target: '127.0.0.1:6080', label: '虚拟机画面', canStart: true });
  assert.match(withStart, /127\.0\.0\.1:6080/);
  assert.match(withStart, /id="start"/);
  assert.equal(withStart.includes('password'), false);

  const without = manualPage({ configured: true, reachable: false, target: '127.0.0.1:6080', canStart: false });
  assert.equal(without.includes('id="start"'), false);
  assert.match(without, /websockify/);

  const unset = manualPage({ configured: false, reachable: false, reason: '' });
  assert.match(unset, /manual set/);
});

test('startRelay：没配命令就明说，不悄悄失败', () => {
  const f = tempHome();
  try {
    writeManual(f.home, { url: 'http://127.0.0.1:6080/vnc.html' });
    const result = startRelay({ home: f.home });
    assert.equal(result.ok, false);
    assert.match(result.reason, /start/);
  } finally {
    f.cleanup();
  }
});

test('clearManual：撤掉之后回到「没配」', () => {
  const f = tempHome();
  try {
    writeManual(f.home, { url: 'http://127.0.0.1:6080/vnc.html' });
    assert.equal(existsSync(manualFile(f.home)), true);
    clearManual(f.home);
    assert.equal(existsSync(manualFile(f.home)), false);
    assert.equal(readManual(f.home).configured, false);
    // 再撤一次不炸（幂等）
    clearManual(f.home);
  } finally {
    f.cleanup();
  }
});

test('manual.json 的写法：start 是数组（带空格的路径才拆得对）', () => {
  const f = tempHome();
  try {
    writeManual(f.home, { url: 'http://127.0.0.1:6080/vnc.html', start: ['C:\\Program Files\\x\\python.exe', '-m', 'websockify'] });
    const raw = JSON.parse(readFileSync(manualFile(f.home), 'utf8'));
    assert.deepEqual(raw.start, ['C:\\Program Files\\x\\python.exe', '-m', 'websockify']);
  } finally {
    f.cleanup();
  }
});
