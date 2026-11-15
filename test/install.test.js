/**
 * 装/卸这套动作是「改别人机器上的配置文件」——错一个换行都算事故，
 * 所以这里盯三件事：装几次都只有一段、卸载能逐字节还原、不碰别人的条目。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOCK_BEGIN,
  BLOCK_END,
  applyPatchBlock,
  backupOnce,
  buildPatchBlock,
  ensureBundle,
  linkSpec,
  listProfiles,
  pickProfile,
  removeBundle,
  restoreBackup,
  dropBackup,
  stripPatchBlock,
} from '../lib/dsh-home.js';
import { detectWorld } from '../lib/detect.js';

const SAMPLE = [
  '- id: ui-chat',
  "  name: '@deepseek-ai/dsh-client-ui-chat'",
  '  config:',
  '    transcriptView: standard',
  '',
  '# === qq-bridge MCP END ===',
  '',
].join('\n');

const CONFIG = {
  arklink: { baseUrl: 'http://127.0.0.1:6900' },
  qq: {
    accountUin: '123456789',
    allowPrivate: ['123456789'],
    allowGroups: ['987654321'],
    ownerQQ: '123456789',
    autoReply: true,
    groupKeywords: ['大肥鱼', '鲸鱼'],
  },
  session: { worldId: 'default' },
};

test('装一次会追加一段，原有内容一字不动', () => {
  const out = applyPatchBlock(SAMPLE, buildPatchBlock(CONFIG));
  assert.ok(out.startsWith(SAMPLE.trimEnd()));
  assert.equal(out.includes(BLOCK_BEGIN), true);
  assert.equal(out.includes(BLOCK_END), true);
});

test('装三次仍然只有一段（幂等）', () => {
  let text = SAMPLE;
  for (let i = 0; i < 3; i += 1) text = applyPatchBlock(text, buildPatchBlock(CONFIG));
  assert.equal(text.split(BLOCK_BEGIN).length - 1, 1);
  assert.equal(text.split(BLOCK_END).length - 1, 1);
});

test('装三次再卸，逐字节回到原样', () => {
  let text = SAMPLE;
  for (let i = 0; i < 3; i += 1) text = applyPatchBlock(text, buildPatchBlock(CONFIG));
  assert.equal(stripPatchBlock(text), SAMPLE);
});

test('块后面还有别人的条目时，卸载也不会连带删掉', () => {
  const tail = `${SAMPLE}\n- id: someone-else\n  name: 'x'\n`;
  const round = stripPatchBlock(applyPatchBlock(tail, buildPatchBlock(CONFIG)));
  assert.equal(round, tail);
});

test('空文件装上再卸掉，回到空', () => {
  const round = stripPatchBlock(applyPatchBlock('', buildPatchBlock(CONFIG)));
  assert.equal(round, '');
});

test('没有块的文本，卸载时原样返回', () => {
  assert.equal(stripPatchBlock(SAMPLE), SAMPLE);
});

test('QQ 号写成字符串，别让 YAML 读成数字', () => {
  const block = buildPatchBlock(CONFIG);
  assert.match(block, /accountUin: '123456789'/);
  assert.match(block, /allowGroups: \['987654321'\]/);
  assert.match(block, /autoReply: true/);
});

test('bundles 登记幂等，也能干净移除', () => {
  const pkg = { dsh: { profile: { bundles: ['a'] } } };
  assert.equal(ensureBundle(pkg), true);
  assert.equal(ensureBundle(pkg), false);
  assert.deepEqual(pkg.dsh.profile.bundles, ['a', 'dsh-arkhub']);
  assert.equal(removeBundle(pkg), true);
  assert.deepEqual(pkg.dsh.profile.bundles, ['a']);
  assert.equal(removeBundle(pkg), false);
});

test('link 依赖写法用正斜杠（Windows 反斜杠会被规范化成假 diff）', () => {
  assert.equal(linkSpec('D:\\workplace\\ArkHub'), 'link:D:/workplace/ArkHub');
  assert.equal(linkSpec('/opt/arkhub'), 'link:/opt/arkhub');
});

test('自动挑 profile：选装了 dsh-world 的那个（那条鱼在那儿）', () => {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-profiles-'));
  try {
    const make = (name, bundles) => {
      mkdirSync(join(home, 'profiles', name), { recursive: true });
      writeFileSync(
        join(home, 'profiles', name, 'package.json'),
        JSON.stringify({ name, dsh: { profile: { bundles } } }),
      );
    };
    make('plain', ['@deepseek-ai/dsh-base']);
    make('withfish', ['@deepseek-ai/dsh-base', 'dsh-world']);

    const all = listProfiles(home);
    assert.equal(all.length, 2);
    const picked = pickProfile(home);
    assert.equal(picked.profile.name, 'withfish');
    assert.equal(pickProfile(home, 'plain').profile.name, 'plain');
    assert.equal(pickProfile(home, 'nope').profile, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('找不到 world 时给出可用的默认值，而不是崩', () => {
  const home = mkdtempSync(join(tmpdir(), 'arkhub-world-'));
  try {
    const empty = detectWorld(home);
    assert.equal(empty.worldId, 'default');
    assert.equal(empty.homeSessionId, '');

    mkdirSync(join(home, 'worlds', 'other'), { recursive: true });
    writeFileSync(join(home, 'worlds', 'other', 'life.json'), JSON.stringify({ homeSessionId: 's-1' }));
    assert.equal(detectWorld(home).worldId, 'other');

    mkdirSync(join(home, 'worlds', 'default'), { recursive: true });
    writeFileSync(join(home, 'worlds', 'default', 'life.json'), JSON.stringify({ homeSessionId: 's-2' }));
    assert.equal(detectWorld(home).worldId, 'default');
    assert.equal(detectWorld(home).homeSessionId, 's-2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('备份只存第一次：反复安装不会把备份冲成「已装好」的样子', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkhub-bak-'));
  try {
    const file = join(dir, 'cordis.patch.yml');
    writeFileSync(file, 'original\n');

    backupOnce(file);
    writeFileSync(file, 'modified-1\n');
    backupOnce(file); // 第二次不该覆盖备份
    writeFileSync(file, 'modified-2\n');

    assert.equal(readFileSync(`${file}.dsh-arkhub.bak`, 'utf8'), 'original\n');
    assert.equal(restoreBackup(file), true);
    assert.equal(readFileSync(file, 'utf8'), 'original\n');

    dropBackup(file);
    assert.equal(existsSync(`${file}.dsh-arkhub.bak`), false);
    assert.equal(restoreBackup(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('全新 DSH：appendWorldBlock 补一段 dsh-world，桥目录用绝对路径', async () => {
  const { appendWorldBlock, WORLD_SPEC } = await import('../lib/dsh-home.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'arkhub-world-'));
  try {
    const out = appendWorldBlock('- id: other\n  name: other\n', home);
    assert.match(out, /^- id: dsh-world$/m);
    assert.match(out, /qqBridgeDir: '[^']*qq-bridge'/);
    assert.doesNotMatch(out, /qqBridgeDir: '~\//);
    assert.match(out, /qqBridgePort: 3100/);
    // 已有 dsh-world 块就一字不动（用户自己的 companionName 之类别被覆盖）
    const twice = appendWorldBlock(out.replace(/qqBridgePort: 3100/, 'qqBridgePort: 3100'), home);
    assert.equal(twice.match(/- id: dsh-world/g).length, 1);
    // 版本线钉在补丁验证过的 0.5.x
    assert.match(WORLD_SPEC, /^\^0\.6\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
