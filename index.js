import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// dsh-memory —— 两层长期记忆注入（全局 + 按项目）+ 全局规则文件，带开关，全部实时。
//
// 与 cordis.patch.yml 里 personaPrefix 的 !!js 写法相比，关键差别：
//   · personaPrefix 的 !!js 只在 **boot 时求值一次** → 写完记忆必须重启才注入；
//   · 这里的 text 是函数 → **每次 assemble() 重新求值** → 写完即生效，且能读当前工作区。
//
// 两层结构：
//   GLOBAL   ~/.dsh/memory.md                                  跨项目（用户偏好 / 环境事实 / 通用坑）
//   PROJECT  ~/.dsh/memory/projects/<slug>/                    仅该项目
//              ├── MEMORY.md     ← 注入这一份（它是索引：- [标题](文件.md) — 摘要）
//              └── *.md          ← 主题文件，需要细节时由 agent 直接读
//            或 <slug>.md        ← 单文件形式（向后兼容）
// 项目 slug 规则与 DSH 的会话目录一致：cwd 的 '/' → '-'，两端加 '--'。
//
// 开关存 ~/.dsh/memory/settings.json（面板改、手改文件都即刻生效；注入与钩子每次现读）：
//   globalEnabled   布尔，默认 true   关掉则全局层不注入
//   projectEnabled  字典 slug→布尔    关掉的项目不注入；再次开启即刻重新读取
//   maxChars        数字，默认 24000   每层注入的字符预算；0 = 不限制（全量注入）
//
// 超预算时的注入策略（见 clamp）：保头部 + 附**溢出条目索引**（带全文行号，可按行号
// read 取回），而不是从中间一刀切掉、剩下部分毫无线索。
//
// 零额外 LLM 成本：不调用任何模型，只读 markdown 文件；写入由当前会话的 agent 顺手完成，
// 或者由「设置 → 记忆」面板直接改（host 半的写路由）。
//
// HTTP（host 半，供设置面板用；路径全部走白名单解析，越不出记忆目录与规则文件）：
//   GET  /dsh-memory/content?target=global|rules|<slug>[&file=<名>][&format=text]
//   POST /dsh-memory/write   { target, file, text }   需要头 x-dsh-memory: 1
//   GET  /dsh-memory/settings                          开关当前值 + 已知项目
//   POST /dsh-memory/settings  { patch }               合并写开关，需要头 x-dsh-memory: 1
//
// 钩子（v0.5.0 起，settings 的 dsh-memory 节可配）：
//   writeGuard         "rules"(默认) = 内置规则引擎；"full" = 规则 + 外部命令；"off" = 不拦
//   writeHookCommand   外部判定命令（writeGuard:"full" 时生效）：stdin 进 payload JSON，
//                      exit 2 = deny（stderr 为原因）、exit 0 + stdout JSON {decision,reason}
//                      （兼容 hookSpecificOutput.permissionDecision）—— 可接任意 LLM 脚本
//                      做「这条值不值得记」的语义判断
//   hookTimeoutMs      外部命令超时（默认 10000）
//   readReminder       read 命中记忆文件时附加读取提醒（默认 true）
//   discipline         注入层强制附加「记忆纪律」块（默认 true）
//   injectHookCommand  注入文本的外部过滤命令（stdin 进、stdout 出；默认空 = 不过滤）
//   audit              写入落盘后追加 ~/.dsh/memory/audit.log（JSONL，默认 true）

const HOME = process.env.HOME ?? "";

/** 全局层记忆文件。 */
const GLOBAL_MEMORY = `${HOME}/.dsh/memory.md`;

/** 全局记忆的分片目录：存在且含 .md 时启用「索引 + 主题文件」注入。 */
const TOPICS_DIR = `${HOME}/.dsh/memory/topics`;

/** 索引里单条标题的最大字符数。 */
const TITLE_MAX = 80;

/** 单片文件的「建议」字符上限（对齐业界单规则文件配额，只提示不截断）。 */
const SHARD_WARN_CHARS = 12000;

/** 单条记忆的「建议」字符上限（超过只标记，不处理）。 */
const ENTRY_WARN_CHARS = 400;

/** 注入索引的整体预算：超出后只保留片级统计，不再逐条列标题。 */
const INDEX_BUDGET_CHARS = 9000;

/** 项目层记忆目录。 */
const PROJECT_DIR = `${HOME}/.dsh/memory/projects`;

/** 全局规则文件所在目录（DSH home）。 */
const RULES_DIR = `${HOME}/.dsh`;

/** 可查看/编辑的全局规则文件（DSH 原生的全局指令文件就是 ~/.dsh/AGENTS.md）。 */
const RULE_FILES = ["AGENTS.md"];

/** 单层注入上限。 */
/** 每层注入的默认字符预算（设置里可改；0 = 不限制，全量注入）。 */
const DEFAULT_MAX_CHARS = 24000;

/** 溢出索引自身的字符预算 —— 索引也吃 token，必须封顶。 */
const MAX_INDEX_CHARS = 4000;

/** 单次写入上限（防手滑贴进一整本书）。 */
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

/** 设置面板里的两个虚拟 target（与 slug 形态不冲突：slug 必以 `--` 开头）。 */
const GLOBAL_TARGET = "global";
const RULES_TARGET = "rules";

/** 项目 slug：与 DSH 会话目录同一规则。 */
const SLUG_RE = /^--[A-Za-z0-9\u4e00-\u9fff._ -]*--$/;

/** 层内文件名：只允许平铺的 .md，天然排除任何路径分隔符。 */
const FILE_RE = /^[A-Za-z0-9\u4e00-\u9fff._ -]+\.md$/;

export const name = "dsh-memory";
export const inject = ["systemPrompt"];

// 钩子子系统的纯函数与处理器：导出仅供 tests/probe.mjs 直测（host 半边自包含，无副作用）。
export {
  memoryTargetOf,
  extractEntries,
  validEntryDate,
  lineDiff,
  scanSecrets,
  scanStale,
  mergeDecisions,
  runWriteRules,
  parseHookOutcome,
  runCommandHook,
  buildWritePayload,
  bashTouchesMemory,
  writeGuardHook,
  postExecuteHook,
  applyInjectFilter,
  contextMessage,
  auditLog,
  DISCIPLINE_BLOCK,
  normalizeSettings,
  readSettings,
  updateSettings,
  knownProjects,
  handleRoute,
};

/**
 * 设置文件：与记忆正文同根，跟着 ~/.dsh/memory 一起备份、同步、迁移。
 *
 * 不挂 dsh 的 settings 服务：0.1.7 把插件设置面换成了 cordis Config 表单
 * （`@deepseek-ai/dsh-settings` 只导出 SettingsForms，旧 register/scope 已不存在），
 * 而插件自持一个小文件与宿主版本无关 —— 注入与钩子每次现读，改完立刻生效。
 */
const SETTINGS_PATH = `${HOME}/.dsh/memory/settings.json`;

/**
 * 归一化：任何形状的输入都折叠成合法设置（面板与钩子读到的都是这个形状）。
 * @param {unknown} value - 磁盘上或面板提交的候选值。
 * @returns {object} 规范化后的设置值。
 */
