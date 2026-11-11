/**
 * 配对令牌的生成 / 持久化 / 比较自测。
 *
 * 用 PRTS_OMNI_BRIDGE_HOME 把数据目录指到临时目录，绝不碰用户 home。
 *
 * 运行：node --test test/token-test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadOrCreateToken, resolveDataDir, tokenFilePath, tokensMatch } from '../lib/token.js?v=1';

let root;
let counter = 0;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prts-token-'));
  counter += 1;
  process.env.PRTS_OMNI_BRIDGE_HOME = join(root, `case-${counter}`);
});

test.afterEach(async () => {
  delete process.env.PRTS_OMNI_BRIDGE_HOME;
  await rm(root, { recursive: true, force: true });
});

test('默认数据目录是 ~/.prts-omni-bridge', () => {
  delete process.env.PRTS_OMNI_BRIDGE_HOME;
  assert.match(resolveDataDir({}), /\.prts-omni-bridge$/u);
  assert.match(tokenFilePath({}), /\.prts-omni-bridge[\\/]token\.json$/u);
});

test('环境变量可以覆盖数据目录', () => {
  assert.equal(resolveDataDir({ PRTS_OMNI_BRIDGE_HOME: '/x/y' }), '/x/y');
});

test('首次启动生成 256 位令牌并落盘', async () => {
  const result = await loadOrCreateToken();
  assert.equal(result.created, true);
  assert.match(result.token, /^[0-9a-f]{64}$/u);
  const raw = await readFile(result.path, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.token, result.token);
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.createdAt, 'number');
});

test('重复调用复用同一个令牌（幂等）', async () => {
  const first = await loadOrCreateToken();
  const second = await loadOrCreateToken();
  assert.equal(second.created, false);
  assert.equal(second.token, first.token);
  assert.equal(second.path, first.path);
});

test('令牌文件尽量收窄到 0600（POSIX）', async () => {
  if (process.platform === 'win32') return; // Windows ACL 由用户目录继承，chmod 近似无效
  const result = await loadOrCreateToken();
  const info = await stat(result.path);
  assert.equal(info.mode & 0o777, 0o600);
});

test('损坏的令牌文件会重新生成而不是抛错', async () => {
  const dir = process.env.PRTS_OMNI_BRIDGE_HOME;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'token.json'), '{ not json', 'utf8');
  const result = await loadOrCreateToken();
  assert.equal(result.created, true);
  assert.match(result.token, /^[0-9a-f]{64}$/u);
});

test('过短或带空白的存量令牌被视为无效并重新生成', async () => {
  const dir = process.env.PRTS_OMNI_BRIDGE_HOME;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'token.json'), JSON.stringify({ token: 'short' }), 'utf8');
  const result = await loadOrCreateToken();
  assert.equal(result.created, true);

  await writeFile(join(dir, 'token.json'), JSON.stringify({ token: 'a'.repeat(64) + ' ' }), 'utf8');
  const second = await loadOrCreateToken();
  assert.equal(second.created, true);
});

test('tokensMatch 恒定时间比较且长度不同直接 false', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'abcd'), false);
  assert.equal(tokensMatch('', ''), true);
  assert.equal(tokensMatch('abc', undefined), false);
  assert.equal(tokensMatch(undefined, 'abc'), false);
});
