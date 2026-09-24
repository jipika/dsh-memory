#!/usr/bin/env node
/**
 * 把 ~/.dsh/memory.md（单文件、58k）迁移成 ~/.dsh/memory/topics/*.md 分片 + 索引导航。
 *
 * 分类是按**语义**人工指定的（关键词匹配在这个数据集上完全不可用：记忆条目会在
 * 一句话里同时提到插件、profile、playwright —— 规则分出来的片没法看）。
 * 行号对应当前版本的 memory.md（133 行），一次性迁移用，之后没人再依赖它。
 *
 * 用法：node migrate_memory.mjs          干跑（只打印计划）
 *       node migrate_memory.mjs --write  真写（先备份 memory.md，可回滚）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const MEM = `${HOME}/.dsh/memory.md`;
const TOPICS = `${HOME}/.dsh/memory/topics`;
const WRITE = process.argv.includes("--write");

/** 行号 → 分片。人工分类结果。 */
const MAP = {
  preferences: [14, 15, 16, 17],
  "memory-system": [20, 21, 55, 56, 57, 58, 112],
  "dsh-platform": [52, 53, 76, 77, 117, 119, 129, 130, 131],
  plugins: [22, 33, 59, 69, 92, 95, 96, 98, 103, 105, 115, 116],
  "config-sync": [25, 32, 34, 35, 45, 83, 85, 87],
  "plugin-dev": [24, 67, 68, 75, 81, 89, 99, 121, 122, 123, 126],
  "ui-and-sidebar": [23, 37, 38, 39, 41, 42, 101, 102, 124, 125, 127, 132],
  performance: [44, 47, 48, 49, 50, 120],
  "browser-and-mcp": [63, 64, 65, 66, 91, 93, 118],
  "models-and-automation": [54, 60, 62, 70, 71, 72, 73, 74, 79, 107, 108, 109, 113, 114],
};

/** 分片 → [中文标题, 一句话范围说明]。 */
const META = {
  preferences: ["用户偏好", "用户明确表达过的偏好与红线"],
  "memory-system": ["记忆与提示注入", "dsh-memory 插件、记忆文件结构、系统提示分段来源"],
  "dsh-platform": ["DSH 平台环境", "版本/profile、会话与工作区、日志位置、系统权限、诊断手法"],
  plugins: ["插件安装与挂载", "装了什么、挂载机制、版本与升级、bundle 重写这类坑"],
  "config-sync": ["配置同步与备份", "config-manager、跨机同步、备份覆盖范围"],
  "plugin-dev": ["插件开发与发布", "自研插件、客户端插件写法、hook 管线、发布"],
  "ui-and-sidebar": ["UI 与侧边栏", "样式修复、布局诊断、侧边栏 DOM/slot、主题"],
  performance: ["性能与渲染", "卡顿排查、虚拟滚动、渲染类插件"],
  "browser-and-mcp": ["浏览器与 MCP", "Browser Use、Computer Use、playwright、附件上传"],
  "models-and-automation": ["模型与自动化", "provider/API、思考强度、搜索后端、定时任务"],
};

/** 按行号解析条目块（含缩进续行与代码围栏），返回 Map<行号, 文本>。 */
function parseBlocks(text) {
  const lines = text.split("\n");
  const blocks = new Map();
  let fence = false;
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*```/.test(ln)) {
      fence = !fence;
      i += 1;
      continue;
    }
    if (fence) {
      i += 1;
      continue;
    }
    if (/^\s*-\s+\S/.test(ln)) {
      const start = i;
      const buf = [ln];
      i += 1;
      while (i < lines.length) {
        const nx = lines[i];
        if (/^\s*```/.test(nx)) {
          fence = !fence;
          buf.push(nx);
          i += 1;
          continue;
        }
        if (!fence && (nx.trim() === "" || /^##\s+/.test(nx) || /^\s*-\s+\S/.test(nx))) break;
        buf.push(nx);
        i += 1;
      }
      if (fence) fence = false;
      blocks.set(start + 1, buf.join("\n").replace(/\s+$/, ""));
      continue;
    }
    i += 1;
  }
  return blocks;
}

