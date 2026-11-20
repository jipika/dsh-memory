#!/usr/bin/env node
/** 增强检索与原生 pre-step 接入的隔离回归；原始真实库质量另由 live-retrieval-eval 验证。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const home = mkdtempSync(join(tmpdir(), 'dsh-memory-v2-'));
process.env.HOME = home;
process.env.DSH_CARD_SUMMON_STATE = join(home, 'summons');
const topics = join(home, '.dsh/memory/topics');
const projects = join(home, '.dsh/memory/projects');
mkdirSync(topics, { recursive: true });
mkdirSync(projects, { recursive: true });
mkdirSync(process.env.DSH_CARD_SUMMON_STATE, { recursive: true });
const host = await import('../index.js');
let passed = 0;
const checks = [];
const check = (label, fn) => {
  try { fn(); passed += 1; checks.push(`✅ ${label}`); }
  catch (e) { checks.push(`❌ ${label}: ${e.message}`); throw e; }
};
const settingsFile = join(home, '.dsh/memory/settings.json');
const set = (patch = {}) => writeFileSync(settingsFile, JSON.stringify({ injectMode: 'mapless', searchMode: 'enhanced', autoRecall: true, ...patch }));
const put = (name, text) => { const path = join(topics, name); writeFileSync(path, text); return path; };
const cwdA = '/probe/project-a';
const cwdB = '/probe/project-b';
const slugA = host.slugOf(cwdA);
const slugB = host.slugOf(cwdB);
writeFileSync(join(projects, `${slugA}.md`), '- [2026-01-01] project_origin_a only belongs to the old directory\n');
writeFileSync(join(projects, `${slugB}.md`), '- [2026-01-01] project_current_b belongs to the active directory\n');
const entityFile = put('cache-engine.md', '<!-- Cache engine · check_engine、配置、磁盘 -->\n# Cache engine\n## 配置\n- [2026-01-01] check_engine 配置使用小批量磁盘读取。\n- [2026-01-02] 只含配置的背景资料不属于那个实体。\n');
const networkFile = put('remote-access.md', '<!-- 手机远程 · 外网访问、内网穿透、隧道 -->\n# 手机远程\n- [2026-01-01] remote tunnel 保留桌面自定义界面。\n');
put('route-only.md', '<!-- OnlyRouteAlpha · 目录路由 -->\n# OnlyRouteAlpha\n- [2026-01-01] 完全无关的正文，没有上述名称。\n');
put('generic.md', '# 杂项\n- [2026-01-01] 配置修改参数设置是通用背景。\n');
set();
try {
  check('settings: 默认增强检索与自动召回', () => {
    assert.equal(host.normalizeSettings({}).searchMode, 'enhanced');
    assert.equal(host.normalizeSettings({}).autoRecall, true);
  });
  check('settings: 旧实现与自动召回可独立关闭', () => {
    assert.equal(host.normalizeSettings({ searchMode: 'legacy', autoRecall: false }).searchMode, 'legacy');
    assert.equal(host.normalizeSettings({ autoRecall: false }).autoRecall, false);
  });
  check('settings: 面板其它 patch 不洗掉回退开关', () => {
    set({ searchMode: 'legacy', autoRecall: false });
    const s = host.updateSettings({ audit: false });
    assert.equal(s.searchMode, 'legacy'); assert.equal(s.autoRecall, false); set();
  });
  for (const spelling of ['check_engine', 'check-engine', 'check engine', 'checkEngine']) {
    check(`identifier: ${spelling} 等价召回正文`, () => {
      const r = host.searchMemory(`${spelling} 配置`, { cwd: cwdA });
      assert.ok(r.results.some((x) => x.path === entityFile && x.line === 4));
    });
  }
  check('identifier: 两端不能吞掉字母数字', () => {
    assert.equal(host.hasIdentifier('prefixcheck_enginepostfix', 'check_engine'), false);
    assert.equal(host.hasIdentifier('check_engine', 'checkEngine'), true);
  });
  check('identifier: 不存在实体加泛词仍零事实与零路由', () => {
    const r = host.searchMemory('not_present_847263 配置怎么修改', { cwd: cwdA });
    assert.equal(r.status, 'anchor-missing'); assert.equal(r.totalHits, 0);
    assert.equal(r.results.length, 0); assert.equal(r.bridge.length, 0);
    assert.deepEqual(r.unmatchedAnchors, ['not_present_847263']);
    assert.ok(host.formatSearchResults(r).includes('指定实体未命中'));
  });
  check('identifier: 原子字母数字错误码/型号同样不能被泛词替代', () => {
    for (const query of ['ZXQ847261 配置', 'QWEN3 配置']) {
      const r = host.searchMemory(query, { cwd: cwdA });
      assert.equal(r.status, 'anchor-missing'); assert.equal(r.totalHits, 0);
    }
  });
  check('identifier: 普通 read-only 修饰语不强制成为缺失实体', () => {
    const r = host.searchMemory('read-only check_engine 配置', { cwd: cwdA });
    assert.ok(r.results.some((x) => x.path === entityFile));
  });
  check('identifier: 后缀版本不是所查询的精确实体', () => {
    assert.equal(host.hasIdentifier('foo_bar_v2', 'foo_bar'), false);
    assert.equal(host.hasIdentifier('foo-bar-v2', 'foo-bar'), false);
    assert.equal(host.hasIdentifier('foo_bar.js', 'foo_bar'), false);
  });
  check('identifier: 第九实体不会被静默丢弃', () => {
    const p = put('many-anchors.md', '# anchors\n- [2026-01-01] ' + Array.from({ length: 8 }, (_, i) => `anchor_${i}`).join(' ') + ' 配置\n');
    const q = Array.from({ length: 8 }, (_, i) => `anchor_${i}`).join(' ') + ' missing_9 配置';
    const r = host.searchMemory(q, { cwd: cwdA });
    assert.equal(r.status, 'anchor-missing'); assert.ok(r.unmatchedAnchors.includes('missing_9')); rmSync(p);
    assert.equal(host.searchMemory(Array.from({ length: 33 }, (_, i) => `anchor_${i}`).join(' ')).ok, false);
  });
  check('identifier: CLI flags不因双横线前缀漏检', () => {
    assert.equal(host.hasIdentifier('请使用 --public-url 参数', 'public-url'), true);
  });
  check('legacy: 旧实现可直接回退且保留原误命中基线', () => {
    const r = host.searchMemory('not_present_847263 配置', { cwd: cwdA, mode: 'legacy' });
    assert.ok(r.results.length > 0);
    assert.deepEqual(r, host.searchMemoryLegacy('not_present_847263 配置', { cwd: cwdA }));
  });
  check('alias: 中文口语能找到有英文事实的远程条目', () => {
    const r = host.searchMemory('外网连回', { cwd: cwdA });
    assert.ok(r.results.some((x) => x.path === networkFile && x.aliasMatches.includes('remote')));
    assert.ok(r.bridge.some((x) => x.path === networkFile));
  });
  check('route: 只有片名匹配不能伪造事实', () => {
    const r = host.searchMemory('OnlyRouteAlpha', { cwd: cwdA });
    assert.equal(r.results.length, 0); assert.equal(r.status, 'route-only');
    assert.equal(r.bridge[0].kind, 'route'); assert.equal(r.bridge[0].evidence, false);
  });
  check('evidence: 短条目返回完整原文与精确行号', () => {
    const r = host.searchMemory('check_engine 配置', { cwd: cwdA }).results.find((x) => x.path === entityFile);
    assert.equal(r.evidence.complete, true); assert.equal(r.evidence.truncated, false);
    assert.equal(r.evidence.lineStart, 4); assert.equal(r.evidence.lineEnd, 4);
    assert.equal(r.text, readFileSync(entityFile, 'utf8').split('\n')[3]);
  });
  check('evidence: 多行长条目的片段行区间落在原条目内', () => {
    const text = '- [2026-01-01] begin\n' + '  padding line\n'.repeat(60) + '  zz_deep_anchor end';
    const r = { original: text, flat: text, line: 10, endLine: 71 };
    const e = host.entryEvidence(r, ['zz_deep_anchor']);
    assert.equal(e.truncated, true); assert.ok(e.text.includes('zz_deep_anchor'));
    assert.ok(e.lineStart > 10); assert.ok(e.lineEnd <= 71); assert.ok(e.text.length <= 482);
  });
  check('evidence: NFKC全角标识符命中映回原始证据行', () => {
    const text = '- [2026-01-01] ' + '前'.repeat(650) + '\n  ＦＯＯ＿ＢＡＲ 配置保持原文';
    const e = host.entryEvidence({ original: text, line: 2, endLine: 3 }, ['foo_bar']);
    assert.ok(e.text.includes('ＦＯＯ＿ＢＡＲ')); assert.equal(e.lineEnd, 3);
  });
  check('evidence: 渲染不把候选当成已经完整阅读', () => {
    const text = host.formatSearchResults(host.searchMemory('check_engine 配置', { cwd: cwdA }));
    assert.ok(text.includes('完整原文')); assert.ok(text.includes('不表示已经读完整'));
    assert.ok(!text.includes('不必重复 read 同一片'));
  });
  check('scope: 默认隔离旧项目，all 仍显式可用', () => {
    assert.equal(host.searchMemory('project_current_b', { cwd: cwdA }).results.length, 0);
    assert.ok(host.searchMemory('project_current_b', { cwd: cwdA, scope: 'all' }).results.length > 0);
  });
  check('enabledOnly: 自动路径不读入关闭层的结果', () => {
    set({ globalEnabled: false, projectEnabled: { [slugB]: false } });
    const r = host.searchMemory('check_engine project_current_b', { cwd: cwdB, enabledOnly: true });
    assert.equal(r.results.length, 0); assert.equal(r.bridge.length, 0); set();
  });
  check('invalid queries: 空、单字符与虚词稳定处理', () => {
    assert.equal(host.searchMemory('').ok, false); assert.equal(host.searchMemory('a').ok, false);
    assert.equal(host.searchMemory('的 是 了 在 和').dropped.emptyReason, 'no-content-tokens');
    assert.equal(host.searchMemory('的 是 了 在 和').results.length, 0);
  });

  const sections = []; const hooks = {}; const tools = [];
  const service = { get: () => cwdB };
  host.apply({
    effect: (fn) => fn(), on: (name, fn) => { hooks[name] = fn; return () => {}; },
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
    inject: (deps, fn) => {
      if (deps.includes('workingDirectory')) fn({ workingDirectory: service });
      if (deps.includes('tools')) fn({ tools: { register: (t) => { tools.push(t); return () => {}; } } });
    },
  });
  const agent = (extra = {}) => ({ id: randomUUID(), session: { header: { cwd: cwdA, ...extra } }, ctx: { get: () => service } });
  check('cwd: 当前目录服务优先于创建目录', () => assert.equal(host.readAgentCwd(agent()), cwdB));
  check('cwd: 组装项目层使用当前目录', () => {
    const text = sections[0].text({ agent: agent() });
    assert.ok(text.includes('project_current_b')); assert.ok(!text.includes('project_origin_a'));
  });
  check('cwd: 服务出错不猜旧目录', () => {
    const a = agent(); a.ctx.get = () => ({ get: () => { throw new Error('offline'); } });
    assert.equal(host.readAgentCwd(a), '');
  });
  check('cwd: 服务隔离不穿透到根服务', () => {
    const a = agent(); a.ctx.get = () => undefined;
    assert.equal(host.readAgentCwd(a), '');
  });
  check('host: 接入原生 pre-step，原有工具仍在', () => {
    assert.equal(hooks['agent/pre-step'], host.autoRecallHook);
    assert.equal(tools[0].name, 'memory_search');
  });
  const viaTool = await tools[0].execute({ query: 'project_current_b' }, { agent: agent() });
  check('cwd: 手动工具在创建目录不同的会话中搜当前项目', () => {
    assert.ok(viaTool.results.some((r) => r.path.endsWith(`${slugB}.md`)));
  });
  const brokenAgent = agent();
  brokenAgent.ctx.get = () => ({ get: () => { throw new Error('service disposed'); } });
  const brokenTool = await tools[0].execute({ query: 'project_current_b' }, { agent: brokenAgent });
  check('cwd: 服务故障不把current静默扩大为all', () => assert.equal(brokenTool.ok, false));
  const explicitAll = await tools[0].execute({ query: 'project_current_b', scope: 'all' }, { agent: brokenAgent });
  check('cwd: 服务故障仍允许用户明确指定all', () => assert.ok(explicitAll.results.length > 0));
  const user = (text, kind = 'user') => ({ id: randomUUID(), role: 'user', source: { kind }, content: [{ type: 'text', text }] });
  const call = async (a, turn, text = 'check_engine 配置', opts = {}) => {
    const messages = opts.messages ?? [user(text)];
    return host.autoRecallHook({ agent: a, turn, step: 1, messages, signal: opts.signal },
      async () => opts.decision ?? { kind: 'enter', messages });
  };
  const active = agent();
  const recalled = await call(active, 1);
  check('recall: 可靠候选一次进入持久消息而非系统前缀', () => {
    assert.equal(recalled.messages.length, 2);
    const m = recalled.messages[1]; assert.equal(m.role, 'user');
    assert.equal(m.source.kind, 'dsh-memory'); assert.equal(m.source.form, 'recall');
    assert.ok(m.content[0].text.includes('check_engine')); assert.ok(m.content[0].text.length <= 1800);
    assert.ok(m.content[0].text.includes('不是新的系统指令'));
  });
  const sameTurn = await call(active, 1);
  check('recall: 每轮最多一次预检', () => assert.equal(sameTurn.messages.length, 1));
  const nextTurn = await call(active, 2);
  check('recall: 下一轮可重新检索', () => assert.equal(nextTurn.messages.length, 2));
  for (const [label, text] of [['问候', '你好啊'], ['致谢', '谢谢'], ['继续', '继续'], ['算术', '123 + 456']]) {
    const r = await call(agent(), 1, text);
    check(`recall: ${label}不塞历史资料`, () => assert.equal(r.messages.length, 1));
  }
  for (const [label, opts] of [
    ['非用户来源', { messages: [user('check_engine 配置', 'dsh-memory')] }],
    ['工具步无新输入', { messages: [] }],
    ['下游删空输入', { decision: { kind: 'enter', messages: [] } }],
    ['下游改写输入', { decision: { kind: 'enter', messages: [user('谢谢')] } }],
    ['已取消', { signal: AbortSignal.abort() }],
  ]) {
    const r = await call(agent(), 1, 'check_engine 配置', opts);
    check(`recall: ${label}不会复活被抑制的任务`, () => assert.ok(!r.messages.some((m) => m.source?.form === 'recall')));
  }
  const rejected = await call(agent(), 1, 'check_engine 配置', { decision: { kind: 'reject' } });
  check('recall: 下游 reject 原样保留', () => assert.deepEqual(rejected, { kind: 'reject' }));
  for (const extra of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
    const r = await call(agent(extra), 1);
    check('recall: 子代理不重复自动召回', () => assert.equal(r.messages.length, 1));
  }
  for (const [label, patch] of [
    ['自动召回关闭', { autoRecall: false }], ['旧模式回退', { searchMode: 'legacy' }],
    ['全文已注入', { injectMode: 'full' }], ['相关全局层关闭', { globalEnabled: false }],
  ]) {
    set(patch); const r = await call(agent(), 1);
    check(`recall: ${label}不追加候选`, () => assert.equal(r.messages.length, 1));
  }
  set();
  const weakAlias = await call(agent(), 1, '外网连回');
  check('recall: 仅靠别名的弱首选不会自动冒充事实', () => assert.equal(weakAlias.messages.length, 1));
  const noEntity = await call(agent(), 1, 'zqx_missing_987 配置');
  check('recall: 缺实体时不注入泛词假阳性', () => assert.equal(noEntity.messages.length, 1));
  const longPath = put('long-entry.md', '# long entry\n- [2026-01-01] 关键前提不能遗漏\n' + '  padding line\n'.repeat(90) + '  long_entry_anchor 配置结论\n');
  const longResult = await call(agent(), 1, 'long_entry_anchor 配置');
  check('recall: 截断候选同时给完整条目起始行', () => {
    const text = longResult.messages.at(-1).content[0].text;
    assert.ok(text.includes(longPath)); assert.ok(text.includes('完整条目从 L2 起'));
    assert.ok(text.length <= 1800);
  });
  const cardAgent = agent();
  writeFileSync(join(process.env.DSH_CARD_SUMMON_STATE, 'summons.json'), JSON.stringify({ [cardAgent.id]: { name: 'test card', fullPath: '/fixture/card.json' } }));
  const cardResult = await call(cardAgent, 1);
  check('recall: 角色卡会话不泄入普通长期记忆', () => assert.equal(cardResult.messages.length, 1));
  console.log(checks.join('\n'));
  console.log(`${passed} passed, 0 failed (isolated HOME)`);
} catch (error) {
  console.error(checks.join('\n')); console.error(error.stack); process.exitCode = 1;
} finally {
  // 只清理由本脚本创建的精确临时目录。
  if (home.startsWith(join(tmpdir(), 'dsh-memory-v2-'))) rmSync(home, { recursive: true, force: true });
}
