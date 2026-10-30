// 用**真实的 v4 会话格式编码器**验证编排消息的 source 能落盘。
//
// 这是踩过的真实缺陷：source 写成裸 `{kind:'plugin'}` 会被 v4 硬拒绝
// （`format v4 message requires a producer-owned source kind`），进而让该会话的
// jsonl 持久化整批失败并进入 drainPaused——历史从此不再落盘。fake ctx 测不出这种
// 缺陷，所以这一条必须跑真的 codec。
//
// 用法：node source-kind-test.mjs [codecLibPath]
// codecLibPath 默认指向当前 DSH 安装的 app.asar 解包副本。
import { existsSync, statSync } from 'node:fs';

// 注意：单文件 `npx asar extract-file` 解出来的副本**不能**直接 import（它缺兄弟
// 包 @deepseek-ai/dsh-session-format-v2-to-v3 的解析上下文），所以候选里放的是
// 整包解包出来的目录树。刷新方式：
//   npx --yes asar extract "<…>/resources/app.asar" "<dir>"
// 然后用 --ref 传入单文件解包结果做**同一性**校验（防过期副本）。
const CANDIDATES = [
  process.argv[2] !== undefined && process.argv[2].startsWith('--') ? undefined : process.argv[2],
  'C:/Users/cheng/AppData/Local/Programs/DeepSeek Harness/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js',
  'D:/WorkSpace/_tmp/dual-agent-v2/asar/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js',
].filter((path) => typeof path === 'string' && path !== '');

const codecPath = CANDIDATES.find((path) => existsSync(path));
if (codecPath === undefined) {
  console.log('SKIP: 未找到 v4 会话格式编码器（不是失败，只是本机没解包副本）');
  console.log('     用 npx --yes asar extract "<…>/resources/app.asar" "<dir>" 解一份再跑');
  process.exit(0);
}
// 自报所用文件（路径 + 大小 + mtime）：万一拿到过期副本，输出里看得出。
const codecStat = statSync(codecPath);
console.log(`codec: ${codecPath}`);
console.log(`       ${codecStat.size} bytes, mtime ${new Date(codecStat.mtimeMs).toISOString()}`);

const mod = await import(`file:///${codecPath.replace(/\\/g, '/')}`);
const codec = mod.releasedV4SessionFormatCodec;
if (codec === undefined || typeof codec.encodeEvent !== 'function') {
  console.log('SKIP: 编码器导出形态与预期不同');
  process.exit(0);
}

// 从被测插件真实取用消息构造函数，确保测的就是插件实际投递的形态。
const pluginUrl = new URL('./index.js', import.meta.url);
const pluginSource = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const declared = /kind: 'plugin:[^']+'/.exec(pluginSource)?.[0] ?? '';
const kind = declared.replace("kind: '", '').replace("'", '');
if (kind === '') {
  console.log('FAIL: 插件里找不到 plugin:<name> 形态的 source kind');
  process.exit(1);
}

const failures = [];
const check = (label, condition) => {
  console.log((condition ? 'ok   ' : 'FAIL ') + label);
  if (!condition) failures.push(label);
};

const encode = (source) => codec.encodeEvent({
  type: 'user/message', seq: 0, time: Date.now(),
  data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source },
});

// ① 插件实际用的 kind 必须被 v4 接受
let accepted = true;
try { encode({ kind, form: 'notice' }); } catch (error) {
  accepted = false;
  console.log('  reject reason:', String(error?.message).slice(0, 120));
}
check(`plugin kind "${kind}" is accepted by v4 format`, accepted);

// ② 退役的裸 plugin 包装器必须被拒（回归：不许改回去）
let bareRejected = false;
try { encode({ kind: 'plugin', plugin: 'dsh-dual-agent', form: 'notice' }); } catch { bareRejected = true; }
check('retired bare {kind:"plugin"} is rejected (guard against regression)', bareRejected);

// ③ 人类消息形态仍被接受（孵化监视器依赖它）
let humanAccepted = true;
try { encode({ kind: 'user', rpcId: 'rpc-1' }); } catch { humanAccepted = false; }
check('human {kind:"user",rpcId} is accepted', humanAccepted);

console.log(failures.length === 0 ? '\nSOURCE-KIND TEST PASS' : `\nSOURCE-KIND TEST FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
