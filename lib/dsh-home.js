/**
 * 读写 DSH 的 profile —— 只做「装/卸一个 bundle」这一件事。
 *
 * 为什么要有这一层：手装一个插件要改两个文件（package.json 的 bundles、
 * cordis.patch.yml 的装配行），还要跑一次 pnpm。人做四步，其中两步是 YAML
 * 缩进，很容易改坏别人的配置。这里把四步收成一次幂等调用。
 *
 * 约定：
 *   - 只增删自己那一段，别人的条目一个字都不碰（patch 用标记块整段替换）
 *   - 改之前把原文件存一份 `<文件>.dsh-arkhub.bak`，只存第一次
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const BUNDLE_ID = 'dsh-arkhub';
export const BLOCK_BEGIN = '# === dsh-arkhub BEGIN（由 dsh-arkhub 维护，整段会被替换，请勿手工编辑）===';
export const BLOCK_END = '# === dsh-arkhub END ===';

/** DSH 的根目录。DSH_HOME 优先，其次 ~/.dsh。 */
export function dshHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), '.dsh');
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 原文件备份，只存第一次（反复 install 不会把备份冲成「已装好」的样子）。 */
export function backupOnce(file) {
  const bak = `${file}.dsh-arkhub.bak`;
  if (!existsSync(bak) && existsSync(file)) copyFileSync(file, bak);
  return bak;
}

export function restoreBackup(file) {
  const bak = `${file}.dsh-arkhub.bak`;
  if (!existsSync(bak)) return false;
  copyFileSync(bak, file);
  return true;
}

export function dropBackup(file) {
  const bak = `${file}.dsh-arkhub.bak`;
  if (existsSync(bak)) unlinkSync(bak);
}