function normalizeSettings(value) {
  const v = value !== null && typeof value === "object" ? value : {};
  const enabled = v.projectEnabled !== null && typeof v.projectEnabled === "object" ? v.projectEnabled : {};
  const budget = Number.isFinite(v.maxChars) ? Math.max(0, Math.floor(v.maxChars)) : DEFAULT_MAX_CHARS;
  return {
    globalEnabled: v.globalEnabled !== false,
    projectEnabled: { ...enabled },
    maxChars: budget,
    injectMode: v.injectMode === "full" ? "full" : "index",
    // ── 钩子子系统 ──
    writeGuard: v.writeGuard === "off" || v.writeGuard === "full" ? v.writeGuard : "rules",
    writeHookCommand: typeof v.writeHookCommand === "string" ? v.writeHookCommand : "",
    hookTimeoutMs: Number.isFinite(v.hookTimeoutMs) ? Math.max(1000, Math.floor(v.hookTimeoutMs)) : DEFAULT_HOOK_TIMEOUT_MS,
    readReminder: v.readReminder !== false,
    discipline: v.discipline !== false,
    injectHookCommand: typeof v.injectHookCommand === "string" ? v.injectHookCommand : "",
    audit: v.audit !== false,
  };
}

/**
 * 读设置；文件缺失或损坏一律回落默认值。
 * 不做缓存：文件不到 1 KB，而「面板改完立刻生效」比省这一次读更值钱。
 * @returns {object} 归一化设置。
 */
function readSettings() {
  try {
    return normalizeSettings(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")));
  } catch {
    return normalizeSettings({});
  }
}

/**
 * 合并写设置（面板每改一项调一次）。
 * @param {object} patch - 只含被改字段。
 * @returns {object} 写入后的完整设置。
 */
function updateSettings(patch) {
  const next = normalizeSettings({ ...readSettings(), ...(patch ?? {}) });
  try {
    mkdirSync(`${HOME}/.dsh/memory`, { recursive: true });
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* 写失败不回滚：下一次 readSettings 仍是旧值，面板会跟着回落 */
  }
  return readSettings();
}

/**
 * 已知项目 slug（面板列项目用）。直接扫盘，不再维护第二份状态。
 * @returns {string[]} 已排序的 slug。
 */
function knownProjects() {
  return listProjectSlugs();
}

/**
 * 把工作目录编码成记忆 slug，规则与 DSH 的 `~/.dsh/sessions/<slug>` 一致。
 * @param {string} cwd - 会话工作目录。
 * @returns {string} slug。
 */
function slugOf(cwd) {
  const trimmed = String(cwd).replace(/\/+$/, "");
  return `--${trimmed.replace(/^\/+/, "").replace(/\//g, "-")}--`;
}

/**
 * 读文件；缺失或失败返回空串（空串会被 renderPrompt 过滤 → 零残留）。
 * @param {string} path - 绝对路径。
 * @returns {string} 正文或空串。
 */
function readOrEmpty(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * 本层允许注入的字符预算。
 * @returns {number} 0 表示不限制（全量注入）。
 */
function maxChars() {
  return readSettings().maxChars;
}

/**
 * 注入保护：超预算时**不静默丢弃**。
 *
 * 记忆文件按「条目行」组织（`- [YYYY-MM-DD] …`）。超过预算时保留**头部**正文
 * （文件顺序即语义顺序：用户偏好 / 环境事实在最前 = 最常被需要的），再把被截掉的
 * 部分压成一份**带全文行号的条目索引**：模型由此知道自己错过了什么、需要时用
 * `read` 工具按行号精确取回，而不是让整层记忆凭空消失。
 *
 * 旧行为（`text.slice(0, MAX)` + 末尾一句「已截断」）的问题：被截掉的内容没有任何
 * 线索，模型既不知道有 3/4 的记忆没看见，也无从取回。
 *
 * `maxChars` 设为 0 时完全不截断。
 *
 * @param {string} text - 正文。
 * @param {string} path - 来源路径（写进提示与索引）。
 * @returns {string} 原正文，或「头部正文 + 溢出索引」。
 */
function clamp(text, path) {
  const limit = maxChars();
  if (limit <= 0 || text.length <= limit) return text;

  // 1) 头部保留到**行边界**（不切半行；没有可用换行时才硬切）
  let cut = text.lastIndexOf("\n", limit);
  if (cut < Math.floor(limit / 2)) cut = limit;
  const head = text.slice(0, cut);
  const rest = text.slice(cut);
  const headLines = head.split("\n").length;

  // 2) 被截掉的部分 → 逐行索引（行号用全文行号，直接喂给 read 的 offset）
  const entries = [];
  rest.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("<!--")) return;
    entries.push({ n: headLines + i, text: t });
  });

  // 3) 索引同样占 token：逐条压到一行，整体不超过 MAX_INDEX_CHARS
  const shown = [];
  let used = 0;
  let omitted = 0;
  for (const e of entries) {
    const body = e.text.length > 96 ? `${e.text.slice(0, 96)}…` : e.text;
    const one = `- L${e.n} ${body}`;
    if (used + one.length + 1 > MAX_INDEX_CHARS) {
      omitted += 1;
      continue;
    }
    shown.push(one);
    used += one.length + 1;
  }

  const totalLines = text.split("\n").length;
  const percent = Math.round((head.length / text.length) * 100);
  const note = [
    `<!-- ⚠️ 本层超预算，未全量注入：全文 ${text.length} 字符 / ${totalLines} 行，`,
    `     上面是前 ${head.length} 字符（约 ${percent}%，到第 ${headLines} 行）。`,
    `     下面列出**未注入部分**的条目索引（L 后是全文行号），需要细节时按行号读取：`,
    `       read path="${path}" offset=<L 号> limit=<行数>`,
    `     不必整份读回，也不必据此重写本文件。 -->`,
  ].join("\n");

  const bullets = shown.join("\n");
  const more = omitted > 0 ? `\n- （另有 ${omitted} 条未列出，见完整文件）` : "";
  const indexBlock = shown.length ? `${note}\n\n${bullets}${more}` : `${note}\n（未注入部分没有可索引的条目。）`;

  return `${head}\n\n${indexBlock}`;
}

/**
 * 记忆正文不是 prompt 模板。dsh-system-prompt 会把完整 `{{name}}` 当插值，
 * 且没有字面量转义：未知变量直接抛，整段 `dsh-memory:long-term` 组装失败。
 * 注入前拆开 `{{`，保留可读性，让插值器当普通文本。
 * @param {string} text
 * @returns {string}
 */
function neutralizePromptVars(text) {
  return text.replaceAll("{{", "{ {");
}

// ══ 渐进式注入：索引层 ════════════════════════════════════════════════════════
// 记忆正文分片存在 markdown 文件里，注入系统提示词的只是**实时生成的索引**：
// 每片一行统计（条数 · 体量 · 路径）+ 片内每条一行的标题与行号。正文一律按需 read。
// 索引实时算 ⇒ 永远不会与正文脱节；正文再长，注入层的开销也恒定。

/** 压平空白为单空格。 */
function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/** 标题封顶。 */
function capTitle(s) {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s;
}

/**
 * 从条目正文里提一个「标题」。
 *
 * 本机记忆的书写习惯是 `- [日期] **结论式标题**（细节…）`，所以优先取**开头处**的
 * 粗体；粗体若不在开头（`实际运行的是 **desktop** profile…`）就不能当标题，否则会
 * 得到毫无上下文的「desktop」。
 *
 * 切分只认**中文冒号与破折号**（`标题：说明` 形式），不认括号：括号在记忆里大量用于
 * 「主题（补充说明）后续还有正文」，照它切会把 `modsearch（@liustack/…）装在两个
 * profile…` 砍成光秃秃的「modsearch」。退路是第一个句子边界，再退路才是硬截断。
 *
 * @param {string} raw - 条目原始行。
 * @returns {string} 压平后的标题。
 */
