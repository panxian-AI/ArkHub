/**
 * 换桥的解析与翻转：不动真机，全部对着字符串 fixture 做。
 *
 * 为什么用 new Function 抽内部函数：switch.js 只导出主流程（bridgeSwitch），
 * 这几个小函数是实现细节；抽出来测是为了不用真机 profile 也能钉住行为。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../lib/switch.js', import.meta.url), 'utf8');

const PATCH = `# profile 别的条目
- id: dsh-world
  name: dsh-world
  config:
    companionName: 大肥鱼
    qqBridgeDir: 'C:/Users/admin/.dsh/qq-bridge'
    qqBridgePort: 3100
    qqBridgeAutoStart: true

# === dsh-arkhub BEGIN（由 dsh-arkhub 维护，整段会被替换，请勿手工编辑）===
- insert:
    - id: dsh-arkhub
      name: dsh-arkhub
      config:
        qq:
          accountUin: '123456789'
          autoReply: true
        update:
          check: true
          repo: panxian-AI/ArkHub
# === dsh-arkhub END ===
`;

const extract = name => src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];
const arkhubBlock = new Function('patchText', `'use strict';
  const BLOCK_BEGIN_TEXT = '# === dsh-arkhub BEGIN';
  const BLOCK_END_TEXT = '# === dsh-arkhub END ===';
  ${extract('arkhubBlock')}
  return arkhubBlock(patchText);
`);
const worldBridge = new Function('patchText', `'use strict';
  ${extract('worldBridge')}
  return worldBridge(patchText);
`);
const bridgePortAndToken = new Function('block', `'use strict';
  ${extract('bridgePortAndToken')}
  return bridgePortAndToken(block);
`);
const flipBridge = new Function('block', 'enabled', 'port', 'token', `'use strict';
  ${extract('flipBridge')}
  return flipBridge(block, enabled, port, token);
`);

test('worldBridge：从装配行读出桥目录与端口', () => {
  const world = worldBridge(PATCH);
  assert.equal(world.dir, 'C:/Users/admin/.dsh/qq-bridge');
  assert.equal(world.port, 3100);
});

test('worldBridge：没有 dsh-world 就返回空', () => {
  assert.deepEqual(worldBridge('# 什么都没有\n'), {});
});

test('bridgePortAndToken：老块没有 bridge 段时取默认值', () => {
  const block = arkhubBlock(PATCH);
  assert.deepEqual(bridgePortAndToken(block), { port: 3010, token: '' });
});

test('flipBridge：老块补出 bridge 段，enabled 打开', () => {
  const block = arkhubBlock(PATCH);
  const flipped = flipBridge(block, true, 3010, '');
  assert.match(flipped, /        bridge:\n          enabled: true\n          port: 3010/);
  // 别把别的条目弄丢
  assert.match(flipped, /accountUin: '123456789'/);
  assert.match(flipped, /repo: panxian-AI\/ArkHub/);
});

test('flipBridge：已有 bridge 段时只翻 enabled', () => {
  const block = arkhubBlock(PATCH).trimEnd() + `
        bridge:
          enabled: true
          port: 3010
          token: ''
          heartbeatMs: 30000
`;
  const flipped = flipBridge(block, false);
  assert.match(flipped, /          enabled: false/);
  assert.doesNotMatch(flipped, /          enabled: true/);
  assert.match(flipped, /          port: 3010/);
});

test('flipBridge：token 里的单引号要转义', () => {
  const flipped = flipBridge(arkhubBlock(PATCH), true, 3010, "a'b");
  assert.match(flipped, /token: 'a''b'/);
});

test('flipBridge：true 翻 true 不许追加第二段（2026-11-15 真机叠键的根源）', () => {
  const block = arkhubBlock(PATCH).trimEnd() + `
        bridge:
          enabled: true
          port: 3010
          token: ''
          heartbeatMs: 30000
`;
  const again = flipBridge(block, true);
  assert.equal(again.match(/^        bridge:$/gm).length, 1);
});

test('flipChannel：true 翻 true 不许追加第二段', () => {
  const flipChannel = new Function('block', 'enabled', `'use strict';
    ${extract('flipChannel')}
    return flipChannel(block, enabled);
  `);
  const block = arkhubBlock(PATCH).trimEnd() + `
        channel:
          enabled: true
`;
  const again = flipChannel(block, true);
  assert.equal(again.match(/^        channel:$/gm).length, 1);
});
