import {
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
// 开关（可在「设置 → 记忆」里改，也可手改 settings.yaml 的 dsh-memory 节）：
//   globalEnabled   布尔，默认 true   关掉则全局层不注入
//   projectEnabled  字典 slug→布尔    关掉的项目不注入；再次开启即刻重新读取
//   knownProjects   字符串数组        host 扫描目录自动维护，供设置面板列出项目
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

/** settings namespace（设置面板与 host 共享的开关状态）。 */
const NS = "dsh-memory";

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

/**
 * 手写 schema：无需 schemastery 依赖（本插件位于 node_modules 之外，解析不到它）。
 * dsh-settings 只要求 schema 可调用，并在 describe 时能 toJSON()。
 * @param {unknown} value - 合并 schema 默认值、组合 base 与用户层之后的候选值。
 * @returns {object} 规范化后的设置值。
 */
function MemorySettings(value) {
  const v = value !== null && typeof value === "object" ? value : {};
  const enabled = v.projectEnabled !== null && typeof v.projectEnabled === "object" ? v.projectEnabled : {};
  const known = Array.isArray(v.knownProjects) ? v.knownProjects.filter((x) => typeof x === "string") : [];
  const maxChars = Number.isFinite(v.maxChars) ? Math.max(0, Math.floor(v.maxChars)) : DEFAULT_MAX_CHARS;
  return {
    globalEnabled: v.globalEnabled !== false,
    projectEnabled: { ...enabled },
    knownProjects: [...known],
    maxChars,
    injectMode: v.injectMode === "full" ? "full" : "index",
  };
}
MemorySettings.toJSON = () => ({ type: "object", additionalProperties: true });

/** 当前 settings scope（settings 服务缺席时保持 undefined）。 */
let scope;

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
  const n = (scope?.get() ?? {}).maxChars;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_MAX_CHARS;
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
  return (scope?.get() ?? {}).injectMode === "full" ? "full" : "index";
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
 * 把扫描结果同步进设置（只在变化时写，避免无谓的 settings 写入）。
 * @param {object} s - settings scope。
 */
function syncKnownProjects(s) {
  try {
    const slugs = listProjectSlugs();
    const current = s.get()?.knownProjects ?? [];
    if (slugs.length !== current.length || slugs.some((x, i) => x !== current[i])) {
      Promise.resolve(s.update({ knownProjects: slugs })).catch(() => {});
    }
  } catch {
    /* 同步失败不影响注入 */
  }
}

/**
 * 组装两层记忆正文，并遵守开关。
 * @param {object} context - 组装上下文（含 agent）。
 * @returns {string} 拼接后的正文，或空串。
 */
function compose(context) {
  const values = scope?.get() ?? {};
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
        // 目录形式（MEMORY.md + 主题文件）与单文件形式都走同一套索引
        const files = isDir(dir) ? layerFiles(dir, "") : layerFiles("", filePath);
        const body = renderIndexBudgeted(`项目记忆 · ${cwd}`, files);
        if (body) {
          blocks.push(
            neutralizePromptVars(
              `${body}\n\n<!-- 写入本层：往上面某一片追加一行，或在同一目录新建主题文件（引用保持一层深，别做索引套索引） -->`,
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

  return blocks.join("\n\n---\n\n");
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

// ══ HTTP 路由（设置面板的读写后端）═══════════════════════════════════════════

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
 * 路由入口：`/dsh-memory/content` 与 `/dsh-memory/write`。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @returns {Promise<void>} 完成即响应已发。
 */
async function handleRoute(req, res) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = String(req.method ?? "GET").toUpperCase();

    if (url.pathname === "/dsh-memory/content") return handleContent(req, res);
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
 * 挂载：提示词段 + 设置 namespace + 内容/写入路由。
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

  // 可选依赖：settings 服务缺席时开关退化为「全部开启」，注入照常工作。
  ctx.inject(["settings"], (sctx) => {
    ctx.effect(() => {
      const registered = sctx.settings.register(NS, MemorySettings);
      scope = registered;
      syncKnownProjects(registered);
      // 目录变化（新增项目记忆）时刷新 knownProjects，供设置面板列出。
      const stop = registered.watch(() => syncKnownProjects(registered));
      return () => {
        stop?.();
        scope = undefined;
      };
    }, `dsh-memory: settings namespace ${NS}`);
  });

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