/** 所有 profile：`~/.dsh/profiles/<名字>/package.json` 里带 dsh.profile 的才算。 */
export function listProfiles(home = dshHome()) {
  const root = join(home, 'profiles');
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const file = join(dir, 'package.json');
    if (!existsSync(file)) continue;
    try {
      const pkg = readJson(file);
      if (!pkg?.dsh?.profile) continue;
      out.push({
        name,
        dir,
        file,
        patchFile: join(dir, 'cordis.patch.yml'),
        pkg,
        bundles: Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [],
        installed: Boolean(pkg.dependencies?.[BUNDLE_ID]),
        mtime: statSync(file).mtimeMs,
      });
    } catch {
      /* 别的 profile 坏了不该影响我们 */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 挑一个 profile 装。
 *
 * 优先级：显式指定 > 已经装了本插件 > 装了 dsh-world（那条鱼在这儿）> 只有一个 > 最近改过的。
 * 之所以偏向 dsh-world：这个插件的用途就是「把已有的角色接上 QQ」，她在哪个 profile 就装哪个。
 */
export function pickProfile(home, wanted) {
  const all = listProfiles(home);
  if (!all.length) return { profile: null, profiles: all, reason: '没有找到任何 DSH profile（~/.dsh/profiles/*/package.json 里缺 dsh.profile）' };
  if (wanted) {
    const hit = all.find(p => p.name === wanted) ?? all.find(p => p.dir === wanted);
    if (!hit) return { profile: null, profiles: all, reason: `没有名为 ${wanted} 的 profile（现有：${all.map(p => p.name).join(', ')}）` };
    return { profile: hit, profiles: all, reason: '按 --profile 指定' };
  }
  const hasOurs = all.filter(p => p.installed);
  if (hasOurs.length === 1) return { profile: hasOurs[0], profiles: all, reason: '这个 profile 之前装过' };
  const hasWorld = all.filter(p => p.bundles.includes('dsh-world'));
  if (hasWorld.length === 1) return { profile: hasWorld[0], profiles: all, reason: '这个 profile 里有 dsh-world（那条鱼在这里）' };
  if (all.length === 1) return { profile: all[0], profiles: all, reason: '只有一个 profile' };
  const pool = hasWorld.length ? hasWorld : all;
  return { profile: pool[0], profiles: all, reason: '最近改动过的 profile（可用 --profile 指定）' };
}

/** 在 bundles 里登记（幂等，位置保持在末尾）。 */
export function ensureBundle(pkg, id = BUNDLE_ID) {
  const profile = pkg.dsh.profile;
  profile.bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
  if (profile.bundles.includes(id)) return false;
  profile.bundles.push(id);
  return true;
}

export function removeBundle(pkg, id = BUNDLE_ID) {
  const profile = pkg.dsh?.profile;
  if (!profile || !Array.isArray(profile.bundles)) return false;
  const before = profile.bundles.length;
  profile.bundles = profile.bundles.filter(one => one !== id);
  return profile.bundles.length !== before;
}

/** path → package.json 里能用的依赖写法（正斜杠，Windows 也一样）。 */
export function linkSpec(dir) {
  return `link:${dir.replace(/\\/g, '/')}`;
}

/**
 * dsh-world 的依赖版本线：全新 DSH 装这个（npm 上没有 0.5.x，最早的公开版就是 0.6.4）。
 * 0.x 的 ^ 只钉次要版本：^0.6.4 = 0.6.x，不会一觉醒来跳到 0.7+。
 * tools/dsh-world-patch 的锚点按代际给了候选：自带 0.5.x、npm 0.6.x、0.7.x 都认。
 * profile 里本来就有 dsh-world 的话不动它。
 */
export const WORLD_SPEC = '^0.6.4';

/** 全新 DSH 的装配行里补一段 dsh-world（已经有 `- id: dsh-world` 就原样返回）。 */
export function appendWorldBlock(patchText, home = dshHome()) {
  if (/^-\s*id:\s*dsh-world\b/m.test(patchText)) return patchText;
  // 桥的目录用绝对路径（dsh-world 的配置读取不做 ~ 展开，现有 profile 里写的也是绝对路径）
  const bridgeDir = join(home, 'qq-bridge').replace(/\\/g, '/');
  const block = [
    '- id: dsh-world',
    '  name: dsh-world',
    '  config:',
    '    worldId: default',
    '    life: true',
    '    toast: true',
    `    qqBridgeDir: '${bridgeDir}'`,
    '    qqBridgePort: 3100',
    '    qqBridgeAutoStart: true',
    '    qqBridgeBindHomeSession: owner',
    '',
  ].join('\n');
  return `${patchText.replace(/\s*$/, '')}\n${block}\n`;
}

/** 三段拼回去：不留空段，中间统一空一行，结尾一个换行。 */
function joinSections(head, body, tail) {
  const parts = [head, body, tail].filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

/**
 * 有标记块就整段换掉，没有就追加。
 *
 * 坑：不能在原文上「缝补」——每次都在块尾多留一个换行，装几次就多几行空白，
 * 卸载也清不回原样。所以这里一律切成 head / body / tail 三段重建。
 */
export function applyPatchBlock(text, block) {
  const body = `${BLOCK_BEGIN}\n${block.trimEnd()}\n${BLOCK_END}`;
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (begin >= 0 && end > begin) {
    const head = text.slice(0, begin).replace(/\s+$/, '');
    const tail = text.slice(end + BLOCK_END.length).replace(/^\s+/, '');
    return joinSections(head, body, tail);
  }
  return joinSections(text.replace(/\s+$/, ''), body, '');
}

/** 抹掉整块，其余原样（卸载后应当与安装前逐字节一致）。 */
export function stripPatchBlock(text) {
  const begin = text.indexOf(BLOCK_BEGIN);
  if (begin < 0) return text;
  const end = text.indexOf(BLOCK_END);
  if (end < begin) return text;
  const head = text.slice(0, begin).replace(/\s+$/, '');
  const tail = text.slice(end + BLOCK_END.length).replace(/^\s+/, '');
  return joinSections(head, '', tail);
}

/** 一段装配行。字符串一律加引号：QQ 号是数字，YAML 会把 '123456789' 读成字符串而不是数。 */
export function buildPatchBlock(config) {
  const q = value => `'${String(value).replace(/'/g, "''")}'`;
  const list = values => `[${values.map(q).join(', ')}]`;
  const lines = [
    '- insert:',
    `    - id: ${BUNDLE_ID}`,
    `      name: ${BUNDLE_ID}`,
    '      config:',
    '        enabled: true',
    // channel 段是 switch.js 会碰的开关（切到原桥那条线时翻 false），重建块时必须带上，
    // 不然一次白名单落盘就把「待命」状态冲回 true
    '        channel:',
    `          enabled: ${config.channel?.enabled === false ? 'false' : 'true'}`,
    '        transport: arklink',
    '        arklink:',
    `          baseUrl: ${config.arklink.baseUrl}`,
    '          tokenFile: ~/.arklink/api.json',
    `          pollMs: ${Math.round(Number(config.arklink.pollMs) || 2000)}`,
    // snowluma 段（收信上游）也在标记块里 —— 落盘重建整块时必须带上，不然一次
    // 白名单落盘就把 SnowLuma 的地址和 token 全丢了
    '        snowluma:',
    `          enabled: ${config.snowluma?.enabled === false ? 'false' : 'true'}`,
    `          httpUrl: ${config.snowluma?.httpUrl || 'http://127.0.0.1:3102'}`,
    `          wsUrl: ${config.snowluma?.wsUrl || 'ws://127.0.0.1:3101'}`,
    `          httpToken: ${q(config.snowluma?.httpToken || '')}`,
    `          wsToken: ${q(config.snowluma?.wsToken || '')}`,
    '        qq:',
    `          accountUin: ${q(config.qq.accountUin)}`,
    `          allowPrivate: ${list(config.qq.allowPrivate)}`,
    `          allowGroups: ${list(config.qq.allowGroups)}`,
    `          ownerQQ: ${q(config.qq.ownerQQ || config.qq.accountUin)}`,
    `          autoReply: ${config.qq.autoReply ? 'true' : 'false'}`,
    `          groupTrigger: ${q(config.qq.groupTrigger || 'mention')}`,
    `          groupKeywords: ${list(config.qq.groupKeywords)}`,
    `          contextMessages: ${Math.round(Number(config.qq.contextMessages) || 6)}`,
    `          batchQuietMs: ${Math.round(Number(config.qq.batchQuietMs) || 4500)}`,
    '        session:',
    '          dshHome: ~/.dsh',
    `          worldId: ${q(config.session.worldId)}`,
    '          bindHomeSession: owner',
    '          agentPreset: standard',
    '        update:',
    '          check: true',
    `          repo: ${q(config.update?.repo || 'panxian-AI/ArkHub')}`,
    '        bridge:',
    `          enabled: ${config.bridge?.enabled ? 'true' : 'false'}`,
    `          port: ${Number(config.bridge?.port) || 3010}`,
    `          token: ${q(config.bridge?.token || '')}`,
    '          heartbeatMs: 30000',
  ];
  return lines.join('\n');
}

/**
 * 把运行中被改过的配置写回装配行（重启不丢）。
 *
 * 世界控制台 / HTTP 路由改白名单、改开关，改的是内存里的 config —— DSH 一重启就回到
 * 装配行里那份旧值。这里用 buildPatchBlock 按当前 config 重建标记块写回去，只动自己的块。
 * 找不到 profile / 标记块就如实返回失败，调用方自己决定吵不吵。
 */
export function persistConfig({ home = dshHome(), config } = {}) {
  const picked = pickProfile(home);
  if (!picked.profile) return { ok: false, reason: picked.reason };
  const prof = picked.profile;
  if (!prof.installed) return { ok: false, reason: `profile ${prof.name} 里没装 dsh-arkhub，不落盘` };
  let text;
  try {
    text = readFileSync(prof.patchFile, 'utf8');
  } catch (error) {
    return { ok: false, reason: `装配行读不了：${error?.message || error}` };
  }
  if (!text.includes(BLOCK_BEGIN)) return { ok: false, reason: '装配行里没有 dsh-arkhub 的标记块（装法太老），不落盘' };
  const next = applyPatchBlock(text, buildPatchBlock(config));
  if (next === text) return { ok: true, file: prof.patchFile, changed: false };
  try {
    writeFileSync(prof.patchFile, next, 'utf8');
  } catch (error) {
    return { ok: false, reason: `装配行写不了：${error?.message || error}` };
  }
  return { ok: true, file: prof.patchFile, changed: true };
}

/** 找到 DSH 自带的 node / pnpm（别指望用户的 PATH 里有）。 */
export function findToolchain(home = dshHome()) {
  // --home 指到别处（测试、多份 DSH）时，工具链还是那份装好的；两处都看
  const roots = [join(home, 'dsh-runtimes')];
  const fallback = dshHome();
  if (fallback !== home) roots.push(join(fallback, 'dsh-runtimes'));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const deps = join(root, name, 'dependencies');
      const node = join(deps, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
      const pnpm = join(deps, 'pnpm', 'bin', 'pnpm.cjs');
      if (existsSync(node) && existsSync(pnpm)) return { node, pnpm };
    }
  }
  return { node: process.execPath, pnpm: '' };
}

export function removeIfExists(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

export { dirname, join };
