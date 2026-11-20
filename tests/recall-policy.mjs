#!/usr/bin/env node
/** 简称解析与自动事实认证的独立边界回归；仅使用隔离 HOME。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const home = mkdtempSync(join(tmpdir(), 'dsh-recall-policy-'));
process.env.HOME = home;
process.env.DSH_CARD_SUMMON_STATE = join(home, 'summons');
const topics = join(home, '.dsh/memory/topics');
mkdirSync(topics, { recursive: true });
writeFileSync(join(home, '.dsh/memory/settings.json'), JSON.stringify({ injectMode: 'mapless', searchMode: 'enhanced', autoRecall: true }));
const host = await import('../index.js');
const cwd = '/policy/workspace';
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`✅ ${name}`); };
const put = (name, text) => { const path = join(topics, name); writeFileSync(path, text); return path; };
const search = (query) => host.searchMemory(query, { cwd, limit: 8 });
const call = async (text) => {
  const message = { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
  const agent = { id: randomUUID(), session: { header: { cwd } }, ctx: { get: () => ({ get: () => cwd }) } };
  const decision = await host.autoRecallHook({ agent, turn: 1, step: 1, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }));
  return decision.messages.find((m) => m.source?.form === 'recall')?.content[0].text ?? '';
};
try {
  const parser = put('dsh-widget-parser.md', '# dsh-widget-parser\n- [2026-01-01] dsh-widget-parser 配置使用蓝色，去重按名称。\n');
  for (const query of ['widget-parser', 'widget_parser', 'widgetParser']) {
    check(`subject alias: ${query} 可路由声明名称`, () => {
      const r = search(query);
      assert.equal(r.bridge[0]?.path, parser);
      assert.ok(r.resolvedAliases.some((a) => a.requested === query && a.canonical === 'dsh-widget-parser'));
      assert.ok(r.results.some((a) => a.path === parser));
    });
  }
  check('strict entity: 解析简称不放宽正文精确边界', () => {
    assert.equal(host.hasIdentifier('dsh-widget-parser', 'widget-parser'), false);
    assert.equal(host.hasIdentifier('foo_bar_v2', 'foo_bar'), false);
  });
  check('subject alias: 只有声明的分片名称可产生别名', () => {
    const p = put('background.md', '# 背景\n- [2026-01-01] mentions random-tool-engine here 配置。\n');
    const r = search('tool-engine');
    assert.equal(r.status, 'anchor-missing'); rmSync(p);
  });
  check('subject alias: 不能截掉版本后缀', () => {
    const p = put('foo_bar_v2.md', '# foo_bar_v2\n- [2026-01-01] foo_bar_v2 配置仍属版本2。\n');
    assert.equal(search('foo_bar 配置').status, 'anchor-missing');
    assert.ok(search('foo_bar_v2 配置').results.some((r) => r.path === p));
    rmSync(p);
  });
  check('subject alias: 不把缺少的版本号补出来', () => assert.equal(search('widget-parser-v9 配置').status, 'anchor-missing'));
  check('subject alias: 单个普通词不登记名称简称', () => assert.equal(search('parser').resolvedAliases.length, 0));
  check('unknown entity: 有配置等泛词也保持零误返回', () => {
    const r = search('missing_widget_914083 配置');
    assert.equal(r.status, 'anchor-missing'); assert.equal(r.results.length, 0); assert.equal(r.bridge.length, 0);
  });
  check('subject alias: 候选明确不是精确实体事实认证', () => {
    const r = search('widget-parser 配置').results.find((r) => r.path === parser);
    assert.ok(r); assert.equal(r.confidence, 'candidate'); assert.equal(r.recall.eligible, false);
  });
  const short = await call('之前 widget-parser 配置');
  check('recall: 仅名称简称时只可给路由而非事实', () => {
    assert.ok(short.includes('[分片线索')); assert.ok(!short.includes('[历史记忆候选'));
  });
  const incidental = put('background-literal.md', '# 背景说明\n- [2026-01-01] widget-parser 配置只是历史旁注。\n');
  const incidentalResult = await call('widget-parser 配置');
  check('recall: 其它片正文偶然出现简称也不能冒充精确主题', () => assert.ok(!incidentalResult.includes('[历史记忆候选')));
  rmSync(incidental);
  const other = put('mcp-widget-parser.md', '# mcp-widget-parser\n- [2026-01-01] mcp-widget-parser 配置使用绿色。\n');
  check('subject alias: 命名歧义保留两个候选，不伪造唯一实体', () => {
    const r = search('widget-parser');
    assert.ok(r.resolvedAliases.some((a) => a.path === parser)); assert.ok(r.resolvedAliases.some((a) => a.path === other));
    assert.ok(r.results.every((r) => r.confidence !== 'high'));
  });
  const ambiguous = await call('之前 widget-parser 配置');
  check('recall: 有歧义的简称不自动注入事实', () => assert.ok(!ambiguous.includes('[历史记忆候选')));
  rmSync(other);

  const exact = put('engine.md', '<!-- Engine · widget_engine -->\n# Engine\n- [2026-01-01] widget_engine 配置使用单个队列。\n');
  const correct = await call('widget_engine 配置');
  check('recall: 精确实体和正文意图仍可自动注入', () => assert.ok(correct.includes(`${exact}:3-3`)));
  const namespaced = put('dsh-widget-engine.md', '# dsh-widget-engine\n- [2026-01-01] dsh-widget-engine 配置描述其它主题。\n');
  check('recall: 别处可推导简称，不会封禁本片明确声明的精确实体', () => {
    const r = search('widget_engine 配置').results.find((r) => r.path === exact);
    assert.ok(r.recall.eligible);
  });
  rmSync(namespaced);
  const badIntent = await call('widget_engine 去重');
  check('recall: 实体存在但意图不在正文时不自动注入', () => assert.ok(!badIntent.includes('[历史记忆候选')));
  const noIntent = await call('widget_engine');
  check('recall: 只有实体名称时不冒充意图已满足', () => assert.ok(!noIntent.includes('[历史记忆候选')));
  const generic = put('generic-dsh.md', '# DSH\n- [2026-01-01] DSH alpha bravo 配置说明。\n');
  const genericResult = await call('DSH alpha bravo');
  check('recall: DSH片名加两个稀有词不构成独立主题证据', () => assert.ok(!genericResult.includes('[历史记忆候选')));
  rmSync(generic);
  const overlap = put('custom.md', '# 自定义界面\n- [2026-01-01] 自定义界面保持原样。\n');
  const overlapResult = await call('自定义界面');
  check('recall: 重叠中文双字片段不能重复计证据', () => assert.ok(!overlapResult.includes('[历史记忆候选')));
  rmSync(overlap);
  const synonyms = put('remote.md', '# 远程 remote\n- [2026-01-01] 远程 remote 保持连接。\n');
  const synonymResult = await call('远程 remote');
  check('recall: 同一组中英同义词不能重复计证据', () => assert.ok(!synonymResult.includes('[历史记忆候选')));
  rmSync(synonyms);
  const memory = put('memory-search.md', '# memory search\n- [2026-01-01] memory search 调用次数为本机记录。\n');
  const memoryResult = await call('memory search 调用情况');
  check('recall: 两个独立主题与正文动作一致仍可通过', () => assert.ok(memoryResult.includes(`${memory}:2-2`)));
  check('recall: 所有注入仍受1800字符约束', () => assert.ok(correct.length <= 1800 && memoryResult.length <= 1800 && short.length <= 1800));
  console.log(`${passed} passed, 0 failed (isolated HOME)`);
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (home.startsWith(join(tmpdir(), 'dsh-recall-policy-'))) rmSync(home, { recursive: true, force: true });
}
