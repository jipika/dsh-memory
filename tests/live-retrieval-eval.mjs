#!/usr/bin/env node
/**
 * 本机原始记忆库的离线检索评测（Node >= 24；不复制语料、不调用模型）。
 *
 *   node tests/live-retrieval-eval.mjs
 *   node tests/live-retrieval-eval.mjs --check
 *   node tests/live-retrieval-eval.mjs --baseline PATH --current PATH
 *
 * 同版验证（0.9.5）：
 *   node tests/live-retrieval-eval.mjs --current .rollback/retrieval-20261103-1808/index.js
 *
 * 只保存查询、预期路径和短事实锚；运行时读取原库并解析唯一的日期条目行。
 * entry Hit@8 / MRR@8 只认「预期路径 + 精确条目行」；bridge 路由单独计分，
 * 不把「命中同片的其它事实」或「只找到片名」当作事实命中。
 *
 * --check：current 的 entry Hit@8、MRR@8、route Hit@8 均不得低于 baseline；
 *          current 所有不存在标识符负例必须返回 0 条事实（含 totalHits）。
 * 缺失/歧义锚点标 SKIP、从指标分母剔除，但无论是否 --check 均 exit 2。
 * 语料/源码运行中变动、接口错误同样 exit 2；质量门槛失败 exit 1。
 * 默认仅观察，负例非零会清楚报告，不把已有缺陷藏在脚本失败里。
 *
 * 两个实现分别在独立 Node 进程 import，使用相同真实 HOME 和固定 cwd/limit。
 * 子进程启用 Node 文件只读权限，不授予写入/子进程/worker 权限；在 import 前
 * 禁用内置网络入口与 global fetch/WebSocket。不会调用 apply、写设置或写记忆。
 * 输出只含排名、数量、路径和摘要，不输出检索正文；本文件不生成任何报告文件。
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const MEMORY = join(homedir(), '.dsh/memory');
const CWD = '/Volumes/mac/CodeLibrary/DSH/deepseek';
const LIMIT = 8;
const DEFAULT_BASELINE = join(ROOT, '.rollback/retrieval-20261103-1808/index.js');
const PROJECT = 'projects/--Volumes-mac-CodeLibrary-DSH-deepseek--.md';
const topic = (name) => `topics/${name}.md`;
const positive = (id, category, query, path, ...anchors) => ({ id, category, query, path, anchors });

// 2026-11-03 从本机实际条目核验；标签不由任一实现的返回结果反推。
// 同一事实的 identifier 变体故意保留，并在汇总明确报告独立事实数。
const POSITIVES = [
  positive('remote-contract', 'remote', '--public-url --trusted-host 信任栅栏',
    topic('dsh-remote-access'), '官方反代/隧道发布契约', '才是信任栅栏'),
  positive('remote-ui', 'remote', '手机远程 自定义 UI 都保留',
    topic('dsh-remote-access'), '自定义 UI 都保留', '整站同源反代/镜像'),
  positive('remote-colloquial', 'remote', '手机从外网连回电脑，自定义界面都要保留',
    topic('dsh-remote-access'), '自定义 UI 都保留', '整站同源反代/镜像'),
  positive('remote-pwa', 'remote', 'Chrome 安装应用 manifest-parsing-or-network-error',
    topic('dsh-remote-access'), 'ManifestFetcher', '抓清单不带 cookie'),
  positive('preference-tested', 'preference', '我需要你去配置真实的强度，而不是你去参考',
    topic('preferences'), '我需要你去配置真实的强度，而不是你去参考'),
  positive('preference-mounted', 'preference', '只躺在 dependencies 里的包不会加载',
    topic('preferences'), '只躺在 dependencies 里的包不会加载'),
  positive('preference-sidebar', 'preference', 'autoOpenSubagent autoOpenJobs agentOpenTools',
    topic('preferences'), '不喜欢侧边栏自动弹出', 'autoOpenSubagent'),
  positive('preference-transparency', 'preference', '不需要隐藏这个透明',
    topic('preferences'), '不需要隐藏这个透明'),
  positive('preference-client', 'preference', '完全禁止你去改任何客户端的东西你理解吗',
    topic('preferences'), '完全禁止你去改任何客户端的东西你理解吗'),
  positive('preference-backup', 'preference', '不需要你做备份备份内容删掉，我们有git内容',
    topic('preferences'), '不需要你做备份备份内容删掉，我们有git内容'),
  positive('preference-no-restart', 'preference', '绝对严禁自动重启客户端',
    topic('preferences'), '绝对严禁自动重启 DSH 客户端'),
  positive('preference-settings', 'preference', 'settings.general.item 一两项偏好',
    topic('preferences'), '插件设置入口按体量分两种座位', '只有一两项偏好'),
  positive('cwd-shell-records', 'cwd', '拿不到该会话的工作目录 hasCwdRecord',
    topic('workspace-files-tree'), 'sessions store 分批落地', 'hasCwdRecord()'),
  positive('host-route-effective', 'activation', 'host 路由还没生效 HTTP 405',
    topic('workspace-files-tree'), '宿主对未注册的 host 路由回的是 405 而不是 404'),
  positive('host-hmr', 'activation', '插件 host 半改动 自动热重载 不需要重启宿主',
    topic('memory-search-retrieval'), '插件 host 半改动会自动热重载，不需要重启宿主'),
  positive('retrieval-underscore', 'identifier-variant', 'memory_search 片级桥 召回远高于条目级检索',
    topic('memory-search-retrieval'), '片级桥（用 query 现算 top8 最相关分片）召回远高于条目级检索'),
  positive('retrieval-hyphen', 'identifier-variant', 'memory-search 片级桥 召回远高于条目级检索',
    topic('memory-search-retrieval'), '片级桥（用 query 现算 top8 最相关分片）召回远高于条目级检索'),
  positive('retrieval-space', 'identifier-variant', 'memory search 片级桥 召回远高于条目级检索',
    topic('memory-search-retrieval'), '片级桥（用 query 现算 top8 最相关分片）召回远高于条目级检索'),
  positive('retrieval-camel', 'identifier-variant', 'memorySearch 片级桥 召回远高于条目级检索',
    topic('memory-search-retrieval'), '片级桥（用 query 现算 top8 最相关分片）召回远高于条目级检索'),
  positive('mapless-discipline', 'retrieval', 'mapless body 为空串 纪律块',
    topic('memory-search-retrieval'), 'mapless 档若全局层+项目层都不注入', '纪律块'),
  positive('slider-slot', 'identifier', 'conversation.input.model priority -1',
    topic('dsh-codex-effort-slider'), '必改的 slot 适配点', 'priority: -1'),
  positive('slider-dedup', 'identifier', 'modelKey 显示名 福利 必须分属两组',
    topic('dsh-codex-effort-slider'), '模型去重必须按「显示名」而不是 id', '必须与裸名'),
  positive('slider-ime', 'identifier', 'compositionupdate 拼音未上屏即可过滤',
    topic('dsh-codex-effort-slider'), '拼音未上屏即可过滤', 'compositionupdate'),
  positive('cwd-misc', 'cwd', '当前工作目录 杂项工作区 不是单一代码库',
    PROJECT, '本目录是**杂项工作区**（不是单一代码库）'),
  positive('project-migration', 'project', 'zcode-migrate migration-map.json 重跑 --write 覆盖会话',
    PROJECT, 'zcode-migrate/migration-map.json', '覆盖'),
  positive('project-forest', 'project', 'forest-cabin SUN_AZ 太阳方位',
    PROJECT, 'forest-cabin/', 'SUN_AZ'),
  positive('project-pointer', 'project', '目录形态项目层 MEMORY.md 一行指针',
    PROJECT, 'renderProjectPointer()', '一行指针'),
];

// 每例有独立的不存在标识符；运行前在同一真实检索池验证标识符确实不存在。
// 不可因为 query 还带「配置/修改」就把无关事实当成正确返回。
const NEGATIVES = [
  { id: 'absent-bare', query: 'QzvraxCacheDriver847261', absent: 'QzvraxCacheDriver847261' },
  { id: 'absent-config', query: 'VelnoxStreamMux629417 配置', absent: 'VelnoxStreamMux629417' },
  { id: 'absent-modify', query: 'zqxv-phantom-setting-783219 怎么修改配置', absent: 'zqxv-phantom-setting-783219' },
  { id: 'absent-setting', query: 'quorvexRetrievalDriver465827 怎么设置', absent: 'quorvexRetrievalDriver465827' },
  { id: 'absent-parameter', query: 'ulnivar-protocol-592843 修改参数', absent: 'ulnivar-protocol-592843' },
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const norm = (s) => String(s).normalize('NFKC').toLocaleLowerCase();
const samePath = (a, b) => resolve(a) === resolve(b);
const mdFiles = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((name) => name.endsWith('.md'))
    .map((name) => join(dir, name)).filter((path) => fs.statSync(path).isFile()).sort()
  : [];

function corpusSnapshot() {
  // 与本次固定 cwd 的 scope=current 一致，不读取其它项目正文。
  let canonical = CWD;
  try { canonical = fs.realpathSync(CWD); } catch { /* 保持明确指定的 cwd */ }
  const slug = `--${canonical.replace(/^\/+/, '').replace(/[/:]+/g, '-')}--`;
  const projectDir = join(MEMORY, 'projects', slug);
  const projectSingle = `${projectDir}.md`;
  const files = new Set(mdFiles(join(MEMORY, 'topics')));
  const globalSingle = join(dirname(MEMORY), 'memory.md');
  if (fs.existsSync(globalSingle)) files.add(globalSingle);
  const projectFiles = mdFiles(projectDir);
  if (projectFiles.length) projectFiles.forEach((path) => files.add(path));
  else if (fs.existsSync(projectSingle)) files.add(projectSingle);
  const digest = createHash('sha256');
  const collisions = [];
  for (const path of [...files].sort()) {
    const body = fs.readFileSync(path);
    digest.update(path).update('\0').update(sha256(body)).update('\0');
    const text = norm(body.toString('utf8'));
    for (const test of NEGATIVES) {
      if (text.includes(norm(test.absent))) collisions.push(`${test.id}: ${path}`);
    }
  }
  return { hash: digest.digest('hex'), files: files.size, collisions };
}

