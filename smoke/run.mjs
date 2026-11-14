/**
 * 冒烟：不启动 DSH，用假宿主把插件跑一遍。
 *
 *   node smoke/run.mjs
 *
 * 它验证的是「装配 + 连 ArkLink + 读到她原来那个家会话」这三件事，
 * 也就是装到 DSH 之后最容易悄悄坏掉的三处。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';

const log = (...args) => console.log('  ·', ...args);

// ---------------------------------------------------------------- 假宿主
const effects = [];
const routes = [];
const events = [];

const ctx = {
  logger: { info: (...a) => log(...a), warn: (...a) => log('WARN', ...a), error: (...a) => log('ERR', ...a) },
  on: (name, handler) => {
    events.push({ name, handler });
    return () => {};
  },
  effect: (factory, label) => {
    const dispose = factory();
    effects.push({ label, dispose });
    return dispose;
  },
  inject: (names, callback) => {
    for (const name of names) if (!(name in ctx)) ctx[name] = fakeService(name);
    callback(ctx);
  },
  sessions: { flush: async () => {} },
};

function fakeService(name) {
  if (name === 'sessionController') {
    return {
      create: async ({ cwd }) => ({ sessionId: `session-fake-${Math.abs(hash(cwd))}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, whenIdle: async () => {}, followup: () => {}, inject: () => {} } }),
      rename: async () => {},
    };
  }
  if (name === 'webServer') {
    return {
      getOrigin: () => 'http://127.0.0.1:0',
      register: route => {
        routes.push(route);
        return () => {};
      },
    };
  }
  return {};
}

function hash(text) {
  let value = 0;
  for (const ch of String(text)) value = (value * 31 + ch.charCodeAt(0)) % 1_000_000_007;
  return value;
}

// ---------------------------------------------------------------- 配置
// 占位号码：仓库里不写真实 QQ 号，用环境变量可指向自己的账号
const UIN = process.env.ARKHUB_TEST_UIN || '123456789';
const GROUP = process.env.ARKHUB_TEST_GROUP || '987654321';
const profilePatch = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
let config = { enabled: true, transport: 'arklink', qq: { allowPrivate: [UIN], allowGroups: [GROUP], ownerQQ: UIN, autoReply: false } };
try {
  const text = readFileSync(profilePatch, 'utf8');
  if (!text.includes('id: dsh-arkhub')) log('提示：profile 里还没接上 dsh-arkhub，用默认配置冒烟');
} catch {
  log('提示：读不到 profile 配置，用默认配置冒烟');
}

// ---------------------------------------------------------------- 跑
console.log(`\n装配 ${plugin.name}（inject: ${plugin.inject.join(', ')}）`);
plugin.apply(ctx, config);

await new Promise(resolve => setTimeout(resolve, 2500));

const route = routes.find(one => one.path === '/dsh-arkhub');
if (!route) {
  console.error('✗ 没挂上状态路由');
  process.exit(1);
}

const res = {
  statusCode: 0,
  body: '',
  writeHead(code) {
    this.statusCode = code;
  },
  end(body) {
    this.body = body;
  },
};

await route.handler(
  { method: 'GET', url: '/dsh-arkhub/status', headers: { host: '127.0.0.1:0' } },
  res,
);

const payload = JSON.parse(res.body || '{}');
const channel = payload.channel || {};
console.log('\n状态路由：');
console.log('  running      ', channel.running);
console.log('  endpoint     ', channel.endpoint);
console.log('  account      ', channel.account);
console.log('  homeBound    ', channel.homeBound, channel.homeSessionId || '');
console.log('  cursor       ', channel.cursor);
console.log('  counts       ', channel.counts);
console.log('  lastError    ', channel.lastError || '（无）');
console.log('  update       ', payload.update?.disabled ? `已关闭（${payload.update.reason}）` : payload.update?.error || payload.update?.latest || '（未查）');

let bad = 0;
const expect = (ok, label) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) bad += 1;
};
console.log('\n判定：');
expect(channel.running === true, '通道在跑（ArkLink 连上了）');
expect(Boolean(channel.account?.uin), `读到账号（uin=${channel.account?.uin || '空'}）`);
expect(Boolean(channel.homeBound), '接上了她原来的家会话（life.json 的 homeSessionId）');
expect(Array.isArray(channel.gates?.allowPrivate) && channel.gates.allowPrivate.length > 0, '白名单生效');

for (const one of effects.reverse()) {
  if (typeof one.dispose === 'function') one.dispose();
}

console.log(bad ? `\n${bad} 项没过` : '\n全过');
process.exit(bad ? 1 : 0);
