/**
 * /dsh-arkhub/manual 这条路由的端到端行为：插件照常装配，只是宿主换成假的。
 *
 * 钉住三件事（这三件错了面板就会点不开，或者把密码漏出去）：
 *   1. 转发在跑 -> 302 到真地址（地址里的密码只在这一次跳转里出现）
 *   2. 转发没跑且没配拉起命令 -> 503 + 说明页，页面里没有密码
 *   3. /manual.json 只给「配了没、通没通、host:port」，不返回 url
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { writeManual } from '../lib/manual.js';

/** 把插件装到假宿主上，拿回那条 /dsh-arkhub 路由的 handler。 */
function mount(home) {
  let handler = null;
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => {},
    inject(names, callback) {
      if (names.includes('sessionController')) {
        callback({ sessionController: { open: () => {} } });
        return;
      }
      if (names.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              handler = route.handler;
              return () => {};
            },
          },
          effect: () => {},
        });
      }
    },
  };
  // channel 关着（待命）：不起通道、不连 ArkLink，只留路由
  apply(ctx, {
    enabled: true,
    channel: { enabled: false },
    session: { dshHome: home, worldId: 'w' },
    qq: { accountUin: '123456789' },
  });
  assert.ok(handler, '路由没注册上');
  return async url => {
    const out = { status: 0, headers: {}, body: '' };
    await handler(
      { method: 'GET', url, headers: { host: '127.0.0.1:1234' } },
      {
        writeHead(status, headers) {
          out.status = status;
          Object.assign(out.headers, headers || {});
        },
        end(body) {
          out.body = body === undefined ? '' : String(body);
        },
      },
    );
    return out;
  };
}

test('转发在跑：302 到真地址', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-route-'));
  const server = createServer((req, res) => res.end('ok'));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/vnc.html?autoconnect=1&password=secret`;
    writeManual(home, { url, label: '虚拟机画面' });
    const call = mount(home);
    const res = await call('/dsh-arkhub/manual');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, url);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('转发没跑：503 + 说明页，页里没有密码', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-route-'));
  const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const deadPort = probe.address().port;
  await new Promise(done => probe.close(done));
  try {
    writeManual(home, { url: `http://127.0.0.1:${deadPort}/vnc.html?password=secret` });
    const call = mount(home);
    const res = await call('/dsh-arkhub/manual');
    assert.equal(res.status, 503);
    assert.match(res.body, /还没接通/);
    assert.equal(res.body.includes('secret'), false);
    assert.match(res.headers['content-type'], /text\/html/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('/manual.json：只给描述，不给 url', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-route-'));
  try {
    writeManual(home, { url: 'http://127.0.0.1:1/vnc.html?password=secret' });
    const call = mount(home);
    const res = await call('/dsh-arkhub/manual.json');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.configured, true);
    assert.equal(body.reachable, false);
    assert.equal('url' in body, false);
    assert.equal(res.body.includes('secret'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('没配：也是 503 + 说明页（告诉人怎么配），不是 500', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-route-'));
  try {
    const call = mount(home);
    const res = await call('/dsh-arkhub/manual');
    assert.equal(res.status, 503);
    assert.match(res.body, /manual set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
