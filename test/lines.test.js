/**
 * 「两条线」的判定与展示：不动真机，全部对着临时目录 + 假 fetch 做。
 *
 * 钉住三件事：
 *   1. 端口是指纹 —— 桥的 wsUrl 指到 3010 就是门面在说话，指到备份那个端口就是原桥
 *   2. 哪条线没开都不算错，只影响它自己那一行（世界控制台那张卡不能因为对面没开就整个挂掉）
 *   3. 标题要写成「昵称 · 号」，昵称拿不到就退回号，都没有就用线自己的名字
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeLines, describeLocalLines, portOf } from '../lib/lines.js';

const PATCH = `- id: dsh-world
  name: dsh-world
  config:
    companionName: 大肥鱼
    qqBridgeDir: '__BRIDGE__'
    qqBridgePort: 3100

# === dsh-arkhub BEGIN（由 dsh-arkhub 维护，整段会被替换，请勿手工编辑）===
- insert:
    - id: dsh-arkhub
      name: dsh-arkhub
      config:
        bridge:
          enabled: true
          port: 3010
          token: ''
          heartbeatMs: 30000
# === dsh-arkhub END ===
`;

const BRIDGE_LIVE = {
  snowluma: { wsUrl: 'ws://127.0.0.1:3010', httpUrl: 'http://127.0.0.1:3010', followDiscoveredEndpoint: false },
  dsh: { baseUrl: 'http://127.0.0.1:62560' },
  consolePort: 3100,
};

const BRIDGE_BACKUP = {
  snowluma: {
    wsUrl: 'ws://127.0.0.1:3001/',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: 'tok',
    followDiscoveredEndpoint: true,
  },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  consolePort: 3100,
};

function fixture({ live = BRIDGE_LIVE, backup = BRIDGE_BACKUP } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-lines-'));
  const profile = join(home, 'profiles', 'desktop');
  const bridge = join(home, 'qq-bridge');
  mkdirSync(profile, { recursive: true });
  mkdirSync(bridge, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'desktop', dsh: { profile: { bundles: ['dsh-world', 'dsh-arkhub'] } }, dependencies: { 'dsh-arkhub': '0.6.0' } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), PATCH.replace('__BRIDGE__', bridge));
  if (live) writeFileSync(join(bridge, 'config.json'), JSON.stringify(live));
  if (backup) writeFileSync(join(bridge, 'config.json.dsh-arkhub.bak'), JSON.stringify(backup));
  return { home, bridge, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 假 fetch：按 url 回一份 OneBot / 门面的状态，没登记的地址就当连不上。 */
function fakeFetch(table) {
  return async (url) => {
    const hit = Object.entries(table).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) throw new Error('ECONNREFUSED');
    const body = typeof hit[1] === 'function' ? hit[1]() : hit[1];
    return { ok: true, status: 200, json: async () => body };
  };
}

test('portOf：ws / http / 尾斜杠都认得出端口', () => {
  assert.equal(portOf('ws://127.0.0.1:3010'), 3010);
  assert.equal(portOf('ws://127.0.0.1:3001/'), 3001);
  assert.equal(portOf('http://127.0.0.1:3000'), 3000);
  assert.equal(portOf('ws://example.com/qq'), 80);
  assert.equal(portOf(''), 0);
  assert.equal(portOf(undefined), 0);
});

test('桥指向门面 = 现在在 vm 这条线上', () => {
  const f = fixture();
  try {
    const view = describeLocalLines({ home: f.home, config: { qq: { accountUin: '100010001' } } });
    assert.equal(view.current, 'vm');
    assert.equal(view.facadePort, 3010);
    assert.equal(view.canRollback, true);
    const vm = view.lines.find(line => line.id === 'vm');
    const win = view.lines.find(line => line.id === 'windows');
    assert.equal(vm.upstream, 'ws://127.0.0.1:3010');
    assert.equal(vm.account, '100010001');
    assert.equal(win.upstream, 'ws://127.0.0.1:3001/');
    assert.equal(win.port, 3001);
    assert.equal(win.available, true);
  } finally {
    f.cleanup();
  }
});

