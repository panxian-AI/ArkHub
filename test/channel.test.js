/**
 * channel.enabled 的翻转 + 「换到原桥那条线」的落盘结果。
 *
 * 为什么单独一个文件：switch.test.js 是纯字符串 fixture，这里要真写文件（装配行 + 桥配置），
 * 两者的失败方式不一样，混在一起看不出是哪一类坏了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bridgeSwitch } from '../lib/switch.js';

const src = readFileSync(new URL('../lib/switch.js', import.meta.url), 'utf8');

const PATCH = `# profile 别的条目
- id: dsh-world
  name: dsh-world
  config:
    companionName: 大肥鱼
    qqBridgeDir: 'C:/Users/admin/.dsh/qq-bridge'
    qqBridgePort: 3100

# === dsh-arkhub BEGIN（由 dsh-arkhub 维护，整段会被替换，请勿手工编辑）===
- insert:
    - id: dsh-arkhub
      name: dsh-arkhub
      config:
        qq:
          accountUin: '123456789'
        update:
          check: true
          repo: panxian-AI/ArkHub
# === dsh-arkhub END ===
`;

const extract = name => src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];
const blockOf = new Function('patchText', `'use strict';
  const BLOCK_BEGIN_TEXT = '# === dsh-arkhub BEGIN';
  const BLOCK_END_TEXT = '# === dsh-arkhub END ===';
  ${extract('arkhubBlock')}
  return arkhubBlock(patchText);
`);
const flipChannel = new Function('block', 'enabled', `'use strict';
  ${extract('flipChannel')}
  return flipChannel(block, enabled);
`);

const NL = String.fromCharCode(10);

test('flipChannel：老块没有 channel 段就补一段，插在 config: 后面', () => {
  const flipped = flipChannel(blockOf(PATCH), false);
  assert.ok(flipped.includes(['      config:', '        channel:', '          enabled: false', ''].join(NL)));
  // 补的是自己那段，别人的配置一个字不动
  assert.match(flipped, /accountUin: '123456789'/);
  assert.match(flipped, /repo: panxian-AI\/ArkHub/);
});

test('flipChannel：已有就翻，不会插第二段', () => {
  const once = flipChannel(blockOf(PATCH), false);
  const twice = flipChannel(once, true);
  assert.ok(twice.includes(['        channel:', '          enabled: true'].join(NL)));
  assert.equal(twice.match(/^        channel:$/gm).length, 1);
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-switch-'));
  const dir = join(home, 'profiles', 'desktop');
  const bridge = join(home, 'qq-bridge');
  mkdirSync(dir, { recursive: true });
  mkdirSync(bridge, { recursive: true });
  const patch = PATCH.replace('C:/Users/admin/.dsh/qq-bridge', bridge.replace(/\\/g, '/'));
  writeFileSync(join(dir, 'cordis.patch.yml'), patch);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'desktop',
    dsh: { profile: { bundles: ['dsh-world', 'dsh-arkhub'] } },
    dependencies: { 'dsh-arkhub': '0.6.0' },
  }));
  writeFileSync(join(bridge, 'config.json'), JSON.stringify({
    snowluma: { wsUrl: 'ws://127.0.0.1:3010', httpUrl: 'http://127.0.0.1:3010', followDiscoveredEndpoint: false },
    dsh: { baseUrl: 'http://127.0.0.1:62560' },
  }));
  writeFileSync(join(bridge, 'config.json.dsh-arkhub.bak'), JSON.stringify({
    snowluma: { wsUrl: 'ws://127.0.0.1:3001/', httpUrl: 'http://127.0.0.1:3000' },
    dsh: { baseUrl: 'http://127.0.0.1:1' },
  }));
  return { home, dir, bridge, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('bridgeSwitch：换到原桥那条线时 channel 一起关掉（不然两个号会一起回话）', () => {
  const f = fixture();
  try {
    bridgeSwitch({ home: f.home, use: false, channel: false, logger: { log: () => {} } });

    const after = readFileSync(join(f.dir, 'cordis.patch.yml'), 'utf8');
    assert.ok(after.includes(['        channel:', '          enabled: false'].join(NL)));
    assert.ok(after.includes(['        bridge:', '          enabled: false'].join(NL)));

    const config = JSON.parse(readFileSync(join(f.bridge, 'config.json'), 'utf8'));
    assert.equal(config.snowluma.wsUrl, 'ws://127.0.0.1:3001/');
    // DSH 端口用现在的：备份那份是旧的，照抄过去桥就找不到 DSH 了
    assert.equal(config.dsh.baseUrl, 'http://127.0.0.1:62560');
  } finally {
    f.cleanup();
  }
});

test('bridgeSwitch：换回门面那条线，两个开关一起打开', () => {
  const f = fixture();
  try {
    bridgeSwitch({ home: f.home, use: true, channel: true, logger: { log: () => {} } });

    const after = readFileSync(join(f.dir, 'cordis.patch.yml'), 'utf8');
    assert.ok(after.includes(['        channel:', '          enabled: true'].join(NL)));
    assert.ok(after.includes(['        bridge:', '          enabled: true'].join(NL)));

    const config = JSON.parse(readFileSync(join(f.bridge, 'config.json'), 'utf8'));
    assert.equal(config.snowluma.wsUrl, 'ws://127.0.0.1:3010');
    assert.equal(config.snowluma.followDiscoveredEndpoint, false);
    // 换桥前的原样得留着，否则退不回去
    assert.ok(readFileSync(join(f.bridge, 'config.json.dsh-arkhub.bak'), 'utf8').includes('3001'));
  } finally {
    f.cleanup();
  }
});
