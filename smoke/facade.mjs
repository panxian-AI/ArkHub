/**
 * 门面冒烟：验证「qq-bridge 会怎么跟我们说话」这一整套。
 *
 * 只读，不发 QQ 消息。跑法：node smoke/facade.mjs
 */

import { connect } from 'node:net';
import { normalizeConfig } from '../lib/config.js';
import { QqLink } from '../lib/arklink.js';
import { createFacade } from '../lib/facade.js';

const PORT = 3010;
const config = normalizeConfig({
  bridge: { enabled: true, port: PORT },
  qq: { accountUin: '123456789', allowGroups: ['987654321'] },
});
const log = (...args) => console.log('[facade]', ...args);
const link = new QqLink(config, log);
const facade = createFacade({ config, link, log });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[ok]' : '[!!]'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function action(name, body = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

/** 手搓一次 WebSocket 握手，读第一帧 —— 桥就是这么连上来的。 */
function wsProbe() {
  return new Promise(resolve => {
    const socket = connect(PORT, '127.0.0.1', () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let raw = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, detail: '3 秒内没收到完整帧' });
    }, 3000);
    socket.on('data', chunk => {
      raw = Buffer.concat([raw, chunk]);
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      if (!raw.slice(0, headerEnd).toString('latin1').includes('101')) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: false, detail: '握手没升级成功' });
        return;
      }
      const frame = raw.slice(headerEnd + 4);
      if (frame.length < 2) return;
      // 帧头长度分三档：<126 两字节、<65536 四字节、否则十字节
      let len = frame[1] & 0x7f;
      let start = 2;
      if (len === 126) {
        if (frame.length < 4) return;
        len = frame.readUInt16BE(2);
        start = 4;
      } else if (len === 127) {
        if (frame.length < 10) return;
        len = Number(frame.readBigUInt64BE(2));
        start = 10;
      }
      if (frame.length < start + len) return; // 帧还没到齐
      clearTimeout(timer);
      socket.destroy();
      try {
        const event = JSON.parse(frame.slice(start, start + len).toString('utf8'));
        resolve({ ok: event.post_type === 'meta_event', detail: `首帧 ${event.post_type}/${event.meta_event_type}` });
      } catch (error) {
        resolve({ ok: false, detail: `首帧不是 JSON：${error.message}` });
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
  });
}

try {
  await facade.start();
  const snap = facade.snapshot();
  check('门面已监听', snap.running === true, `127.0.0.1:${snap.port}`);
  check('账号识别', String(snap.account) === '123456789', `uin=${snap.account}`);

  const login = await action('get_login_info');
  check('get_login_info', login.status === 'ok' && login.data.user_id === 123456789, JSON.stringify(login.data));

  const status = await action('get_status');
  check('get_status', status.status === 'ok' && status.data.online === true);

  const groups = await action('get_group_list');
  check('get_group_list', groups.status === 'ok' && groups.data.length === 1, JSON.stringify(groups.data));

  const version = await action('get_version_info');
  check('get_version_info', version.data.protocol_version === 'v11', version.data.app_name);

  const unknown = await action('set_group_card', { group_id: 1 });
  check('不认识的动作回 1404（让桥降级，不是崩）', unknown.retcode === 1404);

  const ws = await wsProbe();
  check('WebSocket 握手 + 首帧心跳', ws.ok, ws.detail);

  const home = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  check('GET / 能看到自检信息', home.data?.app === 'arkhub-onebot', `events=${home.data?.events} sent=${home.data?.sent}`);
} catch (error) {
  check('冒烟过程没抛异常', false, String(error?.message || error));
} finally {
  facade.stop();
  const failed = results.filter(one => !one.ok);
  console.log(`\n${failed.length ? `${failed.length} 项没过` : '全部通过'}`);
  process.exit(failed.length ? 1 : 0);
}