function resolveGold(test) {
  const path = join(MEMORY, test.path);
  try {
    const matches = fs.readFileSync(path, 'utf8').split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => /^\s*-\s+\[\d{4}-\d{2}-\d{2}\]/.test(text)
        && test.anchors.every((anchor) => text.includes(anchor)));
    if (matches.length !== 1) return { ...test, path, skip: `锚点命中 ${matches.length} 条（应唯一）` };
    return { ...test, path, line: matches[0].line };
  } catch (error) {
    return { ...test, path, skip: `目标不可读: ${error.code ?? error.message}` };
  }
}

function disableNetwork() {
  const deny = () => { throw new Error('live eval 禁止网络调用'); };
  for (const [module, methods] of [
    [http, ['request', 'get', 'createServer']],
    [https, ['request', 'get', 'createServer']],
    [http2, ['connect', 'createServer', 'createSecureServer']],
    [net, ['connect', 'createConnection', 'createServer']],
    [tls, ['connect', 'createServer']],
    [dgram, ['createSocket']],
  ]) for (const method of methods) module[method] = deny;
  net.Socket.prototype.connect = deny;
  net.Server.prototype.listen = deny;
  for (const object of [dns, dns.promises]) {
    for (const key of Object.keys(object)) {
      if (/^(lookup|resolve|reverse|setServers)/.test(key) && typeof object[key] === 'function') object[key] = deny;
    }
  }
  globalThis.fetch = deny;
  globalThis.WebSocket = class { constructor() { deny(); } };
  globalThis.EventSource = class { constructor() { deny(); } };
  syncBuiltinESMExports();
}

