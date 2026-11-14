import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeConfig, describeConfig, qqNumbers } from '../lib/config.js';
import { createBatcher, gate, identityOf, identityPrefix, planReply, stripHostNoise } from '../lib/text.js';

const cfg = extra => normalizeConfig({ qq: { allowPrivate: ['10001'], allowGroups: ['20002'], ownerQQ: '10001' }, ...extra });

// ---------------------------------------------------------------- 配置
test('白名单接受数组和逗号串，空数组就是谁都不理', () => {
  assert.deepEqual(qqNumbers(['10001', ' 10002 ', ''], 'x'), ['10001', '10002']);
  assert.deepEqual(qqNumbers('10001, 10002', 'x'), ['10001', '10002']);
  assert.deepEqual(qqNumbers(undefined, 'x'), []);
  assert.throws(() => qqNumbers(['abc'], 'x'), /不是 QQ 号/);
});

test('默认值齐全，坏值被拉回安全侧', () => {
  const c = normalizeConfig({ transport: '乱写', session: { bindHomeSession: '乱写' }, qq: { batchQuietMs: 999999 } });
  assert.equal(c.transport, 'arklink');
  assert.equal(c.session.bindHomeSession, 'owner');
  assert.equal(c.qq.batchQuietMs, 30000);
  assert.equal(c.update.check, true);
});

test('describeConfig 不泄露 token 明文', () => {
  const c = normalizeConfig({ arklink: { token: 'secret-token' } });
  const view = describeConfig(c);
  assert.equal(view.arklink.hasToken, true);
  assert.equal(JSON.stringify(view).includes('secret-token'), false);
});

// ---------------------------------------------------------------- 白名单
test('私聊：白名单外不接，白名单内接', () => {
  const config = cfg();
  assert.equal(gate({ chat_type: 1, peer_uid: '10001', sender_uid: '10001', text: '在吗' }, config).ok, true);
  const out = gate({ chat_type: 1, peer_uid: '99999', sender_uid: '99999', text: '在吗' }, config);
  assert.equal(out.ok, false);
  assert.match(out.reason, /不在白名单/);
});

test('白名单空着 = 谁都不理（不偷偷放开）', () => {
  const config = normalizeConfig({ qq: {} });
  const out = gate({ chat_type: 1, peer_uid: '10001', sender_uid: '10001', text: 'hi' }, config);
  assert.equal(out.ok, false);
  assert.match(out.reason, /白名单是空的/);
});

test('群里默认只在被叫到时才接', () => {
  const config = cfg({ qq: { allowPrivate: ['10001'], allowGroups: ['20002'], groupKeywords: ['小鱼'] } });
  const said = text => gate({ chat_type: 2, peer_uid: '20002', sender_uid: '10001', text }, config, { nickname: '大肥鱼', uin: '30003' });
  assert.equal(said('@大肥鱼 在吗').ok, true);
  assert.equal(said('小鱼你在干嘛').ok, true);
  assert.equal(said('@30003 出来').ok, true);
  const ignored = said('今天天气不错');
  assert.equal(ignored.ok, false);
  assert.match(ignored.reason, /没叫她/);
});

test('群里 all = 每句都接；静默期间不接', () => {
  const config = cfg({ qq: { allowPrivate: ['10001'], allowGroups: ['20002'], groupTrigger: 'all' } });
  assert.equal(gate({ chat_type: 2, peer_uid: '20002', text: '随便说' }, config).ok, true);
  config.qq.mutedUntil = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(gate({ chat_type: 2, peer_uid: '20002', text: '随便说' }, config).ok, false);
});

test('群号不在白名单，哪怕 @ 了也不接', () => {
  const config = cfg();
  const out = gate({ chat_type: 2, peer_uid: '88888', text: '@大肥鱼' }, config, { nickname: '大肥鱼' });
  assert.equal(out.ok, false);
});

// ---------------------------------------------------------------- 读到的样子
test('私聊与群聊的来源行不一样', () => {
  const priv = identityOf({ chat_type: 1, peer_uid: '10001', sender_uid: '10001', sender_name: '张三' }, '30003');
  assert.equal(identityPrefix(priv), '【QQ「张三」，chatId 10001】\n');
  const grp = identityOf({ chat_type: 2, peer_uid: '20002', peer_name: '一家人', sender_uid: '10001', sender_name: '张三' }, '30003');
  assert.equal(identityPrefix(grp), '【QQ群「一家人」 张三 说，chatId 20002】\n');
});

test('speakerId 必须带 qq: 前缀（宿主会校验）', () => {
  const identity = identityOf({ chat_type: 1, peer_uid: '10001', sender_uid: '10001' }, '30003');
  assert.equal(identity.channel, 'qq');
  assert.ok(identity.speakerId.startsWith('qq:'));
  assert.equal(identity.speakerId.length > 3, true);
});

// ---------------------------------------------------------------- 她说的话
test('剥掉宿主的记账行、来源头、复述的聊天记录', () => {
  const raw = [
    'Time sampled: 2026-11-15T00:00:00Z',
    '【QQ「张三」，chatId 10001】',
    '正在想你呢。',
    '仅作引用数据：{"role":"user"}',
    'user',
    '刚吃完早饭。',
  ].join('\n');
  assert.equal(stripHostNoise(raw), '正在想你呢。\n刚吃完早饭。');
});

test('工具标记被截掉', () => {
  assert.equal(stripHostNoise('我说一句<｜DSML｜invoke name="x"｜>'), '我说一句');
});

test('空行分成几条，标记被拿掉', () => {
  assert.deepEqual(planReply('第一句\n\n第二句'), ['第一句', '第二句']);
  assert.deepEqual(planReply('你好 [[at:10001]] 在吗'), ['你好  在吗']);
  assert.deepEqual(planReply('   \n\n  '), []);
});

test('只有记账内容时什么也不发（不冒出空消息）', () => {
  assert.deepEqual(planReply('Time sampled: x\n仅作引用数据：…'), []);
});

// ---------------------------------------------------------------- 攒批
test('同一会话连着几句合成一段，不同会话各算各的', async () => {
  const flushed = [];
  const batcher = createBatcher({ quietMs: 20, onFlush: (key, items) => flushed.push([key, items.length]) });
  batcher.push('1:10001', { text: 'a' });
  batcher.push('1:10001', { text: 'b' });
  batcher.push('2:20002', { text: 'c' });
  await new Promise(resolve => setTimeout(resolve, 80));
  batcher.stop();
  assert.deepEqual(flushed.sort(), [['1:10001', 2], ['2:20002', 1]]);
});

test('stop 之后不再触发', async () => {
  let called = 0;
  const batcher = createBatcher({ quietMs: 20, onFlush: () => { called += 1; } });
  batcher.push('k', { text: 'a' });
  batcher.stop();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(called, 0);
});
