/**
 * OneBot 这一层的翻译必须逐字段对齐 —— 字段名错一个，桥就会把私聊当群聊、
 * 把消息发到错的人那里，而且界面上一切看起来正常。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { heartbeat, messageToText, sendRequest, sendResponse, toEvent } from '../lib/onebot.js';

test('私聊消息翻译成 OneBot 的 private 事件', () => {
  const event = toEvent({ chat_type: 1, sender_uid: '10001', sender_name: '张三', text: '在吗', id: 'm1', ts: 100 }, '123456789');
  assert.equal(event.post_type, 'message');
  assert.equal(event.message_type, 'private');
  assert.equal(event.sub_type, 'friend');
  assert.equal(event.user_id, 10001);
  assert.equal(event.self_id, 123456789);
  assert.equal(event.raw_message, '在吗');
  assert.deepEqual(event.message, [{ type: 'text', data: { text: '在吗' } }]);
  assert.equal(event.group_id, undefined);
});

test('群消息带上 group_id，且不把群号当发送者', () => {
  const event = toEvent({ chat_type: 2, sender_uid: '10001', peer_uid: '20002', sender_name: '张三', text: '大家好' }, '123456789');
  assert.equal(event.message_type, 'group');
  assert.equal(event.sub_type, 'normal');
  assert.equal(event.group_id, 20002);
  assert.equal(event.user_id, 10001);
  assert.equal(event.sender.nickname, '张三');
});

test('既没有 QQ 也没有群号的消息直接丢掉', () => {
  assert.equal(toEvent({ chat_type: 2, text: 'x' }), null);
  assert.equal(toEvent(null), null);
});

test('send_group_msg 翻译成 ArkLink 的群发', () => {
  const out = sendRequest('send_group_msg', { group_id: 987654321, message: '早' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.body, { to: '987654321', text: '早', group: true });
});

test('send_private_msg 翻译成私聊，不带 group', () => {
  const out = sendRequest('send_private_msg', { user_id: 123456789, message: '早' });
  assert.deepEqual(out.body, { to: '123456789', text: '早' });
});

test('send_msg 按有没有 group_id 判断私聊还是群', () => {
  assert.equal(sendRequest('send_msg', { group_id: 1, message: 'a' }).body.group, true);
  assert.equal(sendRequest('send_msg', { user_id: 2, message: 'a' }).body.group, undefined);
});

test('消息段数组要拼成纯文本；空消息不发送', () => {
  assert.equal(messageToText([{ type: 'text', data: { text: '你' } }, { type: 'text', data: { text: '好' } }]), '你好');
  assert.equal(sendRequest('send_private_msg', { user_id: 1, message: '   ' }).ok, false);
  assert.equal(sendRequest('send_private_msg', { user_id: 1, message: [] }).ok, false);
});

test('缺目标或者动作不认识时给出原因，而不是抛异常', () => {
  assert.equal(sendRequest('send_group_msg', { message: 'x' }).ok, false);
  assert.equal(sendRequest('set_group_card', { group_id: 1 }).ok, false);
});

test('ArkLink 的发送结果翻译成 OneBot 的返回形状', () => {
  const done = sendResponse({ ok: true, message_id: 42 }, 'send_group_msg');
  assert.equal(done.status, 'ok');
  assert.equal(done.retcode, 0);
  assert.equal(done.data.message_id, 42);
  const bad = sendResponse({ ok: false, msg: '没权限' }, 'send_group_msg');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.wording, '没权限');
});

test('心跳是 meta_event，桥靠它刷新「上次收包」', () => {
  const beat = heartbeat('123456789');
  assert.equal(beat.post_type, 'meta_event');
  assert.equal(beat.meta_event_type, 'heartbeat');
  assert.equal(beat.self_id, 123456789);
  assert.equal(typeof beat.time, 'number');
});