async function worker(path) {
  if (!process.permission || process.permission.has('fs.write', MEMORY)) {
    throw new Error('worker 必须启用 Node 只读文件权限');
  }
  disableNetwork();
  const sourceHash = sha256(fs.readFileSync(path));
  const before = corpusSnapshot();
  const host = await import(pathToFileURL(path).href);
  if (typeof host.searchMemory !== 'function' || typeof host.formatSearchResults !== 'function') {
    throw new Error(`${path} 缺少 searchMemory/formatSearchResults 导出`);
  }
  const rows = [];
  let scanned;
  for (const test of [...POSITIVES, ...NEGATIVES]) {
    const value = await host.searchMemory(test.query, { cwd: CWD, limit: LIMIT });
    if (value?.ok !== true || !Array.isArray(value.results) || !Array.isArray(value.bridge)
      || value.results.length > LIMIT || value.bridge.length > LIMIT
      || value.scanned?.scope !== 'current' || !Number.isInteger(value.totalHits)) {
      throw new Error(`${test.id}: 检索接口/作用域不符合约定`);
    }
    if (typeof host.formatSearchResults(value) !== 'string') throw new Error(`${test.id}: formatter 非文本`);
    const scan = JSON.stringify(value.scanned);
    if (scanned && scanned !== scan) throw new Error('同次运行的扫描池发生变化');
    scanned = scan;
    // 丢掉正文预览，仅将排名所需元数据传回父进程。
    rows.push({ id: test.id, totalHits: value.totalHits,
      results: value.results.map(({ path, line }) => ({ path, line })),
      bridge: value.bridge.map(({ path }) => ({ path })) });
  }
  if (sha256(fs.readFileSync(path)) !== sourceHash) throw new Error('实现源码在运行中改变，结果无效');
  const after = corpusSnapshot();
  if (before.hash !== after.hash) throw new Error('原始语料在运行中改变，结果无效，请重跑');
  process.stdout.write(JSON.stringify({ sourceHash, corpus: after, scanned: JSON.parse(scanned), rows }));
}

