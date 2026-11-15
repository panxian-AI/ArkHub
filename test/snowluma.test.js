import assert from 'node:assert/strict';
import test from 'node:test';

import { SnowLuma } from '../lib/snowluma.js';
import { itemFromEvent } from '../lib/onebot.js';
import { richSegments } from '../lib/facade.js';

const quiet = () => {};

test('没配 wsUrl 就当没开，不会去连', () => {
  const snow = new SnowLuma({ httpUrl: 'http://127.0.0.1:3102' }, quiet);
  assert.equal(snow.enabled, false);
  snow.start();
  assert.equal(snow.connected, false);
  assert.equal(snow.socket, null);
});

test('快照带齐排障要看的字段，token 不外泄', () => {
  const snow = new SnowLuma(
    { httpUrl: 'http://127.0.0.1:3102/', wsUrl: 'ws://127.0.0.1:3101', httpToken: 'secret-token' },
    quiet,
  );
  const snap = snow.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.connected, false);
  assert.equal(snap.httpUrl, 'http://127.0.0.1:3102');
  assert.equal(snap.wsUrl, 'ws://127.0.0.1:3101');
  assert.equal(JSON.stringify(snap).includes('secret-token'), false);
});

test('同一条消息只放一次（重连后 SnowLuma 会重放最近事件）', () => {
  const snow = new SnowLuma({ wsUrl: 'ws://127.0.0.1:3101' }, quiet);
  const event = { post_type: 'message', message_type: 'group', group_id: 1, user_id: 2, message_id: 99 };
  assert.equal(snow.fresh(event), true);
  assert.equal(snow.fresh(event), false);
  // 没有 message_id 的事件不参与去重（ArkLink 那条上游就给不出 id）
  assert.equal(snow.fresh({ post_type: 'message', message_type: 'private', user_id: 2 }), true);
  assert.equal(snow.fresh({ post_type: 'message', message_type: 'private', user_id: 2 }), true);
});

test('动作失败要把 SnowLuma 的原话抛出来，别吞成「发送失败」', async () => {
  const snow = new SnowLuma({ httpUrl: 'http://127.0.0.1:3102', wsUrl: 'ws://127.0.0.1:3101' }, quiet);
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    text: async () => JSON.stringify({ status: 'failed', retcode: 100, data: null, wording: '群里没有这个成员' }),
  });
  try {
    await assert.rejects(() => snow.callAction('send_group_msg', { group_id: 1, message: [] }), /群里没有这个成员/);
  } finally {
    globalThis.fetch = original;
  }
});

test('动作成功返回 data，请求带 Bearer 与 JSON body', async () => {
  const snow = new SnowLuma(
    { httpUrl: 'http://127.0.0.1:3102', wsUrl: 'ws://127.0.0.1:3101', httpToken: 'tk' },
    quiet,
  );
  const original = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 } }) };
  };
  try {
    const data = await snow.callAction('send_group_msg', { group_id: 1, message: [{ type: 'text', data: { text: 'hi' } }] });
    assert.deepEqual(data, { message_id: 7 });
    assert.equal(seen.url, 'http://127.0.0.1:3102/send_group_msg');
    assert.equal(seen.init.headers.authorization, 'Bearer tk');
    assert.equal(JSON.parse(seen.init.body).group_id, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('OneBot 事件转成 ArkLink 那种 item：群私聊判定、对端、发言人都对得上', () => {
  const group = itemFromEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 200010001,
    user_id: 3889045760,
    message_id: 12,
    time: 1794712000,
    raw_message: '早上好',
    message: [{ type: 'text', data: { text: '早上好' } }],
    sender: { nickname: '伊蕾娜', card: '' },
  });
  assert.equal(group.chat_type, 2);
  assert.equal(group.peer_uid, '200010001');
  assert.equal(group.sender_uid, '3889045760');
  assert.equal(group.sender_name, '伊蕾娜');
  assert.equal(group.text, '早上好');
  assert.equal(group.id, 'ob:group:200010001:12');

  const priv = itemFromEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 100010001,
    message_id: 13,
    message: [{ type: 'text', data: { text: '在吗' } }],
  });
  assert.equal(priv.chat_type, 1);
  assert.equal(priv.peer_uid, '100010001');
  assert.equal(priv.text, '在吗');

  assert.equal(itemFromEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null);
  assert.equal(itemFromEvent({ post_type: 'message', message_type: 'group', message_id: 1 }), null);
});

test('消息段原样留着：语音和引用不能被塌成文本', () => {
  const item = itemFromEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 2,
    message_id: 3,
    message: [
      { type: 'reply', data: { id: '4567' } },
      { type: 'record', data: { file: 'abc.amr' } },
      { type: 'text', data: { text: '听这个' } },
    ],
  });
  assert.deepEqual(item.segments.map(one => one.type), ['reply', 'record', 'text']);
});

test('richSegments 只把 ArkLink 做不到的段挑出来', () => {
  assert.deepEqual(richSegments({ message: [{ type: 'text', data: { text: 'hi' } }] }), []);
  assert.deepEqual(
    richSegments({ message: [{ type: 'text', data: {} }, { type: 'at', data: { qq: 1 } }] }),
    [],
  );
  assert.deepEqual(
    richSegments({ message: [{ type: 'reply', data: { id: 1 } }, { type: 'record', data: {} }, { type: 'image', data: {} }] }),
    ['reply', 'record', 'image'],
  );
  assert.deepEqual(richSegments({ message: 'CQ 码字符串不管' }), []);
});