test('桥指回原端口 = 现在在原桥这条线上', () => {
  const f = fixture({ live: { ...BRIDGE_LIVE, snowluma: { wsUrl: 'ws://127.0.0.1:3001/', httpUrl: 'http://127.0.0.1:3000' } } });
  try {
    const view = describeLocalLines({ home: f.home, config: {} });
    assert.equal(view.current, 'windows');
  } finally {
    f.cleanup();
  }
});

test('没有换桥前备份：原桥那条线不可用，并说清为什么', () => {
  const f = fixture({ backup: null });
  try {
    const view = describeLocalLines({ home: f.home, config: {} });
    assert.equal(view.canRollback, false);
    const win = view.lines.find(line => line.id === 'windows');
    assert.equal(win.available, false);
    assert.match(win.note, /备份/);
  } finally {
    f.cleanup();
  }
});

test('两条线都探活：各自报自己的号，标题是「昵称 · 号」', async () => {
  const f = fixture();
  try {
    const view = await describeLines({
      home: f.home,
      config: { qq: { accountUin: '100010001' } },
      fetchImpl: fakeFetch({
        'http://127.0.0.1:3010/api/status': { status: 'ok', data: { account: '100010001', nickname: '阿潘', clients: 1, events: 96 } },
        'http://127.0.0.1:3000/get_login_info': { status: 'ok', data: { user_id: 100010002, nickname: '小暖' } },
      }),
    });
    const vm = view.lines.find(line => line.id === 'vm');
    const win = view.lines.find(line => line.id === 'windows');
    assert.equal(vm.label, '阿潘 · 100010001');
    assert.equal(vm.alive, true);
    assert.equal(vm.current, true);
    assert.match(vm.detail, /96/);
    assert.equal(win.label, '小暖 · 100010002');
    assert.equal(win.alive, true);
    assert.equal(win.current, false);
  } finally {
    f.cleanup();
  }
});

test('一条线没开：只那一行是 false，另一行照常', async () => {
  const f = fixture();
  try {
    const view = await describeLines({
      home: f.home,
      config: { qq: { accountUin: '100010001' } },
      fetchImpl: fakeFetch({
        'http://127.0.0.1:3010/api/status': { status: 'ok', data: { account: '100010001', clients: 1 } },
      }),
    });
    const vm = view.lines.find(line => line.id === 'vm');
    const win = view.lines.find(line => line.id === 'windows');
    assert.equal(vm.alive, true);
    assert.equal(win.alive, false);
    assert.equal(win.label, '原桥（本机 SnowLuma）');
  } finally {
    f.cleanup();
  }
});

test('门面在但号没上来：算没上线，不算连上', async () => {
  const f = fixture();
  try {
    const view = await describeLines({
      home: f.home,
      config: {},
      fetchImpl: fakeFetch({ 'http://127.0.0.1:3010/api/status': { status: 'ok', data: { clients: 0 } } }),
    });
    const vm = view.lines.find(line => line.id === 'vm');
    assert.equal(vm.alive, true);
    assert.equal(vm.account, '');
    assert.match(vm.detail, /没上来/);
  } finally {
    f.cleanup();
  }
});

test('世界控制台那张卡也带「人工接管」：没配也给一份可读的，不能是 undefined', async () => {
  const f = fixture();
  try {
    const view = await describeLines({ home: f.home, config: {}, fetchImpl: fakeFetch({}) });
    assert.ok(view.manual && typeof view.manual === 'object');
    assert.equal(view.manual.configured, false);
    assert.match(view.manual.note, /manual set/);
    // 地址（含密码）永远不进这张卡
    assert.equal('url' in view.manual, false);
  } finally {
    f.cleanup();
  }
});