const text = readFileSync(MEM, "utf8");
const blocks = parseBlocks(text);
const assigned = new Map();
for (const [shard, lineNos] of Object.entries(MAP)) {
  for (const n of lineNos) {
    if (!blocks.has(n)) {
      console.error(`✗ 分片 ${shard} 指定的行号 L${n} 不是一个条目（解析到的条目：${[...blocks.keys()].join(",")}）`);
      process.exit(1);
    }
    if (assigned.has(n)) {
      console.error(`✗ L${n} 被重复分配`);
      process.exit(1);
    }
    assigned.set(n, shard);
  }
}
const missing = [...blocks.keys()].filter((n) => !assigned.has(n));
if (missing.length) {
  console.error(`✗ 有条目没被分配：${missing.join(",")}`);
  process.exit(1);
}

console.log(`源文件 ${MEM}：${text.length} 字符 / ${text.split("\n").length} 行`);
console.log(`解析到 ${blocks.size} 个条目，全部分配完毕\n`);

const files = [];
for (const [shard, lineNos] of Object.entries(MAP)) {
  const [title, desc] = META[shard];
  const sorted = [...lineNos].sort((a, b) => a - b);
  const body = sorted.map((n) => blocks.get(n)).join("\n\n");
  const content = `<!-- ${title} · ${desc} -->\n<!-- 写入方式：在本文件末尾按分组追加一行 \`- [YYYY-MM-DD] 事实\` -->\n\n${body}\n`;
  files.push({ shard, title, desc, count: sorted.length, chars: body.length, content });
}
files.sort((a, b) => b.count - a.count);
for (const f of files) {
  console.log(`  topics/${f.shard}.md`.padEnd(36) + `${String(f.count).padStart(3)} 条 · ${String(f.chars).padStart(6)} 字符  ${f.title}`);
}
const totalChars = files.reduce((n, f) => n + f.chars, 0);
console.log(`\n合计 ${files.reduce((n, f) => n + f.count, 0)} 条 · ${totalChars} 字符（源文件条目正文合计）`);

if (!WRITE) {
  console.log("\n（干跑结束。加 --write 才会真写，届时会先备份 memory.md）");
  process.exit(0);
}

// ── 真写 ────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
copyFileSync(MEM, `${MEM}.bak-${stamp}`);
mkdirSync(TOPICS, { recursive: true });
for (const f of files) writeFileSync(`${TOPICS}/${f.shard}.md`, f.content, "utf8");

const nav = [
  "<!-- 本文件已改为索引导航；正文分片在 ~/.dsh/memory/topics/*.md —— 由 dsh-memory 插件注入。 -->",
  `<!-- 备份：${MEM}.bak-${stamp}　迁出：${totalChars} 字符 / ${files.reduce((n, f) => n + f.count, 0)} 条 -->`,
  "",
  "# 全局记忆导航",
  "",
  "正文已按主题分片到 `~/.dsh/memory/topics/`。**新记忆写进对应的片**（追加一行 `- [YYYY-MM-DD] 事实`）：",
  "",
  "| 主题 | 条数 | 文件 |",
  "| --- | --- | --- |",
  ...files.map((f) => `| ${f.title} | ${f.count} | [${f.shard}.md](topics/${f.shard}.md) |`),
  "",
  "旧版全文备份：`memory.md.bak-" + stamp + "`（归档到 `~/.dsh/memory-archive.md` 也行）",
  "",
].join("\n");
writeFileSync(MEM, nav, "utf8");

console.log(`\n✅ 已写入 ${files.length} 个分片到 ${TOPICS}/`);
console.log(`✅ memory.md 已改为索引导航；原文件备份在 ${MEM}.bak-${stamp}`);