function titleOf(raw) {
  const body = String(raw).replace(/^\s*-\s*(\[[^\]]*\]\s*)?/, "").trim();
  const lead = body.match(/^\*\*(.{4,300}?)\*\*/);
  const source = lead ? lead[1] : body;
  const s = oneLine(source.replace(/\*\*/g, "").replace(/`/g, "").replace(/^\[[^\]]*\]\s*/, ""));
  const titled = s.split(/(?:：|——)/)[0].trim();
  if (titled.length >= 8) return capTitle(titled);
  const sentence = s.split(/[。；;]/)[0].trim();
  return capTitle(sentence.length >= 8 ? sentence : s);
}

/**
 * 把 markdown 正文解析成条目（`- …` 行）及其所属 `## 段落`。
 * 代码围栏内的行不算条目（yaml 里的 `- id:` 就不会被误判）；条目的缩进续行与
 * 围栏内容计入该条目的体量。
 *
 * @param {string} text - 正文。
 * @returns {{section:string,line:number,title:string,len:number}[]} 条目列表（行号 1 起）。
 */
function parseEntries(text) {
  const lines = String(text).split("\n");
  const out = [];
  let section = "";
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
    if (/^##\s+/.test(ln)) {
      section = ln.replace(/^##\s+/, "").trim();
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
      out.push({ section, line: start + 1, title: titleOf(ln), len: buf.join("\n").length });
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 列出一层记忆的文件：优先分片目录里的 `*.md`（按文件名排序），目录缺失或为空时
 * 回落到单文件 —— 因此「还没迁移」与「已分片」两种形态都能工作。
 *
 * @param {string} shardDir - 分片目录。
 * @param {string} singleFile - 单文件路径（回落用）。
 * @returns {{name:string,path:string}[]} 文件列表。
 */
function layerFiles(shardDir, singleFile) {
  const files = [];
  try {
    if (isDir(shardDir)) {
      for (const name of readdirSync(shardDir).sort()) {
        if (!name.endsWith(".md")) continue;
        const path = `${shardDir}/${name}`;
        try {
          if (statSync(path).isFile()) files.push({ name: name.replace(/\.md$/, ""), path });
        } catch {
          /* 单个文件不可读就跳过 */
        }
      }
    }
  } catch {
    /* 目录扫描失败按单文件处理 */
  }
  if (files.length === 0) {
    try {
      if (existsSync(singleFile)) {
        files.push({ name: singleFile.split("/").pop().replace(/\.md$/, ""), path: singleFile });
      }
    } catch {
      /* 忽略 */
    }
  }
  return files;
}

/**
 * 片名：优先用正文里的 H1 标题（可读性好），没有就用文件名。
 * @param {string} text - 该片正文。
 * @param {string} fallback - 文件名（去扩展名）。
 * @returns {string} 片名。
 */
function shardName(text, fallback) {
  const m = String(text).slice(0, 500).match(/^#\s+(.+)$/m);
  return m ? oneLine(m[1]) : fallback;
}

/**
 * 渲染一层的**注入索引**：片级统计 + 片内条目「标题 · 行号」。
 *
 * @param {string} header - 层名（写进注释头）。
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @param {boolean} detail - 是否逐条列标题（预算不足时只列片级统计）。
 * @returns {string} 索引正文（无内容时为空串）。
 */
function renderIndex(header, files, detail) {
  const shards = [];
  for (const f of files) {
    const text = readOrEmpty(f.path).trim();
    if (!text) continue;
    shards.push({ name: shardName(text, f.name), path: f.path, text, entries: parseEntries(text) });
  }
  if (shards.length === 0) return "";

  const total = shards.reduce((n, s) => n + s.entries.length, 0);
  const chars = shards.reduce((n, s) => n + s.text.length, 0);
  const out = [
    `<!-- ${header} · 索引模式：${shards.length} 片 / ${total} 条 / ${chars} 字符。`,
    "     正文不在提示词里 —— 需要细节时按下面的路径读取（offset 就是条目行号）：",
    '       read path="<路径>" offset=<L 号> limit=<行数> -->',
  ];
  for (const s of shards) {
    const over = s.text.length > SHARD_WARN_CHARS ? ` ⚠️超建议${SHARD_WARN_CHARS}` : "";
    out.push("", `## ${s.name} (${s.entries.length} 条 · ${(s.text.length / 1000).toFixed(1)}k${over}) → ${s.path}`);
    if (detail) {
      for (const e of s.entries) {
        out.push(`- [L${e.line}] ${e.title}${e.len > ENTRY_WARN_CHARS ? " ·长" : ""}`);
      }
    } else {
      out.push(`- （${s.entries.length} 条；索引预算已满，未逐条列出，直接按路径读取）`);
    }
  }
  return out.join("\n");
}

/**
 * 带预算的索引渲染：超预算就退化为「只列片级统计」。
 * @param {string} header - 层名。
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @returns {string} 索引正文。
 */
function renderIndexBudgeted(header, files) {
  const full = renderIndex(header, files, true);
  if (full.length <= INDEX_BUDGET_CHARS) return full;
  return renderIndex(header, files, false);
}

/** 注入模式：`index`（默认，渐进式）或 `full`（整篇注入，超限走 clamp）。 */
function injectMode() {
  return readSettings().injectMode;
}

/**
 * 项目层（**目录形式**）的注入正文。
 *
 * 与全局层 / 单文件形式刻意不同：项目目录里索引与正文已经分好家 —— `MEMORY.md` 是人写的
 * 索引（`- [标题](文件.md) — 摘要`，本身就是「标题 → 路径」），其余 `.md` 是正文（带 YAML
 * frontmatter 的段落，不是条目）。所以这里直接注入索引正文，另外只列出**没被索引登记的**
 * 正文文件。对正文再套一遍条目索引只会退化成一张纯路径清单 —— 实测 traffic 项目：
 * 74 片 / 474 条 / 176k 字符被压成 14340 字符的文件列表，而 MEMORY.md 的摘要在退化成
 * 「索引预算已满」后**一个字都没注入**。
 *
 * @param {string} cwd - 工作目录（写进注释头）。
 * @param {string} dir - 该项目记忆目录。
 * @returns {string} 注入正文（无内容时为空串）。
 */
function renderProjectDir(cwd, dir) {
  const indexPath = `${dir}/MEMORY.md`;
  const indexText = readOrEmpty(indexPath).trim();
  const others = [];
  try {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md") || name === "MEMORY.md") continue;
      const path = `${dir}/${name}`;
      try {
        if (statSync(path).isFile()) others.push({ name, path, size: readOrEmpty(path).length });
      } catch {
        /* 单个文件不可读就跳过 */
      }
    }
  } catch {
    /* 目录不可读时按「只有索引」处理 */
  }
  if (!indexText && others.length === 0) return "";

  const refs = new Set([...indexText.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1].split("/").pop()));
  const orphans = others.filter((f) => !refs.has(f.name));
  const entries = (indexText.match(/^\s*-\s*\[/gm) ?? []).length;
  const parts = [
    `<!-- 项目记忆 · ${cwd} · 目录形式：索引 ${entries} 条 / 正文 ${others.length} 篇，正文按需 read -->`,
  ];
  if (indexText) {
    parts.push("", `## 索引 (MEMORY.md) → ${indexPath}`, "", clamp(indexText, indexPath));
  }
  if (orphans.length > 0) {
    parts.push("", "## 未被索引登记的正文（要么读它，要么把它补进 MEMORY.md）");
    for (const f of orphans) parts.push(`- ${f.name} (${(f.size / 1000).toFixed(1)}k)`);
  }
  parts.push("", `<!-- 写入本层：正文写进对应主题文件，并在 MEMORY.md 补一行 \`- [标题](文件.md) — 摘要\` -->`);
  return parts.join("\n");
}

/**
 * 扫描项目记忆目录，得到全部 slug（目录形式与单文件形式都算）。
 * @returns {string[]} 排序后的 slug 列表。
 */
function listProjectSlugs() {
  try {
    return readdirSync(PROJECT_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.name.endsWith(".md"))
      .map((e) => e.name.replace(/\.md$/, ""))
      .filter((n) => n.startsWith("--"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 组装两层记忆正文，并遵守开关。
 * @param {object} context - 组装上下文（含 agent）。
 * @returns {string} 拼接后的正文，或空串。
 */
function compose(context) {
  const values = readSettings();
  const index = injectMode() === "index";
  const blocks = [];

  // ── 全局层 ──────────────────────────────────────────────────────────────
  if (values.globalEnabled !== false) {
    if (index) {
      const body = renderIndexBudgeted(`全局记忆 · ${HOME}/.dsh/memory`, layerFiles(TOPICS_DIR, GLOBAL_MEMORY));
      if (body) {
        // 索引里的标题同样可能含 `{{` —— 必须与 full 模式一样拆开，否则整段组装会炸
        blocks.push(
          neutralizePromptVars(
            `${body}\n\n<!-- 写入本层：往上面某一片追加一行（- [YYYY-MM-DD] 事实），或在同一目录新建主题文件 -->`,
          ),
        );
      }
    } else {
      const text = readOrEmpty(GLOBAL_MEMORY).trim();
      if (text) blocks.push(`<!-- 全局记忆 · ${GLOBAL_MEMORY} -->\n\n${neutralizePromptVars(clamp(text, GLOBAL_MEMORY))}`);
    }
  }

  // ── 项目层 ──────────────────────────────────────────────────────────────
  const cwd = context?.agent?.session?.header?.cwd;
  if (typeof cwd === "string" && cwd.length > 0) {
    const slug = slugOf(cwd);
    if (values.projectEnabled?.[slug] !== false) {
      const dir = `${PROJECT_DIR}/${slug}`;
      const indexPath = `${dir}/MEMORY.md`;
      const filePath = `${PROJECT_DIR}/${slug}.md`;
      if (index) {
        // 目录形式：MEMORY.md 已是人写索引，走「索引正文 + 孤儿正文清单」
        // 单文件形式：本身就是条目集合，才值得索引化
        const dirShape = isDir(dir);
        const body = dirShape ? renderProjectDir(cwd, dir) : renderIndexBudgeted(`项目记忆 · ${cwd}`, layerFiles("", filePath));
        if (body) {
          blocks.push(
            neutralizePromptVars(
              dirShape ? body : `${body}\n\n<!-- 写入本层：在本文件末尾按分组追加一行 \`- [YYYY-MM-DD] 事实\` -->`,
            ),
          );
        }
      } else if (existsSync(indexPath)) {
        const body = readOrEmpty(indexPath).trim();
        if (body) {
          blocks.push(
            `<!-- 项目记忆 · ${cwd} -->\n\n${neutralizePromptVars(clamp(body, indexPath))}` +
              `\n\n<!-- 以上是索引。主题文件按需直接读：${dir}/<文件名>.md -->`,
          );
        }
      } else {
        const body = readOrEmpty(filePath).trim();
        if (body) {
          blocks.push(
            `<!-- 项目记忆 · ${cwd} -->\n\n${neutralizePromptVars(clamp(body, filePath))}\n\n<!-- 写入本层：${filePath} -->`,
          );
        }
      }
    }
  }

  let body = blocks.join("\n\n---\n\n");
  const values2 = readSettings();
  if (body && values2.discipline !== false) body = `${body}\n\n${DISCIPLINE_BLOCK}`;
  return applyInjectFilter(body);
}

// ══ 层解析：读与写的唯一入口 ══════════════════════════════════════════════════
// 所有 target/file 都先经过 resolveLayer()，它只认「全局记忆 / 规则文件 / 记忆目录里的
// 平铺 .md」三类，其余一律拒绝 —— 因此 HTTP 层永远拼不出白名单之外的路径。

/**
 * 目录判断（失败即 false，不抛）。
 * @param {string} path - 绝对路径。
 * @returns {boolean} 是否存在的目录。
 */
function isDir(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 把 target + file 解析成「一层」及其可编辑文件清单。
 * @param {string|null|undefined} target - `global` / `rules` / 项目 slug。
 * @param {string|null|undefined} file - 层内文件名（缺省 = 该层第一个文件）。
 * @returns {{ok:true,target:string,files:{name:string,path:string,injected:boolean}[]}|{ok:false,error:string}}
 */
function resolveLayer(target, file) {
  const wanted = file === null || file === undefined || file === "" ? undefined : String(file);

  if (target === GLOBAL_TARGET) {
    // 分片目录优先：每片都是可编辑文件（面板里一片一个页签）；
    // 没有分片时回落单文件 memory.md —— 与注入层同一套「两种形态都工作」的规则。
    const shards = layerFiles(TOPICS_DIR, "");
    if (shards.length > 0) {
      if (wanted !== undefined && !shards.some((s) => `${s.name}.md` === wanted)) {
        return { ok: false, error: "unknown file" };
      }
      return {
        ok: true,
        target: GLOBAL_TARGET,
        files: shards.map((s) => ({ name: `${s.name}.md`, path: s.path, injected: true })),
      };
    }
    if (wanted !== undefined && wanted !== "memory.md") return { ok: false, error: "unknown file" };
    return {
      ok: true,
      target: GLOBAL_TARGET,
      files: [{ name: "memory.md", path: GLOBAL_MEMORY, injected: true }],
    };
  }

  if (target === RULES_TARGET) {
    if (wanted !== undefined && !RULE_FILES.includes(wanted)) return { ok: false, error: "unknown file" };
    return {
      ok: true,
      target: RULES_TARGET,
      files: RULE_FILES.map((n) => ({ name: n, path: `${RULES_DIR}/${n}`, injected: true })),
    };
  }

  if (typeof target !== "string" || !SLUG_RE.test(target) || target.includes("..")) {
    return { ok: false, error: "bad target" };
  }

  const dir = `${PROJECT_DIR}/${target}`;
  if (isDir(dir)) {
    let listed = [];
    try {
      listed = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && FILE_RE.test(e.name) && !e.name.includes(".."))
        .map((e) => e.name)
        .sort();
    } catch {
      listed = [];
    }
    // MEMORY.md 是注入入口：缺失时也允许创建（首次为该项目建索引）。
    const names = ["MEMORY.md", ...listed.filter((n) => n !== "MEMORY.md")];
    if (wanted !== undefined && !names.includes(wanted)) return { ok: false, error: "unknown file" };
    return {
      ok: true,
      target,
      files: names.map((n) => ({ name: n, path: `${dir}/${n}`, injected: n === "MEMORY.md" })),
    };
  }

  // 单文件形式（向后兼容）：<slug>.md
  const name = `${target}.md`;
  if (wanted !== undefined && wanted !== name && wanted !== "MEMORY.md") {
    return { ok: false, error: "unknown file" };
  }
  const single = wanted === "MEMORY.md" ? `${dir}/MEMORY.md` : `${PROJECT_DIR}/${name}`;
  return {
    ok: true,
    target,
    files: [{ name: wanted === "MEMORY.md" ? "MEMORY.md" : name, path: single, injected: true }],
  };
}

/**
 * 读一层的全部文件（缺失的文件返回空正文，便于在面板里直接新建）。
 * @param {string} target - 见 resolveLayer。
 * @param {string} [file] - 限定单个文件（可选）。
 * @returns {object} `{ok:true,target,files:[{name,path,injected,exists,text}]}` 或 `{ok:false,error}`。
 */
function readLayer(target, file) {
  const layer = resolveLayer(target, file);
  if (!layer.ok) return layer;
  const files = layer.files
    .filter((f) => file === undefined || file === null || file === "" || f.name === file)
    .map((f) => ({
      name: f.name,
      path: f.path,
      injected: f.injected,
      exists: existsSync(f.path),
      text: readOrEmpty(f.path),
    }));
  return { ok: true, target: layer.target, files };
}

/**
 * 原子写：先写同目录临时文件再 rename；已有内容变化时留一份 `<名>.bak` 作为回滚点。
 * 权限沿用原文件（新文件用 0600 —— 记忆里可能有不适合广播的内容）。
 * @param {string} path - 绝对路径（已过白名单）。
 * @param {string} text - 新正文。
 * @returns {{changed:boolean,bytes:number}} 结果。
 */
function writeMemoryFile(path, text) {
  const exists = existsSync(path);
  const previous = exists ? readOrEmpty(path) : "";
  if (exists && previous === text) return { changed: false, bytes: Buffer.byteLength(text) };

  const mode = exists ? statSync(path).mode & 0o777 : 0o600;
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  if (exists) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {
      /* 备份失败不阻断保存 */
    }
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    // 只清掉临时文件，绝不动原文件 —— 写入失败必须留下原样。
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓：留下的 .tmp-* 不会被任何扫描命中 */
    }
    throw error;
  }
  return { changed: true, bytes: Buffer.byteLength(text) };
}

// ══ 钩子子系统 ═══════════════════════════════════════════════════════════════
// 「是否该写记忆 / 该不该读记忆」不再只靠提示词劝，而是挂进 DSH 原生工具管线
// （@deepseek-ai/dsh-tools 的 tools/pre-execute / tools/post-execute waterfall，
//   与官方 dsh-hooks-claude-code 桥用的是同一批事件）：
//
//   写入钩子  tools/pre-execute → write/edit/bash 命中记忆管辖路径时跑判定管线：
//             内置规则引擎（确定性、零成本）+ 可选外部命令（writeGuard:"full"，
//             stdin 进 payload JSON，exit 2 = deny、stdout JSON 出决策 —— 可接任意
//             LLM 脚本做「这条值不值得记」的语义判断）。deny 的 reason 会成为该次
//             工具调用的 Error 结果，模型当场看到为什么被拒、该怎么改。
//   审计钩子  tools/post-execute → 写入落盘后追加 audit.log（JSONL），并校验落盘
//             内容；条目格式有问题时附加提醒上下文让模型自修。
//   读取钩子  ① 注入层强制附加「记忆纪律」块（compose）；② read 命中记忆文件时
//             附加条目数/行号提醒（防凭索引编造）；③ 可选外部命令对注入文本做
//             过滤/脱敏（injectHookCommand）。
//
// 外部命令的输出语义与官方 dsh-hook-protocol 对齐（exit 2 阻断、stdout JSON 决策、
// 兼容 hookSpecificOutput.permissionDecision），但不 import 任何包 —— 本插件必须
// 保持零依赖（link: 安装解析不到 profile 的 node_modules）。

/** 受钩子管辖的记忆路径（绝对路径，前缀匹配）。 */
const GUARDED_PATHS = [`${HOME}/.dsh/memory`, `${HOME}/.dsh/memory.md`, `${HOME}/.dsh/AGENTS.md`];

/** 条目行：`- [YYYY-MM-DD] 事实`。 */
const ENTRY_LINE_RE = /^\s*-\s*\[(\d{4}-\d{2}-\d{2})\]/;

/** 项目层 MEMORY.md 的人写索引行：`- [标题](文件.md) — 摘要`。 */
const INDEX_LINK_RE = /^\s*-\s*\[[^\]]+\]\([^)]+\.md\)/;

/** 敏感信息模式（deny 依据）。reason 只报模式名与行号，不回显命中值。 */
const SECRET_PATTERNS = [
  ["api key (sk-…)", /sk-[A-Za-z0-9_-]{16,}/],
  ["anthropic key (sk-ant-…)", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["github token (gh?_…)", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["slack token (xox…)", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ["credential assignment", /\b(api[_-]?key|secret|passwd|password|pwd|token)\b\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i],
];

/** 过时陈述模式（allow + 审计 note：纪律要求记「现状」，变迁史会立刻变陈旧）。 */
const STALE_RE = /(已卸载|已弃用|已删除|不再使用|不再维护|was uninstalled|is deprecated|no longer (used|maintained))/i;

/** bash 里「会改文件」的模式：重定向、tee、sed -i。 */
const BASH_MUTATE_RE = /(>>|>[^&|]|tee\b|sed\s+(?:[^|]*\s)?-i\b)/;

/** 记忆路径字面量（bash command 里可能出现的形态）。 */
const MEMORY_PATH_TOKENS = [`${HOME}/.dsh/memory`, `${HOME}/.dsh/memory.md`, "${HOME}/.dsh/memory", "~/.dsh/memory", "~/.dsh/AGENTS.md"];

/** audit.log 的轮转阈值。 */
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

/** 外部钩子默认超时。 */
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * 判断路径是否落在钩子管辖范围内，并给出层归属。
 * @param {string} path - 绝对路径。
 * @returns {{kind:string, layer:string}|null} 层归属；null = 不归记忆钩子管。
 */
function memoryTargetOf(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  if (path === `${HOME}/.dsh/memory.md`) return { kind: "global-single", layer: "global" };
  if (path === `${HOME}/.dsh/AGENTS.md`) return { kind: "rules", layer: "rules" };
  const root = `${HOME}/.dsh/memory`;
  if (path !== root && !path.startsWith(`${root}/`)) return null;
  const rel = path.slice(root.length + 1);
  if (rel.startsWith("topics/")) return { kind: rel.endsWith(".md") ? "topic" : "plugin-internal", layer: "global" };
  if (rel.startsWith("projects/")) {
    const rest = rel.slice("projects/".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return { kind: rest.endsWith(".md") ? "project-single" : "plugin-internal", layer: `project:${rest.replace(/\.md$/, "")}` };
    const slug = rest.slice(0, slash);
    const file = rest.slice(slash + 1);
    if (file === "MEMORY.md") return { kind: "project-index", layer: `project:${slug}` };
    if (file.endsWith(".md")) return { kind: "project-body", layer: `project:${slug}` };
    return { kind: "plugin-internal", layer: `project:${slug}` };
  }
  if (rel === "audit.log" || rel.endsWith(".bak")) return { kind: "plugin-internal", layer: "global" };
  return { kind: "other", layer: "global" };
}

/**
 * 提取正文中的条目行（`- [YYYY-MM-DD] …`；项目索引层另认 `- [标题](x.md)`）。
 * @param {string} text - 正文。
 * @param {boolean} indexShape - 是否按人写索引的宽松格式认条目。
 * @returns {{line:number,text:string,date:string|null}[]} 条目（行号 1 起）。
 */
function extractEntries(text, indexShape = false) {
  return String(text)
    .split("\n")
    .map((t, i) => {
      const m = ENTRY_LINE_RE.exec(t) ?? (indexShape ? INDEX_LINK_RE.exec(t) : null);
      return m ? { line: i + 1, text: t.trim(), date: m[1] ?? null } : null;
    })
    .filter(Boolean);
}

/**
 * 校验条目日期：合法且不晚于今天（防 2026-13-45 这类 Date roll-over，也防未来日期）。
 * @param {string} s - YYYY-MM-DD。
 * @returns {boolean} 是否可用。
 */
function validEntryDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const ok =
    d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
  if (!ok) return false;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() <= today;
}

/**
 * 行级差集：newText 有而 oldText 没有的行（按 new 顺序）。
 * @param {string} oldText - 旧正文。
 * @param {string} newText - 新正文。
 * @returns {{added:string[],removed:string[]}} 差集。
 */
function lineDiff(oldText, newText) {
  const oldSet = new Set(String(oldText).split("\n"));
  const newSet = new Set(String(newText).split("\n"));
  const added = String(newText).split("\n").filter((l) => !oldSet.has(l));
  const removed = String(oldText).split("\n").filter((l) => !newSet.has(l));
  return { added, removed };
}

/**
 * 扫描敏感信息。
 * @param {string} text - 正文。
 * @returns {{line:number,pattern:string}[]} 命中（只报模式名，不回显值）。
 */
function scanSecrets(text) {
  const hits = [];
  String(text).split("\n").forEach((line, i) => {
    for (const [pattern, re] of SECRET_PATTERNS) {
      if (re.test(line)) hits.push({ line: i + 1, pattern });
    }
  });
  return hits;
}

/**
 * 扫描过时陈述。
 * @param {string} text - 正文。
 * @returns {{line:number}[]} 命中。
 */
function scanStale(text) {
  return String(text)
    .split("\n")
    .map((line, i) => (STALE_RE.test(line) ? { line: i + 1 } : null))
    .filter(Boolean);
}

/**
 * 决策单调合并：deny > ask > allow（与官方 mergeHookOutputs 同序）。
 * @param {object} a - {decision, reason?, notes?}。
 * @param {object} b - 同上。
 * @returns {object} 合并结果。
 */
function mergeDecisions(a, b) {
  const rank = { deny: 3, ask: 2, allow: 1 };
  const pick = (rankOf) => (rank[a?.decision] >= rankOf ? a : b);
  const winner = pick(Math.max(rank[a?.decision] ?? 0, rank[b?.decision] ?? 0));
  const notes = [...(a?.notes ?? []), ...(b?.notes ?? [])];
  return {
    decision: winner?.decision ?? "allow",
    ...(winner?.reason ? { reason: winner.reason } : {}),
    notes: notes.length > 0 ? notes : winner?.notes ?? [],
  };
}

/**
 * 内置规则引擎：对一次记忆写入给出决策。
 * @param {object} p - payload（tool/path/target/layer/oldText/newText/added/removed/command）。
 * @returns {{decision:string, reason?:string, notes:string[]}} 决策。
 */
function runWriteRules(p) {
  const notes = [];
  const deny = (reason) => ({ decision: "deny", reason, notes });

  // 0) 插件内部资产（.bak / audit.log / 非 md）一律拒绝 —— 模型不该碰备份与审计。
  if (p.target?.kind === "plugin-internal") {
    return deny("dsh-memory write-guard：这是 dsh-memory 插件的内部文件（备份/审计），不要用工具修改它。");
  }

  // 1) memory.md 现在只是导航索引，正文条目必须去 topics/ 分片。
  if (p.target?.kind === "global-single" && p.added?.some((l) => ENTRY_LINE_RE.test(l))) {
    return deny(
      "dsh-memory write-guard：memory.md 已改为纯导航索引，不要往里写记忆条目。" +
        "请把条目追加到 ~/.dsh/memory/topics/ 下对应主题分片（每个主题一个 .md，按主题归类）。",
    );
  }

  // 2) 新增条目的格式与日期。
  const indexShape = p.target?.kind === "project-index";
  const addedEntries = extractEntries((p.added ?? []).join("\n"), indexShape);
  const looksLikeEntry = (p.added ?? []).some((l) => /^\s*-\s*\[/.test(l));
  if (looksLikeEntry && addedEntries.length === 0) {
    return deny(
      indexShape
        ? "dsh-memory write-guard：MEMORY.md 索引行格式应为 `- [标题](文件.md) — 摘要`。"
        : "dsh-memory write-guard：记忆条目格式应为 `- [YYYY-MM-DD] 事实`（ISO 日期、未过期的今天以前），请修正后重写。",
    );
  }
  for (const e of addedEntries) {
    if (e.date && !validEntryDate(e.date)) {
      return deny(`dsh-memory write-guard：第 ${e.line} 条新增条目日期 ${e.date} 非法（或在未来）。用今天的日期，格式 - [YYYY-MM-DD] 事实。`);
    }
  }

  // 3) 敏感信息：绝对拒绝。reason 只报行号与模式名，不回显命中值。
  const secrets = scanSecrets((p.added ?? []).join("\n"));
  if (secrets.length > 0) {
    const listed = secrets.slice(0, 4).map((s) => `L${s.line} ${s.pattern}`).join("；");
    return deny(`dsh-memory write-guard：新增内容疑似包含凭据（${listed}）。记忆会随每次请求注入并离开本机，禁止写入任何密钥/token/密码；只允许写「凭据存放在哪里」这类指针。`);
  }

  // 4) 破坏性覆盖：write 整文件导致既有条目丢失。
  const kind = p.target?.kind ?? "";
  const oldEntries = extractEntries(p.oldText ?? "", indexShape);
  const newEntries = extractEntries(p.newText ?? "", indexShape);
  if (p.tool === "write" && oldEntries.length > 0 && newEntries.length < oldEntries.length) {
    return deny(
      `dsh-memory write-guard：这次整文件覆写会把既有 ${oldEntries.length} 条记忆删到 ${newEntries.length} 条。` +
        "请改用追加（保留原内容）或用 edit 做精确修改；确实要清理过期条目时交给用户手动处理。",
    );
  }

  // 5) 过时陈述 → 放行但记 note（纪律是「记现状」，写变迁史会立刻陈旧）。
  for (const s of scanStale((p.added ?? []).join("\n"))) {
    notes.push(`L${s.line} 含「已卸载/不再使用」式陈述：优先改写成现状（现在用什么），变迁史不进记忆。`);
  }

  // 6) 超长条目 → 放行但记 note。
  for (const e of addedEntries) {
    if (e.text.length > ENTRY_WARN_CHARS) notes.push(`L${e.line} 条目超长（${e.text.length} 字符），建议拆分或压缩。`);
  }

  return { decision: "allow", notes };
}

/**
 * 解析外部钩子进程输出（与官方 dsh-hook-protocol 语义对齐）。
 * @param {number|undefined} exitCode - 退出码（spawn 失败为 undefined）。
 * @param {string} stdout - stdout。
 * @param {string} stderr - stderr。
 * @returns {{decision:string, reason?:string, note?:string}} 决策；故障一律放行（note 记审计）。
 */
function parseHookOutcome(exitCode, stdout, stderr) {
  if (exitCode === 2) {
    return { decision: "deny", reason: stderr.trim() || "blocked by dsh-memory write hook" };
  }
  if (exitCode === 0) {
    const t = stdout.trim();
    if (t.startsWith("{")) {
      try {
        const j = JSON.parse(t);
        const d = j?.decision ?? j?.hookSpecificOutput?.permissionDecision;
        const r = j?.reason ?? j?.hookSpecificOutput?.permissionDecisionReason;
        if (d === "deny" || d === "block") return { decision: "deny", ...(r ? { reason: r } : {}) };
        if (d === "ask") return { decision: "ask", ...(r ? { reason: r } : {}) };
        if (d === "allow" || d === "approve") return { decision: "allow" };
      } catch {
        /* 非法 JSON 当作普通 stdout：放行 */
      }
    }
    return { decision: "allow" };
  }
  return { decision: "allow", note: `hook exited ${exitCode ?? "?"}: ${(stderr || stdout).slice(0, 200)}` };
}

/**
 * 跑一次外部命令钩子：stdin 传 payload JSON。
 * @param {string} command - shell 命令（经 /bin/zsh -c 执行）。
 * @param {object} payload - 判定输入。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<{decision:string, reason?:string, note?:string}>} 决策。
 */
function runCommandHook(command, payload, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile("/bin/zsh", ["-c", command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error?.killed ? 124 : (error ? (typeof error.code === "number" ? error.code : 1) : 0);
      resolve(parseHookOutcome(code, String(stdout ?? ""), String(stderr ?? "")));
    });
    child.on("error", () => {}); // 回调已收 error，这里只防 unhandled
    child.stdin?.end(JSON.stringify(payload));
  });
}

/**
 * 往 audit.log 追加一条 JSONL（超限轮转一层）。
 * @param {object} entry - 审计记录。
 */
function auditLog(entry) {
  try {
    const path = `${HOME}/.dsh/memory/audit.log`;
    try {
      if (existsSync(path) && statSync(path).size > AUDIT_MAX_BYTES) {
        rmSync(`${path}.1`, { force: true });
        renameSync(path, `${path}.1`);
      }
    } catch {
      /* 轮转失败照写 */
    }
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* 审计失败绝不影响工具调用本身 */
  }
}

/**
 * 构造一条附加上下文消息（形状与官方 createUserMessage 产出同构）。
 *
 * source 必须是会话格式 v4 的生产者对象 `{ kind }`（官方各内置前端都写作
 * `{ kind: "<producer>" }`）。写成裸字符串（v3 时代的插件名写法）会被 v4 校验
 * 拒绝：日志下次加载时整段报 "format v4 message requires a producer-owned source
 * kind"，会话打不开。
 *
 * @param {string} text - 正文。
 * @returns {object} user 消息。
 */
function contextMessage(text) {
  return { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: "dsh-memory" } };
}

/**
 * 组装 write/edit 的判定 payload。
 * @param {string} tool - 工具名（write|edit）。
 * @param {object} args - 工具参数。
 * @returns {{path:string,target:object,layer:string,payload:object}|null} null = 与记忆无关。
 */
function buildWritePayload(tool, args) {
  const path = args?.file_path;
  const hit = memoryTargetOf(path);
  if (!hit) return null;
  const oldText = existsSync(path) ? readOrEmpty(path) : "";
  let newText = oldText;
  if (tool === "write") newText = String(args?.content ?? "");
  if (tool === "edit") newText = String(oldText).replace(String(args?.old_string ?? ""), String(args?.new_string ?? ""));
  const { added, removed } = lineDiff(oldText, newText);
  return {
    path,
    target: hit,
    layer: hit.layer,
    payload: {
      hook: "dsh-memory/write-guard",
      tool,
      path,
      target: hit.kind,
      layer: hit.layer,
      oldChars: oldText.length,
      newChars: newText.length,
      oldText,
      newText,
      added,
      removed,
    },
  };
}

/**
 * bash command 的保守启发式：命令里同时出现记忆路径与「会改文件」的模式 → 交人工确认。
 * @param {string} command - bash 命令。
 * @returns {boolean} 是否命中。
 */
function bashTouchesMemory(command) {
  const cmd = String(command ?? "");
  if (!BASH_MUTATE_RE.test(cmd)) return false;
  return MEMORY_PATH_TOKENS.some((t) => cmd.includes(t));
}

/** 写入钩子的当前配置。 */
function guardConfig() {
  const v = readSettings();
  const guard = v.writeGuard === "off" || v.writeGuard === "full" ? v.writeGuard : "rules";
  return {
    guard,
    command: typeof v.writeHookCommand === "string" ? v.writeHookCommand : "",
    timeoutMs: Number.isFinite(v.hookTimeoutMs) ? Math.max(1000, Math.floor(v.hookTimeoutMs)) : DEFAULT_HOOK_TIMEOUT_MS,
  };
}

/**
 * tools/pre-execute 处理器：记忆写入判定。
 * @param {object} exec - 工具执行上下文（name/arguments/signal…）。
 * @param {function} next - 下游（放行）。
 * @returns {Promise<object>} 决策或 next() 的结果。
 */
async function writeGuardHook(exec, next) {
  const cfg = guardConfig();
  if (cfg.guard === "off") return next();

  let decided = null;
  let payloadRef = null;

  if (exec.name === "write" || exec.name === "edit") {
    const built = buildWritePayload(exec.name, exec.arguments);
    if (built) {
      payloadRef = built;
      decided = runWriteRules({ ...built.payload, target: built.target });
      if (cfg.guard === "full" && cfg.command) {
        const ext = await runCommandHook(cfg.command, built.payload, cfg.timeoutMs);
        decided = mergeDecisions(decided, ext);
      }
    }
  } else if (exec.name === "bash" && bashTouchesMemory(exec.arguments?.command)) {
    // shell 改记忆不做静态 diff 分析，保守转人工确认。
    decided = {
      decision: "ask",
      reason: "dsh-memory write-guard：这条 shell 命令看起来会改动记忆文件（重定向/tee/sed -i）。请确认；能用 write/edit 工具时优先用工具 —— 会经过完整格式与敏感信息校验。",
    };
  }

  if (!decided) return next();

  const { target, layer, path } = payloadRef ?? {};
  auditLog({
    event: "pre-execute",
    tool: exec.name,
    path,
    target: target?.kind,
    layer,
    decision: decided.decision,
    ...(decided.reason ? { reason: decided.reason.slice(0, 500) } : {}),
    ...(decided.notes?.length ? { notes: decided.notes } : {}),
  });

  if (decided.decision === "deny") return { kind: "deny", reason: decided.reason };
  if (decided.decision === "ask") return { kind: "ask", ...(decided.reason ? { reason: decided.reason } : {}) };
  return next();
}

/**
 * tools/post-execute 处理器：写入审计 + 读取提醒。
 * @param {object} exec - 工具执行上下文。
 * @param {object} result - 工具结果。
 * @param {function} next - 下游。
 * @returns {Promise<object>} 处理后的结果。
 */
async function postExecuteHook(exec, result, next) {
  const downstream = await next();
  try {
    const values = readSettings();

    // ── 写入落盘：审计 + 落盘校验 ──────────────────────────────────────────
    if ((exec.name === "write" || exec.name === "edit") && !result?.isError) {
      const built = buildWritePayload(exec.name, exec.arguments);
      if (built) {
        auditLog({
          event: "post-write",
          tool: exec.name,
          path: built.path,
          target: built.target.kind,
          layer: built.layer,
          added: built.payload.added.length,
          removed: built.payload.removed.length,
        });
        // 落盘内容再校一遍条目格式：有问题不回滚（写入已发生），附加提醒让模型自修。
        const indexShape = built.target.kind === "project-index";
        const bad = built.payload.added.filter(
          (l) => /^\s*-\s*\[/.test(l) && extractEntries(l, indexShape).length === 0,
        );
        const notes = [];
        if (bad.length > 0) {
          notes.push(
            `⚠️ dsh-memory 审计：刚写入的 ${bad.length} 行不符合条目格式（应为 \`- [YYYY-MM-DD] 事实\`${indexShape ? " 或 `- [标题](文件.md) — 摘要`" : ""}），请立即用 edit 修正，不要留着坏格式：\n${bad.map((l) => `  ${l.trim().slice(0, 120)}`).join("\n")}`,
          );
        }
        if (values.audit !== false) notes.push(`📝 已审计：${built.path}（+${built.payload.added.length}/−${built.payload.removed.length} 行）→ ~/.dsh/memory/audit.log`);
        if (notes.length > 0) {
          return { ...downstream, additionalContexts: [contextMessage(notes.join("\n")), ...(downstream?.additionalContexts ?? [])] };
        }
      }
    }

    // ── 读取记忆文件：附加提醒（条目数 + 纪律） ──────────────────────────────
    if (exec.name === "read" && !result?.isError && values.readReminder !== false) {
      const hit = memoryTargetOf(exec.arguments?.file_path);
      if (hit && (hit.kind === "topic" || hit.kind === "project-body" || hit.kind === "project-single" || hit.kind === "project-index" || hit.kind === "global-single")) {
        const text = readOrEmpty(exec.arguments.file_path);
        const entries = extractEntries(text, hit.kind === "project-index");
        const remind =
          `dsh-memory read-hook：你刚读取的是${hit.layer === "global" ? "全局" : "项目"}记忆（${hit.kind}，${entries.length} 条 / ${text.length} 字符）。` +
          "引用其中事实时按行号精确定位；不要凭索引标题臆测未读到的内容；若发现某条已过时，直接修正该行（追加/改写要过写入钩子）而不是口头指出。";
        return { ...downstream, additionalContexts: [contextMessage(remind), ...(downstream?.additionalContexts ?? [])] };
      }
    }
  } catch {
    /* 钩子自身故障绝不影响工具结果 */
  }
  return downstream;
}

/** 注入层强制附加的记忆纪律块。 */
const DISCIPLINE_BLOCK = [
  "<!-- 记忆纪律（dsh-memory 钩子强制执行，不只是建议）：",
  "     · 写入前先判断值不值得记：只写可复用的事实/偏好/坑，不写过程叙述与可从仓库推导的内容",
  "     · 条目格式 `- [YYYY-MM-DD] 事实`；全局层写 ~/.dsh/memory/topics/ 分片，项目层写对应文件并登记 MEMORY.md",
  "     · 写入动作由钩子校验：格式错/含凭据/覆盖历史 → 直接拒绝（deny，原因会回到你面前）；可疑改动 → 转人工确认（ask）",
  "     · 读取：按行号精确 read，禁止凭索引标题臆测内容；发现过时条目就地修正 -->",
].join("\n");

/**
 * 对注入文本应用可选的外部过滤命令（同步；compose 的 text 是同步求值）。
 * @param {string} text - 组装后的注入正文。
 * @returns {string} 过滤结果；失败/空输出回落原文。
 */
function applyInjectFilter(text) {
  const cmd = readSettings().injectHookCommand;
  if (typeof cmd !== "string" || cmd.length === 0) return text;
  try {
    const r = spawnSync("/bin/zsh", ["-c", cmd], {
      input: text,
      timeout: DEFAULT_HOOK_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = r.status === 0 ? String(r.stdout ?? "") : "";
    return out.length > 0 ? out : text;
  } catch {
    return text;
  }
}



/**
 * 发 JSON 响应。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @param {number} code - 状态码。
 * @param {object} payload - 载荷。
 */
function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 发纯文本响应（`format=text`，方便 curl）。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @param {number} code - 状态码。
 * @param {string} text - 正文。
 */
function sendText(res, code, text) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/**
 * 读请求体（带上限，超限即断开）。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @returns {Promise<string>} UTF-8 正文。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_WRITE_BYTES) {
        reject(new Error(`body too large (limit ${MAX_WRITE_BYTES} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 内容路由：`GET /dsh-memory/content?target=global|rules|<slug>[&file=<名>][&format=text]`。
 * 供设置面板「查看并编辑记忆 / 全局规则」。target 走白名单校验，无法越出记忆目录。
 * 已注册路由在 dsh-host-webserver 里先于 fallback 匹配，因此不受 SPA 的 403 影响。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {import("node:http").ServerResponse} res - 响应。
 */
function handleContent(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const target = url.searchParams.get("target") ?? GLOBAL_TARGET;
  const file = url.searchParams.get("file") ?? undefined;
  const layer = readLayer(target, file);
  if (!layer.ok) return sendJson(res, 400, { ok: false, error: layer.error });

  if (url.searchParams.get("format") === "text") {
    return sendText(res, 200, layer.files[0]?.text ?? "");
  }
  return sendJson(res, 200, { ok: true, target: layer.target, files: layer.files });
}

/**
 * 写路由：`POST /dsh-memory/write`，体为 `{target, file, text}`。
 * 要求 `x-dsh-memory: 1` 头 —— 浏览器跨站简单请求带不上自定义头，省掉一整类 CSRF。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @returns {Promise<void>} 完成即响应已发。
 */
async function handleWrite(req, res) {
  if (String(req.headers?.["x-dsh-memory"] ?? "") !== "1") {
    return sendJson(res, 403, { ok: false, error: "missing x-dsh-memory header" });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
  }
  const { target, file, text } = payload ?? {};
  if (typeof text !== "string") return sendJson(res, 400, { ok: false, error: "text must be a string" });

  const layer = resolveLayer(target, file);
  if (!layer.ok) return sendJson(res, 400, { ok: false, error: layer.error });
  const chosen = layer.files.find((f) => (file ? f.name === file : true)) ?? layer.files[0];
  if (chosen === undefined) return sendJson(res, 400, { ok: false, error: "unknown file" });

  try {
    const result = writeMemoryFile(chosen.path, text);
    return sendJson(res, 200, {
      ok: true,
      target: layer.target,
      file: chosen.name,
      path: chosen.path,
      changed: result.changed,
      bytes: result.bytes,
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
}

/**
 * 设置路由：`GET /dsh-memory/settings`（读开关 + 已知项目）、
 * `POST /dsh-memory/settings`（体 `{patch}`，合并写）。
 * 面板唯一的设置通道：写的是 ~/.dsh/memory/settings.json，host 侧每次现读。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @returns {Promise<void>} 完成即响应已发。
 */
async function handleSettings(req, res) {
  const method = String(req.method ?? "GET").toUpperCase();
  if (method === "GET") return sendJson(res, 200, { ok: true, value: readSettings(), projects: knownProjects() });
  if (String(req.headers?.["x-dsh-memory"] ?? "") !== "1") {
    return sendJson(res, 403, { ok: false, error: "missing x-dsh-memory header" });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
  }
  const patch = payload?.patch;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return sendJson(res, 400, { ok: false, error: "patch must be an object" });
  }
  return sendJson(res, 200, { ok: true, value: updateSettings(patch), projects: knownProjects() });
}

/**
 * 路由入口：`/dsh-memory/content`、`/dsh-memory/write` 与 `/dsh-memory/settings`。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @returns {Promise<void>} 完成即响应已发。
 */
async function handleRoute(req, res) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = String(req.method ?? "GET").toUpperCase();

    if (url.pathname === "/dsh-memory/content") return handleContent(req, res);
    if (url.pathname === "/dsh-memory/settings") return await handleSettings(req, res);
    if (url.pathname === "/dsh-memory/write") {
      if (method !== "POST") return sendJson(res, 405, { ok: false, error: "use POST" });
      return await handleWrite(req, res);
    }
    return sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
}

/**
 * 挂载：提示词段 + 工具钩子 + 内容/写入/设置路由。
 * @param {object} ctx - cordis 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "dsh-memory:long-term",
        order: 1, // 紧跟 DEPLOYMENT_PERSONA_PREFIX(order 0)，先于工具规范
        text: compose,
      }),
    "dsh-memory: long-term memory section",
  );

  // 写入钩子 + 审计/读取钩子：挂进 DSH 原生工具管线（与官方 hooks 桥同一批事件）。
  ctx.effect(
    () => ctx.on("tools/pre-execute", writeGuardHook),
    "dsh-memory: write-guard pre-execute hook",
  );
  ctx.effect(
    () => ctx.on("tools/post-execute", postExecuteHook),
    "dsh-memory: audit & read-reminder post-execute hook",
  );

  // 读写路由：设置面板「查看 / 编辑记忆与全局规则」用。webServer 缺席时面板会提示读取失败。
  ctx.inject(["webServer"], (wctx) => {
    ctx.effect(
      () =>
        wctx.webServer.register({
          kind: "prefix",
          // 不带尾部斜杠：dsh-host-webserver 的 match() 自己会补 "/" 再比前缀
          path: "/dsh-memory",
          handler: handleRoute,
        }),
      "dsh-memory: content route",
    );
  });
}