function runWorker(path) {
  const child = spawnSync(process.execPath,
    ['--permission', '--allow-fs-read=*', SELF, '--internal-worker', path], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1' },
    });
  if (child.error || child.status !== 0) {
    throw new Error(`${basename(path)} worker 失败: ${child.error?.message ?? child.stderr.trim() ?? child.signal}`);
  }
  return JSON.parse(child.stdout);
}

const rank = (items, predicate) => {
  const i = items.slice(0, LIMIT).findIndex(predicate);
  return i < 0 ? null : i + 1;
};
const displayed = (value) => value === null ? '-' : String(value);
function score(run, gold) {
  const rows = new Map(run.rows.map((row) => [row.id, row]));
  const cases = gold.filter((test) => !test.skip).map((test) => {
    const row = rows.get(test.id);
    return { id: test.id,
      entry: rank(row.results, (r) => samePath(r.path, test.path) && r.line === test.line),
      route: rank(row.bridge, (r) => samePath(r.path, test.path)) };
  });
  const hit = cases.filter((test) => test.entry !== null).length;
  const routeHit = cases.filter((test) => test.route !== null).length;
  const reciprocalSum = cases.reduce((sum, test) => sum + (test.entry ? 1 / test.entry : 0), 0);
  const negative = NEGATIVES.map((test) => {
    const row = rows.get(test.id);
    return { id: test.id, returned: row.results.length, totalHits: row.totalHits, routes: row.bridge.length };
  });
  return { cases, hit, routeHit, count: cases.length,
    hitRate: cases.length ? hit / cases.length : 0,
    mrr: cases.length ? reciprocalSum / cases.length : 0,
    routeRate: cases.length ? routeHit / cases.length : 0, negative };
}

