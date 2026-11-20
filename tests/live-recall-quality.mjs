#!/usr/bin/env node
/**
 * 原始记忆库的简称与自动召回质量回归；不复制/脱敏语料，不调用模型，不写设置。
 * node tests/live-recall-quality.mjs --check [--before PATH] [--current PATH]
 * 自动部分直接调用钩子，是功能模拟，不是模型回答级评测。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEMORY = join(homedir(), '.dsh/memory');
const CWD = '/Volumes/mac/CodeLibrary/DSH/deepseek';
const args = process.argv.slice(2);
const options = { before: '/tmp/dsh-memory-fix-before-20261104.mjs', current: join(ROOT, 'index.js'), check: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check') options.check = true;
  else if (args[i] === '--before' || args[i] === '--current') {
    const key = args[i].slice(2); if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing ${args[i]}`);
    options[key] = resolve(args[++i]);
  } else throw new Error(`unknown argument ${args[i]}`);
}
const targets = {
  remote: ['topics/dsh-remote-access.md', '自定义 UI 都保留'],
  dedup: ['topics/dsh-codex-effort-slider.md', '模型去重必须按「显示名」而不是 id'],
  sidebar: ['topics/preferences.md', '不喜欢侧边栏自动弹出'],
  settings: ['topics/preferences.md', '插件设置入口按体量分两种座位'],
  activation: ['topics/memory-search-retrieval.md', '插件 host 半改动会自动热重载，不需要重启宿主'],
  mounted: ['topics/preferences.md', '只躺在 dependencies 里的包不会加载'],
  restart: ['topics/preferences.md', '绝对严禁自动重启 DSH 客户端'],
  usage: ['topics/memory-search-retrieval.md', 'memory_search 的真实使用形态'],
  pwa: ['topics/dsh-remote-access.md', 'ManifestFetcher'],
  cwd: ['projects/--Volumes-mac-CodeLibrary-DSH-deepseek--.md', '本目录是**杂项工作区**'],
  bridge: ['topics/memory-search-retrieval.md', '片级桥（用 query 现算 top8 最相关分片）召回远高于条目级检索'],
};
const cases = [
  ['remote-short', '外网连回', 'remote'],
  ['remote-natural', '人在外面，想用手机打开家里的 DSH，还要保留自己改过的界面', 'remote'],
  ['slider-natural', '给思考强度那个滑块换模型时，模型应该按名字去重还是按编号去重', 'dedup'],
  ['sidebar-natural', '我不想任务一跑就把右边栏自己打开', 'sidebar'],
  ['settings-natural', '插件只有一两个开关，设置入口应该挂哪一个槽位', 'settings'],
  ['activation-natural', '刚改了记忆插件，怎样确认宿主确实加载了新代码，不能光看版本号', 'activation'],
  ['mount-natural', '如果一个包只写进依赖列表，但没挂到插件组合树里，会运行吗', 'mounted'],
  ['restart-natural', '我之前说过不要自己重启 DSH，怎么处理需要重载的修改', 'restart'],
  ['usage-natural', '帮我找到我们记过的 memory search 检索调用情况', 'usage'],
  ['pwa-natural', '为什么网页安装应用总是说清单抓不到，是不是登录 cookie 的问题', 'pwa'],
  ['remote-ui-natural', '把远程桌面重新做成手机专用界面，会不会丢失我自定义的 UI', 'remote'],
  ['cwd-natural', '这个目录到底是单个仓库还是放了很多零散项目', 'cwd'],
  ['identifier-short', 'memorySearch 片级桥', 'bridge'],
];
const routeCases = [['remote-access', 'topics/dsh-remote-access.md'], ['effort-slider', 'topics/dsh-codex-effort-slider.md']];
const negatives = ['xyzzy_z987 配置', 'ZXQ847261 配置', 'zqxv-phantom-setting-783219 怎么修改配置'];
const sha = (v) => createHash('sha256').update(v).digest('hex');
const labelsHash = sha(JSON.stringify({ targets, cases, routeCases, negatives }));
const gold = new Map();
for (const [key, [path, anchor]] of Object.entries(targets)) {
  const absolute = join(MEMORY, path);
  const found = readFileSync(absolute, 'utf8').split('\n').flatMap((line, i) => /^- \[\d{4}-\d{2}-\d{2}\]/.test(line) && line.includes(anchor) ? [i + 1] : []);
  if (found.length !== 1) throw new Error(`${key}: original corpus target must resolve uniquely, got ${found.length}`);
  gold.set(key, { path: absolute, line: found[0] });
}
function corpusHash() {
  const paths = new Set();
  const addDir = (dir) => { if (existsSync(dir)) for (const file of readdirSync(dir)) if (file.endsWith('.md') && statSync(join(dir, file)).isFile()) paths.add(join(dir, file)); };
  addDir(join(MEMORY, 'topics'));
  const global = join(dirname(MEMORY), 'memory.md'); if (existsSync(global)) paths.add(global);
  const project = join(MEMORY, 'projects', '--Volumes-mac-CodeLibrary-DSH-deepseek--');
  if (existsSync(project)) addDir(project); else if (existsSync(`${project}.md`)) paths.add(`${project}.md`);
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) hash.update(path).update('\0').update(sha(readFileSync(path))).update('\0');
  return hash.digest('hex');
}
async function evaluate(path) {
  const sourceHash = sha(readFileSync(path));
  const host = await import(pathToFileURL(path).href);
  const settings = host.readSettings();
  if (settings.autoRecall !== true || settings.searchMode !== 'enhanced') throw new Error('quality gate requires autoRecall=true and searchMode=enhanced; cannot pass by disabling recall');
  const result = { sourceHash, entries: [], routes: [], negatives: [], auto: [] };
  for (const [id, query, target] of cases) {
    const expected = gold.get(target);
    const found = host.searchMemory(query, { cwd: CWD, limit: 8 });
    if (!found.ok) throw new Error(`${id}: search error ${found.error}`);
    const rank = found.results.findIndex((r) => r.path === expected.path && r.line === expected.line) + 1;
    result.entries.push({ id, rank: rank || null });
    const message = { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: query }] };
    const agent = { id: randomUUID(), session: { header: { cwd: CWD } }, ctx: { get: (name) => name === 'workingDirectory' ? { get: () => CWD } : undefined } };
    const decision = await host.autoRecallHook({ agent, turn: 1, step: 1, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }));
    const recalls = decision.messages.filter((m) => m.source?.kind === 'dsh-memory' && m.source.form === 'recall');
    if (recalls.length > 1) throw new Error(`${id}: duplicate recall message`);
    const text = recalls[0]?.content?.map((b) => b.text ?? '').join('') ?? '';
    const blocks = [...text.matchAll(/^\[历史记忆候选 · ([^\n]*)\] (.+):(\d+)-(\d+)$/gm)].map((m) => ({
      path: m[2], line: Number(m[1].match(/完整条目从 L(\d+) 起/)?.[1] ?? m[3]),
    }));
    const matching = blocks.filter((b) => b.path === expected.path && b.line === expected.line).length;
    result.auto.push({ id, injected: recalls.length > 0, chars: text.length, facts: blocks.length, matching, unrelated: blocks.length - matching, routeOnly: text.includes('[分片线索') && !blocks.length });
  }
  for (const [query, target] of routeCases) {
    const r = host.searchMemory(query, { cwd: CWD, limit: 8 });
    result.routes.push({ query, entryRank: r.results.findIndex((x) => x.path === join(MEMORY, target)) + 1 || null, routeRank: r.bridge.findIndex((x) => x.path === join(MEMORY, target)) + 1 || null });
  }
  for (const query of negatives) {
    const r = host.searchMemory(query, { cwd: CWD, limit: 8 });
    result.negatives.push({ query, facts: r.results.length, totalHits: r.totalHits });
  }
  result.summary = {
    hitAt8: result.entries.filter((r) => r.rank).length,
    mrrAt8: +(result.entries.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / cases.length).toFixed(4),
    autoInjections: result.auto.filter((r) => r.injected).length,
    autoMatchingFacts: result.auto.reduce((sum, r) => sum + r.matching, 0),
    autoUnrelatedFacts: result.auto.reduce((sum, r) => sum + r.unrelated, 0),
    maxChars: Math.max(...result.auto.map((r) => r.chars)),
  };
  if (sha(readFileSync(path)) !== sourceHash) throw new Error('source changed during evaluation');
  return result;
}
const beforeCorpus = corpusHash();
const before = await evaluate(options.before);
const current = await evaluate(options.current);
if (corpusHash() !== beforeCorpus) throw new Error('original corpus changed during evaluation');
console.log(JSON.stringify({ labelsHash, corpusHash: beforeCorpus, beforeSource: before.sourceHash, currentSource: current.sourceHash }));
for (let i = 0; i < cases.length; i++) console.log(JSON.stringify({ id: cases[i][0], before: { rank: before.entries[i].rank, auto: before.auto[i] }, current: { rank: current.entries[i].rank, auto: current.auto[i] } }));
for (let i = 0; i < routeCases.length; i++) console.log(JSON.stringify({ category: 'short-name', before: before.routes[i], current: current.routes[i] }));
for (let i = 0; i < negatives.length; i++) console.log(JSON.stringify({ category: 'absent-entity', before: before.negatives[i], current: current.negatives[i] }));
console.log(JSON.stringify({ summary: { queries: cases.length, before: before.summary, current: current.summary } }));
const failures = [];
if (current.summary.hitAt8 < before.summary.hitAt8) failures.push('manual recall regressed');
if (current.summary.mrrAt8 < before.summary.mrrAt8) failures.push('manual MRR regressed');
if (current.routes.some((r) => r.routeRank !== 1)) failures.push('short name did not route to correct shard first');
if (current.negatives.some((r) => r.facts || r.totalHits)) failures.push('unknown entity returned unrelated facts');
if (current.summary.autoUnrelatedFacts) failures.push('automatic recall included unrelated fact blocks');
for (const id of ['usage-natural', 'remote-ui-natural']) if (!current.auto.find((r) => r.id === id)?.matching) failures.push(`lost positive automatic case ${id}`);
if (current.summary.maxChars > 1800) failures.push('automatic context budget exceeded');
console.log(`CHECK: ${failures.length ? `FAIL (${failures.join('; ')})` : 'PASS'}`);
console.log('Scope: original-corpus retrieval and direct hook simulation, not model end-to-end correctness.');
if (options.check && failures.length) process.exitCode = 1;
