import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 更新提示会把状态写到 <home>/.dsh/arkhub，测试里换成临时目录，别碰真的家
const fakeHome = mkdtempSync(join(tmpdir(), 'arkhub-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const { VERSION, checkUpdate, isNewer, muteUpdates, parseVersion, readUpdateState } = await import('../lib/update.js');

test('版本比较：只比数字，前缀无所谓', () => {
  assert.deepEqual(parseVersion('v0.2.1'), [0, 2, 1]);
  assert.equal(isNewer('v0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
});

test('配置里关掉就完全不查（连网络都不碰）', async () => {
  const snapshot = await checkUpdate({ update: { check: false } });
  assert.equal(snapshot.disabled, true);
  assert.equal(snapshot.hasUpdate, false);
});

test('环境变量也能关', async () => {
  process.env.DSH_ARKHUB_NO_UPDATE_CHECK = '1';
  try {
    const snapshot = await checkUpdate({ update: { check: true } });
    assert.equal(snapshot.disabled, true);
  } finally {
    delete process.env.DSH_ARKHUB_NO_UPDATE_CHECK;
  }
});

test('点了「别再提醒」之后一直闭嘴，能恢复', async () => {
  muteUpdates(true);
  const snapshot = await checkUpdate({ update: { check: true } });
  assert.equal(snapshot.disabled, true);
  assert.match(snapshot.reason, /别再提醒/);
  muteUpdates(false);
  assert.equal(readUpdateState().muted, false);
});

test('不联网时只读缓存，不会卡住状态接口', async () => {
  const snapshot = await checkUpdate({ update: { check: true } }, { fetch: false });
  assert.equal(snapshot.hasUpdate, false);
  assert.equal(snapshot.current, VERSION);
  assert.ok(snapshot.ok === false || snapshot.ok === true);
});

test('状态文件落在 <home>/.dsh/arkhub/update.json', () => {
  muteUpdates(false);
  const file = join(fakeHome, '.dsh', 'arkhub', 'update.json');
  assert.equal(existsSync(file), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).muted, false);
});