function parseArgs() {
  const out = { baseline: DEFAULT_BASELINE, current: join(ROOT, 'index.js'), check: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--baseline' || arg === '--current') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少路径`);
      out[arg.slice(2)] = resolve(value);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

function main() {
  const options = parseArgs();
  if (options.help) {
    console.log('用法: node tests/live-retrieval-eval.mjs [--baseline PATH] [--current PATH] [--check]');
    console.log('默认 baseline=.rollback/retrieval-20261103-1808/index.js；current=index.js（均相对脚本所在插件根目录）。');
    console.log('显式传入的相对路径按命令工作目录解析；只读本机原库，cwd=deepseek，limit=8。');
    console.log('--check 开启不退化及负例零事实门槛；缺失目标一律 SKIP 并 exit 2。');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node >=24 的 --permission 支持');
  const before = corpusSnapshot();
  const gold = POSITIVES.map(resolveGold);
  if (before.collisions.length) throw new Error(`负例标识符已存在，标签必须复核:\n${before.collisions.join('\n')}`);
  const baseline = runWorker(options.baseline);
  const current = runWorker(options.current);
  const after = corpusSnapshot();
  if ([baseline.corpus.hash, current.corpus.hash, after.hash].some((hash) => hash !== before.hash)) {
    throw new Error('baseline/current 没有读取同一份语料，结果无效，请重跑');
  }
  const a = score(baseline, gold);
  const b = score(current, gold);
  const currentRows = new Map(b.cases.map((row) => [row.id, row]));
  const valid = gold.filter((test) => !test.skip);
  const facts = new Set(valid.map((test) => `${test.path}:${test.line}`));
  console.log(`live corpus | cwd=${CWD} | limit=${LIMIT} | scope=current`);
  console.log(`语料: ${before.files} 文件 / ${baseline.scanned.entries} 条目 | sha256=${before.hash}`);
  console.log(`标签: ${POSITIVES.length} 正例 / ${facts.size} 独立目标事实 / ${NEGATIVES.length} 负例 | sha256=${sha256(JSON.stringify({ POSITIVES, NEGATIVES }))}`);
  console.log(`baseline: ${options.baseline}\n  sha256=${baseline.sourceHash}`);
  console.log(`current:  ${options.current}\n  sha256=${current.sourceHash}`);
  if (baseline.sourceHash === current.sourceHash) console.log('同版验证：两个源码 SHA256 相同（不是改进效果结论）。');
  console.log('\n正例排名（entry=精确事实；route=bridge 中预期片；- 表示 top8 未命中）');
  console.log('case                         entry B→C  route B→C  query');
  for (const test of gold) {
    if (test.skip) { console.log(`SKIP ${test.id}: ${test.skip} | ${test.path}`); continue; }
    const x = a.cases.find((row) => row.id === test.id);
    const y = currentRows.get(test.id);
    console.log(`${test.id.padEnd(28)} ${displayed(x.entry)}→${displayed(y.entry)}        ${displayed(x.route)}→${displayed(y.route)}        ${test.query}`);
    console.log(`  expected: ${test.path}:${test.line}`);
  }
  console.log('\n负例（返回事实数 / totalHits；route 数另列，不当事实）');
  for (let i = 0; i < NEGATIVES.length; i++) {
    const x = a.negative[i]; const y = b.negative[i];
    console.log(`${x.id.padEnd(28)} ${x.returned}/${x.totalHits}→${y.returned}/${y.totalHits}  routes ${x.routes}→${y.routes}  ${NEGATIVES[i].query}`);
  }
  const summary = (label, s) => console.log(`${label.padEnd(8)} entry Hit@8=${s.hit}/${s.count} (${(s.hitRate * 100).toFixed(2)}%)  MRR@8=${s.mrr.toFixed(4)}  shard route Hit@8=${s.routeHit}/${s.count} (${(s.routeRate * 100).toFixed(2)}%)`);
  console.log('\n汇总（只计非 SKIP 正例；route 仅统计 bridge，绝不并入 entry）');
  summary('baseline', a); summary('current', b);
  for (const [label, s] of [['baseline', a], ['current', b]]) {
    console.log(`${label.padEnd(8)} negatives: ${s.negative.filter((n) => n.returned === 0 && n.totalHits === 0).length}/${NEGATIVES.length} 零事实；返回事实共 ${s.negative.reduce((sum, n) => sum + n.returned, 0)} 条`);
  }
  const failures = [];
  if (b.hit < a.hit) failures.push('current entry Hit@8 低于 baseline');
  if (b.mrr + 1e-12 < a.mrr) failures.push('current MRR@8 低于 baseline');
  if (b.routeHit < a.routeHit) failures.push('current shard route Hit@8 低于 baseline');
  for (const n of b.negative) if (n.returned !== 0 || n.totalHits !== 0) failures.push(`${n.id} 返回了事实`);
  console.log(`质量门槛 ${options.check ? 'CHECK' : 'OBSERVE'}: ${failures.length ? `FAIL (${failures.join('；')})` : 'PASS'}`);
  console.log('边界：本评测只验证离线检索，不代表模型端到端理解或使用记忆的质量。');
  if (gold.some((test) => test.skip)) { console.log('存在 SKIP，目标未齐，退出 2。'); process.exitCode = 2; }
  else if (options.check && failures.length) process.exitCode = 1;
}

try {
  if (process.argv[2] === '--internal-worker') await worker(resolve(process.argv[3]));
  else main();
} catch (error) {
  console.error(`live retrieval eval ERROR: ${error.message}`);
  process.exitCode = 2;
}
