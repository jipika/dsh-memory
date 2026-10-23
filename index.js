import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";

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
// 卡片记忆层（v0.9.0，防「角色扮演污染长期记忆」）：
//   CARDS    ~/.dsh/memory/cards/<cardSlug>.md   一张卡一个文件，随卡保留
//   当前会话在 dsh-card-summon 的 summons.json 里有记录（召唤中）→ compose 不注入
//   全局/项目层与纪律块，改注入「屏蔽说明 + 本卡卡片记忆正文」；writeGuard 对
//   全局/项目/规则层一律 deny（bash 命中记忆也不放行），只有卡片记忆路径照常走规则。
//   列表/清除路由供 dsh-card-summon 召唤面板与设置面板用（删除前全文进审计 = 回滚点）。
//   开关 cardsEnabled（默认 true）：关掉则召唤会话整段不注入、卡片路径同样被拦。
//
// 零额外 LLM 成本：不调用任何模型，只读 markdown 文件；写入由当前会话的 agent 顺手完成，
// 或者由「设置 → 记忆」面板直接改（host 半的写路由）。
//
// HTTP（host 半，供设置面板用；路径全部走白名单解析，越不出记忆目录与规则文件）：
//   GET  /dsh-memory/content?target=global|rules|<slug>[&file=<名>][&format=text]
//   POST /dsh-memory/write   { target, file, text }   需要头 x-dsh-memory: 1
//   GET  /dsh-memory/settings                          开关当前值 + 已知项目
//   POST /dsh-memory/settings  { patch }               合并写开关，需要头 x-dsh-memory: 1
//   GET  /dsh-memory/cards                             卡片记忆分片列表（只读）
//   POST /dsh-memory/cards/delete  { slug }            按卡清除，需要头 x-dsh-memory: 1
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

// ── 跨平台 home / 路径归一化（issue #1）──────────────────────────────────────
// Windows 上 `process.env.HOME` 不存在（只有 USERPROFILE）。旧写法 `HOME ?? ""` 把 home
// 解析成空串，所有派生路径就从盘根开始（`/.dsh/memory`、`C:\.dsh\...`）—— 注入索引恒空、
// 面板读写错位，写入守卫的字符串前缀也永远匹配不上真实路径。这里与 DSH 官方
// `@deepseek-ai/dsh-home-paths` 的 `defaultDshHome()` 同源（`os.homedir()`：Windows 读
// USERPROFILE、POSIX 读 HOME），并把分隔符统一成正斜杠再参与比较。

/** Windows 盘符根（`C:/`）：去尾斜杠时不能把根去掉。 */
const DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;

/**
 * 取第一个非空文本（空串 / 纯空白都算未设置）。
 * @param {...unknown} values - 候选值。
 * @returns {string} 第一个非空值；都没有返回空串。
 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

/**
 * 路径文本归一化：剥外层引号、反斜杠转 `/`、折叠重复分隔符（保留 UNC 的 `//` 前缀）、
 * 去尾斜杠。只用于拼路径与比较，不用于原样显示。
 * @param {unknown} raw - 任意路径文本。
 * @returns {string} 归一化后的路径；空输入返回空串。
 */
function normalizePathText(raw) {
  let s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) return "";
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  const unc = s.startsWith("\\\\") || s.startsWith("//");
  s = s.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (unc && !s.startsWith("//")) s = `/${s}`;
  if (s.length > 1 && !DRIVE_ROOT_RE.test(s)) s = s.replace(/\/+$/, "");
  return s;
}

/**
 * 把工具参数 / shell 里的路径统一成可比较形态：归一化 + 展开 `~`、`$HOME`、`%USERPROFILE%`。
 * @param {unknown} raw - 路径文本。
 * @returns {string} 归一化路径；空输入返回空串。
 */
function normalizeToolPath(raw) {
  let s = normalizePathText(raw);
  if (s.length === 0) return "";
  s = s
    .replace(/^\$\{HOME\}(?=\/)/, () => HOME)
    .replace(/^\$HOME(?=\/)/, () => HOME)
    .replace(/^%USERPROFILE%(?=\/)/i, () => HOME)
    .replace(/^\$env:USERPROFILE(?=\/)/i, () => HOME);
  if (s === "~") return HOME;
  if (s.startsWith("~/")) return `${HOME}${s.slice(1)}`;
  return s;
}

/**
 * 解析用户 home：与 DSH 官方 `defaultDshHome()` 同源。
 *
 * `os.homedir()` 在 POSIX 上直接回显 `$HOME` —— **HOME 存在但为空串时返回空串**，
 * 不会回落到 passwd。所以按平台先挑环境变量，再 `homedir()`，最后
 * `os.userInfo().homedir`（passwd 记录）兜底；Windows 上 USERPROFILE 优先。
 * @returns {string} 归一化后的 home；完全解析不出时为空串。
 */
function resolveHome() {
  const fromEnv = normalizePathText(
    process.platform === "win32"
      ? firstText(process.env.USERPROFILE, process.env.HOME)
      : firstText(process.env.HOME, process.env.USERPROFILE),
  );
  try {
    const fromOs = normalizePathText(homedir());
    if (fromOs.length > 0) return fromOs;
  } catch {
    /* 无 home 记录：继续兜底 */
  }
  if (fromEnv.length > 0) return fromEnv;
  try {
    return normalizePathText(userInfo().homedir);
  } catch {
    return "";
  }
}

const HOME = resolveHome();

/**
 * 路径比较是否忽略大小写：Windows / macOS 默认文件系统都不区分大小写；
 * Linux 保持区分，避免把仅大小写不同的另一个文件误判成记忆文件。
 */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

/**
 * 比较键：大小写不敏感平台统一小写。
 * @param {string} path - 已归一化路径。
 * @returns {string} 比较键。
 */
function pathKey(path) {
  return CASE_INSENSITIVE_PATHS ? path.toLowerCase() : path;
}

/**
 * 两个已归一化路径是否指同一位置。
 * @param {string} a - 路径。
 * @param {string} b - 路径。
 * @returns {boolean} 是否相同。
 */
function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

/**
 * child 是否等于 root 或位于 root 之下（两者都已归一化）。
 * @param {string} child - 被检查路径。
 * @param {string} root - 根路径。
 * @returns {boolean} 是否在根内。
 */
function isUnderPath(child, root) {
  if (child.length === 0 || root.length === 0) return false;
  const key = pathKey(child);
  const base = pathKey(root);
  return key === base || key.startsWith(`${base}/`);
}

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

/**
 * 检索时**片级**线索的加分上限（整句命中片名 3 / 命中关键词 2 / 否则 0）。
 *
 * 它只作**同分 tie-break**，不参与条目分本身 —— 旧实现把这套加分加在每条 entry 上
 * （v0.9.0 的 `phraseShard` + 每 token 片名+4/关键词+2 写在 entry 循环内），
 * 于是同一片所有命中条目**分数完全相同**，排序退化成「日期 → 行号」。
 * 取值域是 {3,2,0}，天然 ≤3，无需再 `Math.min` 封顶（那是死代码）。
 */
const SHARD_BONUS_PHRASE = 3;
const SHARD_BONUS_KEYWORD = 2;

/** 检索结果里**单个分片**最多占几条（防一片霸屏：实测旧版 8/8 全来自同一片）。 */
const PER_SHARD_MAX = 2;

/** 检索预览的字符数与窗口锚点两侧的余量。 */
const SEARCH_PREVIEW_CHARS = 240;
const SEARCH_PREVIEW_PAD = 80;

/**
 * 检索打分的**长度归一强度**：`score / (1 + b·(len/avgLen − 1))`。
 * 动机：token 命中数是「免费的」—— 条目越长命中越多、分数虚高（实测一条 808 字符的
 * 诊断条目几乎霸榜所有 query）。b=0.5 实测把最大同分块从 3.13 压到 1.13、覆盖片升到 5.50。
 * 分母下限是 `1 − b`（b=0.5 时为 0.5，对 len≥0 恒成立，clamp 只是给调大 b 的人兜底）。
 */
const SEARCH_LENGTH_B = 0.5;

/**
 * 检索预览：定位到**最稀有**的命中 token 附近取一段窗口，而不是一律从条目开头截 ——
 * 实测 90% 的条目超 240 字符，从头截会把命中句整段丢掉（48% 的预览一个命中词都没有），
 * 模型据此无法判断「这条为什么命中」，只能整片 read。
 * 锚点按 idf 从高到低依次试：归一化命中的 token 在原文上 `indexOf` 可能失配
 * （大小写差异，如原文 `Advisor` vs 归一化 `advisor`），全部失配才退回条目开头 ——
 * 这是健壮性兜底，不是换选锚策略。
 * @param {string} flat - 条目原文（只把连续空白折成单空格）。
 * @param {string[]} anchorTokens - 该条目命中的有效 token，按 idf 降序。
 * @returns {string} 预览文本。
 */
function searchPreview(flat, anchorTokens) {
  const lower = flat.toLocaleLowerCase();
  for (const t of anchorTokens) {
    const pos = lower.indexOf(t);
    if (pos < 0) continue;
    const start = Math.max(0, pos - SEARCH_PREVIEW_PAD);
    const end = Math.min(flat.length, start + SEARCH_PREVIEW_CHARS);
    return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  }
  return flat.slice(0, SEARCH_PREVIEW_CHARS);
}

/**
 * 注入索引的**默认**字符预算（设置项 `indexBudget` 可改；0 = 不限制）。
 *
 * 历史：该值原为硬编码 9000，是「10 片 / 90 条」时代的取值。分片长到 27 片 / 285 条后，
 * 逐条索引需要约 1.5–2 万字符 → 整层被 [renderIndexBudgeted] 降级成「只列片名 + 条数」
 * 的空目录，模型没有任何条目线索，于是不再主动 read 记忆（2026-09-28 实测确认）。
 * 现在改为：预算内**按片配额**列最新 N 条，绝不整层退化成零线索。
 */
const DEFAULT_INDEX_BUDGET = 12000;

/**
 * 索引的收缩阶梯：预算装不下「全量逐条」时，逐档降低**每片最多列出的条目数**，
 * 每片都从**最新**的条目往前取 —— 保证任何一档下每片都有线索，而不是整层归零。
 * 最后两档 1 / 0 只是极端兜底（0 = 仅片级统计，与旧行为一致）。
 */
const INDEX_PER_SHARD_LADDER = [8, 5, 3, 2, 1, 0];

/**
 * 地图模式（`injectMode: "map"`，**默认档**）的层内内联阈值。
 *
 * 条目数 ≤ 该值的层仍然逐条列出标题：这类层本来只有几百字符（项目层单文件就是这种形态），
 * 内联出来比让模型多跑一次检索更值。超过阈值的层（典型是全局分片，35 片 / 333 条）只给
 * 「片名 · 关键词 · 条数 · 最新日期」的片级地图，条目标题与正文一律按需 memory_search + read（grep 只做 fallback）。
 */
const MAP_INLINE_MAX_ENTRIES = 12;

/** 项目层记忆目录。 */
const PROJECT_DIR = `${HOME}/.dsh/memory/projects`;

/** 卡片记忆层目录：角色卡召唤会话的剧情/世界事实落在这里，与全局/项目层完全隔离。 */
const CARDS_DIR = `${HOME}/.dsh/memory/cards`;

/** 卡片记忆的注入预算（字符）。卡片记忆是小体量正文，独立于 maxChars 之外。 */
const DEFAULT_CARD_BUDGET = 4000;

/**
 * dsh-card-summon 的自持状态目录（summons.json = 会话 id → 召唤记录）。
 * 本插件【只读】它判定「当前会话是否处于角色卡召唤中」；不写、不迁移、不清 ——
 * 生命周期完全归 dsh-card-summon 管。环境变量与其 state.js 同名同语义（测试隔离用）。
 */
const CARD_SUMMON_STATE = process.env.DSH_CARD_SUMMON_STATE?.trim() || `${HOME}/.dsh/card-summon`;

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

/** 插件宿主上下文（apply 时赋值）：handleActivity 按 sessionId 取 agent.session 用。 */
let HOST_CTX = null;

// 钩子子系统的纯函数与处理器：导出仅供 tests/probe.mjs 直测（host 半边自包含，无副作用）。
export {
  memoryTargetOf,
  slugOf,
  normalizePathText,
  normalizeToolPath,
  lexicalSearchTokens,
  lexicalRequiredMatchCount,
  entryRows,
  searchMemory,
  formatSearchResults,
  toolMemoryHit,
  projectMemoryActivity,
  handleActivity,
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
  disciplineBlock,
  renderMap,
  renderLayer,
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
    // 卡片记忆层（召唤会话的按卡记忆）：默认开。关掉 = 召唤中整段不注入、
    // 写卡片记忆路径同样被拦（此时召唤会话完全没有可写层）。
    cardsEnabled: v.cardsEnabled !== false,
    maxChars: budget,
    // 默认 map（片级地图）：条目标题不常驻，改由 memory_search 按需取；
    // index = 地图 + 逐条标题（受 indexBudget 收缩）；full = 正文整篇注入
    injectMode: v.injectMode === "full" ? "full" : v.injectMode === "index" ? "index" : "map",
    // 索引模式自己的预算：与 maxChars（正文上限）解耦，面板上两个档位各自独立
    indexBudget: Number.isFinite(v.indexBudget) ? Math.max(0, Math.floor(v.indexBudget)) : DEFAULT_INDEX_BUDGET,
    // ── 钩子子系统 ──
    writeGuard: v.writeGuard === "off" || v.writeGuard === "full" ? v.writeGuard : "rules",
    writeHookCommand: typeof v.writeHookCommand === "string" ? v.writeHookCommand : "",
    hookTimeoutMs: Number.isFinite(v.hookTimeoutMs) ? Math.max(1000, Math.floor(v.hookTimeoutMs)) : DEFAULT_HOOK_TIMEOUT_MS,
    readReminder: v.readReminder !== false,
    discipline: v.discipline !== false,
    injectHookCommand: typeof v.injectHookCommand === "string" ? v.injectHookCommand : "",
    audit: v.audit !== false,
    // 回合记忆栏（client 半边的 conversation.chat.turnTail 插槽），关掉只是不显示
    turnTail: v.turnTail !== false,
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
 *
 * Windows 上 cwd 是 `C:\Users\me\repo`：反斜杠与盘符冒号都不是合法的目录名字符，
 * 先归一成正斜杠、再把盘符与分隔符折成 `-`（`--C-Users-me-repo--`），与 DSH
 * `projectKey()` 的盘符处理一致；POSIX 路径的既有 slug 保持不变。
 * @param {string} cwd - 会话工作目录。
 * @returns {string} slug。
 */
function slugOf(cwd) {
  const normalized = normalizePathText(String(cwd ?? ""));
  const withoutDrive = normalized.replace(/^([A-Za-z]):(?=\/|$)/, "$1");
  const slug = withoutDrive.replace(/^\/+/, "").replace(/[/:]+/g, "-");
  return `--${slug.length > 0 ? slug : "root"}--`;
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
 * 索引模式的字符预算（设置项 `indexBudget`；0 = 不限制 → 始终全量逐条列出）。
 *
 * 与 `maxChars` 的分工：`maxChars` 管**正文**（full 模式 / 项目层 clamp），
 * `indexBudget` 管**索引**（index 模式每轮注入的那张表）。两者互不影响。
 *
 * @returns {number} 字符数。
 */
function indexBudget() {
  return readSettings().indexBudget;
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
 * 片级**关键词**：本机每个分片首行就是一条路由注释 ——
 * `<!-- 插件开发与发布 · 自研插件、客户端插件写法、hook 管线、发布 -->`。
 * 片名（H1）只说明「这片叫什么」，`·` 之后那一半才说明「这片讲什么」，
 * 是模型判断「该不该读这片」时最便宜的线索（对齐 Claude Skills 用 description
 * 做自动加载决策的思路）。只认**第一行**且必须带 `·`，避免误取第二行的写入说明。
 *
 * @param {string} text - 该片正文。
 * @param {string} name - 已解析出的片名（重复时丢弃关键词）。
 * @returns {string} 关键词（无则空串）。
 */
function shardKeywords(text, name) {
  const first = String(text).split("\n", 1)[0].trim();
  const m = first.match(/^<!--\s*(.+?)\s*-->$/);
  if (!m) return "";
  // 两种写法都认：`片名 · 关键词…`（本机主流）与 `片名：关键词…`；都没有分隔符时整句当关键词
  const parts = m[1]
    .split(/·|：/)
    .map((s) => s.trim())
    .filter(Boolean);
  const rest = (parts.length > 1 ? parts.slice(1) : parts).join(" · ");
  if (!rest || rest === name) return "";
  return rest.length > 96 ? `${rest.slice(0, 96)}…` : rest;
}

/**
 * 片内**最新条目日期**（`- [YYYY-MM-DD]` 的字典序最大值 = 时间最晚）。
 * 让模型一眼看出这片是「还在更新的活片」还是「陈年归档」——
 * 新近度是本机记忆里最可靠的排序信号（也是 mem0/Letta 那类系统的默认衰减轴）。
 *
 * @param {string} text - 该片正文。
 * @returns {string} `YYYY-MM-DD` 或空串。
 */
function latestEntryDate(text) {
  const dates = [...String(text).matchAll(/^\s*-\s*\[(\d{4}-\d{2}-\d{2})\]/gm)].map((m) => m[1]).sort();
  return dates.length > 0 ? dates[dates.length - 1] : "";
}

/**
 * 读一层的全部分片，得到渲染所需的条目化视图（片名 / 关键词 / 最新日期 / 条目 + 行号）。
 *
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @returns {object[]} 分片数组（空文件已剔除）。
 */
function collectShards(files) {
  const shards = [];
  for (const f of files) {
    const text = readOrEmpty(f.path).trim();
    if (!text) continue;
    const name = shardName(text, f.name);
    shards.push({
      name,
      keywords: shardKeywords(text, name),
      latest: latestEntryDate(text),
      path: f.path,
      text,
      entries: parseEntries(text),
    });
  }
  return shards;
}

/** 一层的条目总数（地图模式据此决定「逐条内联」还是「只给地图」）。 */
function layerEntryTotal(files) {
  return collectShards(files).reduce((n, s) => n + s.entries.length, 0);
}

// ── memory_search：词法检索器（v0.8，借鉴 dsh-mnemon 的 lexical 检索层）────────
// 与裸 grep 的差别：NFKC 归一化、中文 bigram 切分（"插件开发"→插件/件开/开发）、
// 字段加权（片名>关键词>条目）、token 覆盖度门槛（query 足够聚焦后才要求更广覆盖）、
// 相关度排序。纯同步文件扫描，百片量级毫秒级，无索引、无依赖。

/**
 * 检索词切分：中文段按相邻两字滑窗（bigram），西文按词（≥2 字符），去重限量。
 * 移植自 dsh-mnemon 的 search-tokens.ts（MIT）。
 * @param {string} value - 原始查询串。
 * @param {number} [maximum=64] - token 上限。
 * @returns {string[]} token 列表。
 */
function lexicalSearchTokens(value, maximum = 64) {
  const normalized = String(value ?? "").normalize("NFKC").toLocaleLowerCase();
  const tokens = [];
  for (const segment of normalized.split(/(\p{Script=Han}+)/u)) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const chars = [...segment];
      if (chars.length <= 2) tokens.push(segment);
      else for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
      continue;
    }
    tokens.push(...(segment.match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((t) => t.length >= 2));
  }
  return [...new Set(tokens)].slice(0, maximum);
}

/**
 * 覆盖度门槛：query 切出的 token 少于 4 个只要求命中 1 个；≥4 个要求命中 ⌈n/4⌉（至少 2）。
 * 「query 足够聚焦后才要求更广覆盖」——防宽泛 query 整库乱命中。
 * @param {string[]} tokens - 切分结果。
 * @returns {number} 至少要命中的 token 数（0 = 无门槛，靠整句命中）。
 */
function lexicalRequiredMatchCount(tokens) {
  if (tokens.length === 0) return 0;
  if (tokens.length < 4) return 1;
  return Math.max(2, Math.ceil(tokens.length / 4));
}

/**
 * 条目行遍历（带续行合并）：`- ` 开行起一条，后续非空/非标题/非新条目的行并入。
 * 行号语义与 parseEntries 一致（1 起，开行号；``` 围栏内容并入所在条目不切分）。
 * @param {string} text - 分片正文。
 * @returns {{line:number,text:string}[]} 条目列表。
 */
function entryRows(text) {
  const lines = String(text).split("\n");
  const out = [];
  let fence = false;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*```/.test(ln)) {
      fence = !fence;
      if (current) current.text += `\n${ln}`;
      continue;
    }
    if (fence) {
      if (current) current.text += `\n${ln}`;
      continue;
    }
    if (/^##\s+/.test(ln) || ln.trim() === "") {
      current = null;
      continue;
    }
    if (/^\s*-\s+\S/.test(ln)) {
      current = { line: i + 1, text: ln };
      out.push(current);
      continue;
    }
    if (current) current.text += `\n${ln}`;
  }
  return out;
}

/**
 * 全库检索：全局层 + 项目层，条目级打分排序。
 *
 * v0.9.1 的三点改动（针对「命中几百条、top 里分不清主次」）：
 * ① **片级加分挪出条目循环** —— 旧实现把 `phraseShard`（片名+12/关键词+7）与每 token 的
 *   片名+4/关键词+2 写在 entry 循环**内部**，它们与条目内容无关，于是**同一片所有命中条目
 *   分数完全相同**，排序退化成「日期 → 行号」；现在片级只作同分 tie-break（见 [SHARD_BONUS_PHRASE]）。
 *   连带修正：`hitTokens` 旧版先把「片名/关键词里出现的 token」塞进去（:880-883 那段），
 *   等于片级线索能单独满足覆盖度门槛、架空条目级判定；现在 hitTokens **只由条目内容贡献**。
 * ② **per-shard 配额**（[PER_SHARD_MAX]）—— 旧 `slice(0, limit)` 让一片吃掉全部名额
 *   （实测 8/8 全来自同一片）；现在每片最多占 2 条，铺不满 limit 时再放宽回填，
 *   保证「结果本来就少」时不会因为配额而更少。
 * ③ **作用域**（`options.scope`）—— 旧实现扫 projects/ 下**全部** slug，本机其它项目
 *   216 片 / 2028 条占池 60%，却不在地图里、模型无从路由，实测 top8 能被别的项目 8/8 占满。
 *   默认 `current` = 全局层 + `cwd` 所属项目层；`cwd` 取不到（探针直调、无会话上下文）
 *   或显式 `scope:"all"` → 退回全库，既有调用方行为不变。
 *   **少给的结果必须可见**：被跳过的层/片数进 `dropped` 并由 [formatSearchResults] 渲染出来。
 *
 * 打分：条目分 = 整句命中条目 +4 ＋ 每命中 token +1（只算条目正文）；
 * 覆盖度不足或零分的条目剔除；同分依次按 片级 tie-break → 日期新 → 行号。
 * @param {string} query - 查询串。
 * @param {{limit?:number,scope?:string,cwd?:string}} [options] - limit 默认 8（上限 20）；
 *   scope `"current"`（默认）| `"all"`；cwd 缺失时自动退化为 `"all"`。
 * @returns {{ok:true,query:string,results:object[],scanned:{files:number,entries:number,scope:string},totalHits:number,dropped:{capped:number,backfilled:number,offScopeLayers:number,offScopeFiles:number}}|{ok:false,error:string}}
 */
function searchMemory(query, options = {}) {
  const raw = String(query ?? "").trim();
  if (raw === "") return { ok: false, error: "query is required" };
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 8)));
  const normalized = raw.normalize("NFKC").toLocaleLowerCase();
  const tokens = lexicalSearchTokens(normalized);
  // required 到 pass2 才算：要先有 df 才能剔出跨词碎片（见下方 validTokens）。

  const cwd = typeof options.cwd === "string" ? options.cwd.trim() : "";
  // cwd 未知时不猜：宁可扫全库（＝旧行为），也不要静默少给结果。
  const scoped = options.scope !== "all" && cwd !== "";
  const currentSlug = scoped ? slugOf(cwd) : "";

  const files = [];
  for (const f of layerFiles(TOPICS_DIR, GLOBAL_MEMORY)) files.push({ ...f, layer: "global" });
  // 注：layerFiles 在分片目录存在时不再回落单文件 memory.md（注入层的语义）；
  // 但检索的目标是「全部用户记忆」，memory.md 里有内容就应当参与 —— 单独补上。
  if (existsSync(GLOBAL_MEMORY) && !files.some((f) => f.path === GLOBAL_MEMORY)) {
    files.push({ name: "memory.md", path: GLOBAL_MEMORY, layer: "global" });
  }
  let offScopeLayers = 0;
  let offScopeFiles = 0;
  for (const slug of listProjectSlugs()) {
    const dir = `${PROJECT_DIR}/${slug}`;
    const single = `${PROJECT_DIR}/${slug}.md`;
    if (scoped && slug !== currentSlug) {
      // 只数不读：内容都不进内存，多记一次 readdir 换「少给了多少」的可见性。
      offScopeLayers += 1;
      try {
        offScopeFiles += isDir(dir)
          ? readdirSync(dir).filter((n) => n.endsWith(".md")).length
          : existsSync(single)
            ? 1
            : 0;
      } catch {
        /* 数不出来就算了，不影响检索 */
      }
      continue;
    }
    if (isDir(dir)) {
      for (const f of layerFiles(dir, "")) files.push({ ...f, layer: `project:${slug}` });
    } else if (existsSync(single)) {
      files.push({ name: slug, path: single, layer: `project:${slug}` });
    }
  }

  // ── pass1：收池内全部条目，同时统计每个 token 的 df 与平均条目长度 ──────────
  // df/avgLen 与 pass2 必须用**同一个 scoring pool**（上面 scope 过滤后的 files），
  // 否则 idf 的 N 与实际语料不一致，稀有度不可比。
  const rows = [];
  const df = new Array(tokens.length).fill(0);
  let totalLen = 0;
  let scannedEntries = 0;
  for (const f of files) {
    const text = readOrEmpty(f.path);
    if (!text.trim()) continue;
    const name = shardName(text, f.name);
    const nName = name.normalize("NFKC").toLocaleLowerCase();
    const nKeywords = shardKeywords(text, name).normalize("NFKC").toLocaleLowerCase();
    // 片级线索：**循环外**算一次，只用于同分 tie-break，不进条目分、不进覆盖判定。
    const shardBonus = nName.includes(normalized)
      ? SHARD_BONUS_PHRASE
      : nKeywords.includes(normalized)
        ? SHARD_BONUS_KEYWORD
        : 0;
    for (const entry of entryRows(text)) {
      scannedEntries += 1;
      const nEntry = entry.text.normalize("NFKC").toLocaleLowerCase();
      const hitIdx = [];
      for (let i = 0; i < tokens.length; i++) if (nEntry.includes(tokens[i])) hitIdx.push(i);
      for (const i of hitIdx) df[i] += 1;
      totalLen += nEntry.length;
      rows.push({
        path: f.path,
        shard: name,
        layer: f.layer,
        line: entry.line,
        date: (entry.text.match(/\[(\d{4}-\d{2}-\d{2})\]/) ?? [])[1] ?? "",
        norm: nEntry,
        flat: entry.text.replace(/\s+/g, " "),
        hitIdx,
        exact: nEntry.includes(normalized),
        shardBonus,
      });
    }
  }

  // ── pass2：IDF 加权打分 + 长度归一 + 锚点预览 ─────────────────────────────
  // df=0 的 token 是中文 bigram 的跨词碎片（「盘空」「索历」，语料里不存在），权重记 0
  // 并**剔出覆盖门槛的分母** —— 旧实现把它们计入 token 数，门槛虚高。
  const poolSize = rows.length;
  const weight = tokens.map((t, i) => (df[i] > 0 ? Math.log(1 + poolSize / df[i]) : 0));
  const validTokens = [];
  for (let i = 0; i < tokens.length; i++) if (weight[i] > 0) validTokens.push(tokens[i]);
  // 门槛只改**输入**不改 lexicalRequiredMatchCount 本体；valid=0（query 全是碎片）时显式取 1，
  // 让整句命中仍能放行（下面用 validTokens.length > 0 兜住 anchors 恒空的情况）。
  const required = validTokens.length === 0 ? 1 : lexicalRequiredMatchCount(validTokens);
  const avgLen = poolSize > 0 ? totalLen / poolSize : 1;
  const phraseWeight = Math.log(1 + poolSize);

  const results = [];
  for (const r of rows) {
    let score = 0;
    const anchors = [];
    for (const i of r.hitIdx) {
      if (weight[i] > 0) {
        score += weight[i];
        anchors.push(i);
      }
    }
    if (r.exact) score += phraseWeight;
    if (score <= 0) continue;
    if (validTokens.length > 0 && anchors.length < required) continue;
    // 长度归一：压掉长条目「命中 token 数天然更多」的分数优势。
    // 分母下限 1−b 对 len≥0 恒成立（b=0.5 时 0.5），写明是为了给调大 b 的人看。
    const denom = Math.max(1 - SEARCH_LENGTH_B, 1 + SEARCH_LENGTH_B * (r.norm.length / avgLen - 1));
    anchors.sort((a, b) => weight[b] - weight[a]);
    results.push({
      path: r.path,
      shard: r.shard,
      layer: r.layer,
      line: r.line,
      date: r.date,
      score: +(score / denom).toFixed(4),
      shardBonus: r.shardBonus,
      text: searchPreview(r.flat, anchors.map((i) => tokens[i])),
    });
  }
  const compare = (a, b) =>
    b.score - a.score ||
    b.shardBonus - a.shardBonus ||
    (b.date || "").localeCompare(a.date || "") ||
    a.line - b.line;
  results.sort(compare);

  // ② per-shard 配额：先按每片 ≤PER_SHARD_MAX 铺，不够 limit 再放宽回填。
  // 已知语义（不是缺陷）：命中只来自一两片时，回填会让那片重新占满名额 ——
  // 宁多勿少，好过把「本来只有这些」的结果砍得更少。所以 capped 要和 backfilled 一起看。
  const perPath = new Map();
  const picked = [];
  let capped = 0;
  for (const r of results) {
    const used = perPath.get(r.path) ?? 0;
    if (used >= PER_SHARD_MAX) {
      capped += 1;
      continue;
    }
    perPath.set(r.path, used + 1);
    picked.push(r);
    if (picked.length >= limit) break;
  }
  let backfilled = 0;
  if (picked.length < limit) {
    // 名额铺不满时放宽配额回填 —— 否则「结果本来就少」会因为配额而更少。
    // 回填的条目会从 capped 里捡回来，所以两个数都要报，不能只报 capped。
    const seen = new Set(picked);
    for (const r of results) {
      if (picked.length >= limit) break;
      if (seen.has(r)) continue;
      seen.add(r);
      picked.push(r);
      backfilled += 1;
    }
  }
  picked.sort(compare);
  return {
    ok: true,
    query: raw,
    results: picked,
    scanned: { files: files.length, entries: scannedEntries, scope: scoped ? "current" : "all" },
    totalHits: results.length,
    dropped: { capped, backfilled, offScopeLayers, offScopeFiles },
  };
}

/** 把检索结果渲染成模型可读文本（工具 output.render 用）。 */
function formatSearchResults(value) {
  if (!value || value.ok !== true) return `memory_search 失败：${value?.error ?? "unknown"}`;
  // 「少给了多少」必须可见：默认作用域只扫当前项目层，跨项目的东西不写出来就像凭空消失。
  const scopeNote =
    value.scanned.scope === "current"
      ? `；作用域=当前项目层（已跳过其它项目 ${value.dropped?.offScopeLayers ?? 0} 层 / ${value.dropped?.offScopeFiles ?? 0} 片，要跨项目搜就带 scope:"all"）`
      : "";
  const capNote =
    value.dropped?.capped > 0
      ? `；每片限 ${PER_SHARD_MAX} 条，挡 ${value.dropped.capped} 条（其中 ${value.dropped.backfilled ?? 0} 条因名额没铺满已回填）`
      : "";
  if (value.results.length === 0) {
    return `memory_search：无命中（扫描 ${value.scanned.files} 个文件 / ${value.scanned.entries} 条条目${scopeNote}）。换关键词重试，或用 grep 做精确正则；要找别的项目的记忆就带 scope:"all"。`;
  }
  const rows = value.results.map(
    (r, i) => `${i + 1}. [score ${r.score}] ${r.path}:${r.line}${r.date ? ` [${r.date}]` : ""}\n   ${r.text}`,
  );
  return [
    `memory_search：共 ${value.totalHits} 条命中（显示前 ${value.results.length} 条；扫描 ${value.scanned.files} 文件 / ${value.scanned.entries} 条目${scopeNote}${capNote}），按相关度排序。`,
    ...rows,
    "→ read 对应文件的行号取上下文；条目行号即记忆纪律里的 L 号。",
  ].join("\n");
}

/** 片级统计行（两个渲染器共用）：片名 · 条数 · 体量 · 最新日期 · 路径。 */
function shardHeadLine(s) {
  const over = s.text.length > SHARD_WARN_CHARS ? ` ⚠️超建议${SHARD_WARN_CHARS}` : "";
  const fresh = s.latest ? ` · 最新 ${s.latest}` : "";
  return `## ${s.name} (${s.entries.length} 条 · ${(s.text.length / 1000).toFixed(1)}k${fresh}${over}) → ${s.path}`;
}

/**
 * 渲染一层的**片级地图**（地图模式，默认档）：只有片名 / 关键词 / 条数 / 体量 / 最新日期。
 *
 * 与 [renderIndex] 的差别：条目标题与正文都不进提示词。代价是模型必须调 memory_search
 * 才看得到条目 —— 所以头注释必须把「先 memory_search 取线索、命中后按行号读」写清楚，
 * 否则会退化成「没有线索就不读」（那个失败模式见 renderIndexBudgeted 的注释）。
 *
 * @param {string} header - 层名（写进注释头）。
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @returns {string} 地图正文（无内容时为空串）。
 */
function renderMap(header, files) {
  const shards = collectShards(files);
  if (shards.length === 0) return "";
  const total = shards.reduce((n, s) => n + s.entries.length, 0);
  const chars = shards.reduce((n, s) => n + s.text.length, 0);
  const out = [
    // 头行刻意只放档位，不放「N 片 / M 条 / K 字符」：那三个数字每写一条记忆就变，
    // 而头行在 system prompt 最前面 —— 一变就让整个前缀失去缓存（2026-09-30 实测：
    // 写一条记忆后，同款子代理委派的首轮 cacheRead 从 85% 掉回 0%）。
    // 统计一律挪到段尾，让"变化点"尽量靠后。
    `<!-- ${header} · 地图模式。`,
    "     本层只给「片名 · 关键词」级线索，条目标题与正文都不在提示词里。检索两步走：",
    '       ① memory_search query="<任务关键词>" 先取线索（按相关度返回条目 + 文件行号）；',
    '       ② 按行号取回：read path="<命中的片路径>" offset=<行号> limit=<要取几行>；',
    '          只有 memory_search 无命中、或要精确正则 / 按路径限定范围时，才用 grep pattern="<关键词>" path="<片路径或记忆目录>" -->',
  ];
  for (const s of shards) {
    out.push("", shardHeadLine(s));
    if (s.keywords) out.push(`   关键词：${s.keywords}`);
  }
  out.push("", `<!-- 本层：${shards.length} 片 / ${total} 条 / ${chars} 字符 -->`);
  return out.join("\n");
}

/**
 * 渲染一层的**注入索引**：片级统计（片名 · 条数 · 体量 · 最新日期 · 关键词）+ 片内条目「标题 · 行号」。
 *
 * @param {string} header - 层名（写进注释头）。
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @param {number} [perShard] - 每片最多列出的条目数（**从最新的往前取**）；Infinity = 全列，0 = 只列片级统计。
 * @param {string} [label] - 头注释里的档位名。地图模式下小层内联时要传，否则同一份注入里出现
 *   「地图模式」（全局段）与「索引模式」（项目段）两种措辞，模型会以为有两套检索方式。
 * @returns {string} 索引正文（无内容时为空串）。
 */
function renderIndex(header, files, perShard = Infinity, label = "索引模式") {
  const shards = collectShards(files);
  if (shards.length === 0) return "";

  const total = shards.reduce((n, s) => n + s.entries.length, 0);
  const chars = shards.reduce((n, s) => n + s.text.length, 0);
  const quota = perShard <= 0 ? 0 : Number.isFinite(perShard) ? Math.floor(perShard) : Infinity;
  const out = [
    // 头行只放档位，统计挪到段尾 —— 理由同 renderMap（避免"写一条记忆就让前缀全失效"）。
    `<!-- ${header} · ${label}。`,
    "     正文不在提示词里 —— 先用 memory_search query=\"<任务关键词>\" 取线索，再按行号读取：",
    '       read path="<路径>" offset=<L 号> limit=<行数>；只有无命中 / 要精确正则 / 已知路径时才直接 grep/read -->',
  ];
  for (const s of shards) {
    out.push("", shardHeadLine(s));
    if (s.keywords) out.push(`   关键词：${s.keywords}`);
    const listed =
      quota === Infinity ? s.entries : quota <= 0 ? [] : s.entries.slice(Math.max(0, s.entries.length - quota));
    for (const e of listed) {
      out.push(`- [L${e.line}] ${e.title}${e.len > ENTRY_WARN_CHARS ? " ·长" : ""}`);
    }
    const hidden = s.entries.length - listed.length;
    if (listed.length === 0) {
      if (s.entries.length > 0) out.push(`- （${s.entries.length} 条；索引预算已满，未逐条列出，直接按路径读取）`);
    } else if (hidden > 0) {
      const lastHidden = s.entries[hidden - 1].line;
      out.push(`- （上面只列最新 ${listed.length} 条；更早的 ${hidden} 条在同文件第 ${s.entries[0].line}–${lastHidden} 行）`);
    }
  }
  out.push("", `<!-- 本层：${shards.length} 片 / ${total} 条 / ${chars} 字符 -->`);
  return out.join("\n");
}

/**
 * 带预算的索引渲染：**绝不整层归零**。
 *
 * 旧行为是「超预算 → 整层退化为只列片级统计」。实测（2026-09-28，27 片 / 285 条 / 198k 字符）：
 * 逐条索引约需 1.5–2 万字符 > 硬编码预算 9000 → 每片只剩一行「N 条；索引预算已满」，
 * 模型拿不到任何条目标题，也就没有理由去 read —— 表现就是「插件明明在注入，却不读记忆」。
 * 现在改为沿 [INDEX_PER_SHARD_LADDER] 逐档收缩「每片最新 N 条」：预算越紧，每片列得越少，
 * 但**每片都保留线索**（含关键词与最新日期），只有极端情况才落到 0（仅统计）。
 *
 * @param {string} header - 层名。
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @param {string} [label] - 透传给 [renderIndex] 的档位名。
 * @returns {string} 索引正文。
 */
function renderIndexBudgeted(header, files, label = "索引模式") {
  const budget = indexBudget();
  const full = renderIndex(header, files, Infinity, label);
  if (budget <= 0 || full.length <= budget) return full;
  for (const perShard of INDEX_PER_SHARD_LADDER) {
    const text = renderIndex(header, files, perShard, label);
    if (text.length <= budget) return text;
  }
  return renderIndex(header, files, 0, label);
}

/**
 * 按注入模式渲染**一层**（地图 / 索引）—— compose 用的统一入口。
 *
 * 地图模式下条目少的层（≤ [MAP_INLINE_MAX_ENTRIES]）仍走逐条索引：这类层只有几百字符，
 * 内联出来比让模型多跑一次检索更值（项目层单文件就是这种形态）；条目多的层才收成地图。
 *
 * @param {string} mode - `map` 或 `index`（`full` 不走这里）。
 * @param {string} header - 层名。
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @returns {string} 注入正文（无内容时为空串）。
 */
function renderLayer(mode, header, files) {
  if (mode === "map" && layerEntryTotal(files) > MAP_INLINE_MAX_ENTRIES) return renderMap(header, files);
  // 地图模式下走到这里 = 「本层条目少」：照样内联逐条，但头注释要说清是哪一档，
  // 否则同一份注入里会同时出现「地图模式」（条目多的层）与「索引模式」（条目少的层），
  // 模型会以为有两套检索方式（2026-09-29 由检索子代理指出）。
  return renderIndexBudgeted(header, files, mode === "map" ? "地图模式 · 本层条目少，已逐条内联" : "索引模式");
}

/**
 * full 模式（`injectMode: "full"`）的注入正文。
 *
 * 修 bug（2026-09-28）：旧实现在**全局层**直读 `~/.dsh/memory.md`，但该文件在分片迁移后
 * 只剩一张导航表（965 字符 / 0 条目，且表格随分片漂移、已经过时）—— 切到「全文注入」
 * 反而比索引模式**少**一大截记忆，与面板文案「把每片正文整篇放进提示词」不符。
 * 现在全局层与项目层一样走分片：
 *   · 单文件回落 → 交给 clamp（保头部 + 溢出条目索引，与旧行为一致）
 *   · 分片且总量 ≤ 预算 → 逐片整篇注入
 *   · 分片且总量 > 预算 → 自动回退索引模式，并在头注释里说明原因
 *     （分片规模下「全文注入」必然超预算；硬塞只会把每片都切成碎片，不如给一张带行号的索引）
 *
 * @param {string} header - 层名（写进注释头）。
 * @param {{name:string,path:string}[]} files - 该层文件。
 * @returns {string} 注入正文（无内容时为空串）。
 */
function renderShardFull(header, files) {
  const shards = [];
  for (const f of files) {
    const text = readOrEmpty(f.path).trim();
    if (text) shards.push({ name: shardName(text, f.name), path: f.path, text });
  }
  if (shards.length === 0) return "";
  if (shards.length === 1) {
    return `<!-- ${header} · ${shards[0].path} -->\n\n${clamp(shards[0].text, shards[0].path)}`;
  }
  const chars = shards.reduce((n, s) => n + s.text.length, 0);
  const budget = maxChars();
  if (budget > 0 && chars > budget) {
    return (
      `<!-- ${header} · 你选了全文注入，但 ${shards.length} 片共 ${chars} 字符 > 上限 ${budget}` +
      ` → 自动回退索引模式（要强制全文请把「正文上限」设为 0 = 不限制） -->\n\n${renderIndexBudgeted(header, files)}`
    );
  }
  // 头行只放档位（理由同 renderMap）：片数与字符数每写一条记忆就变，放头行会毁掉整个前缀。
  const out = [`<!-- ${header} · 全文注入。`];
  for (const s of shards) out.push("", `## ${s.name} → ${s.path}`, "", s.text);
  out.push("", `<!-- 本层：${shards.length} 片 / ${chars} 字符${budget > 0 ? ` · 上限 ${budget}` : " · 不限制"} -->`);
  return out.join("\n");
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
    // 头行不放「索引 N 条 / 正文 M 篇」—— 那两个数字随写入变，放头行会毁掉整个前缀（理由同 renderMap）。
    `<!-- 项目记忆 · ${cwd} · 目录形式（人写的索引整篇注入，正文按需 read） -->`,
  ];
  if (indexText) {
    parts.push("", `## 索引 (MEMORY.md) → ${indexPath}`, "", clamp(indexText, indexPath));
  }
  if (orphans.length > 0) {
    parts.push("", "## 未被索引登记的正文（要么读它，要么把它补进 MEMORY.md）");
    for (const f of orphans) parts.push(`- ${f.name} (${(f.size / 1000).toFixed(1)}k)`);
  }
  parts.push("", `<!-- 写入本层：正文写进对应主题文件，并在 MEMORY.md 补一行 \`- [标题](文件.md) — 摘要\` -->`);
  parts.push("", `<!-- 本层：索引 ${entries} 条 / 正文 ${others.length} 篇 -->`);
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

  // ── 召唤分支：角色卡召唤会话完全绕开常规记忆 ─────────────────────────────
  // context.agent 是宿主 AssembleContext 增广挂上的会话 Agent（只带 id）；
  // 取不到 id 时不屏蔽（宁可漏判正常注入，不误伤非召唤会话）。
  const sessionId = context?.agent?.id ?? context?.agent?.session?.header?.id;
  const guarded = summonGuardHit(sessionId);
  if (guarded) {
    return applyInjectFilter(messagesOfSummon(guarded, values));
  }

  // ── 全局层 ──────────────────────────────────────────────────────────────
  const mode = values.injectMode;
  const blocks = [];
  if (values.globalEnabled !== false) {
    if (mode === "full") {
      // full 模式：走分片正文（而不是已废弃的 memory.md 导航索引）——见 renderShardFull
      const body = renderShardFull(`全局记忆 · ${HOME}/.dsh/memory`, layerFiles(TOPICS_DIR, GLOBAL_MEMORY));
      if (body) blocks.push(neutralizePromptVars(body));
    } else {
      const body = renderLayer(mode, `全局记忆 · ${HOME}/.dsh/memory`, layerFiles(TOPICS_DIR, GLOBAL_MEMORY));
      if (body) {
        // 索引 / 地图里的标题同样可能含 `{{` —— 必须与 full 模式一样拆开，否则整段组装会炸
        blocks.push(
          neutralizePromptVars(
            `${body}\n\n<!-- 写入本层：往上面某一片追加一行（- [YYYY-MM-DD] 事实），或在同一目录新建主题文件 -->`,
          ),
        );
      }
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
      if (mode !== "full") {
        // 目录形式：MEMORY.md 已是人写索引，走「索引正文 + 孤儿正文清单」——地图模式同样整篇保留它
        // （人写的摘要是路由信息，比自动索引更值钱，本来也只有几 k 字符）
        // 单文件形式：本身就是条目集合，按当前模式渲染（条目少时地图模式仍逐条内联）
        const dirShape = isDir(dir);
        const body = dirShape
          ? renderProjectDir(cwd, dir)
          : renderLayer(mode, `项目记忆 · ${cwd}`, layerFiles("", filePath));
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
  if (body && values2.discipline !== false) body = `${body}\n\n${disciplineBlock(mode)}`;
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
  mkdirSync(dirname(normalizeToolPath(path)), { recursive: true });
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

/**
 * 重定向目标：`> f` / `>> f` / `2> f`。带引号的目标整段捕获（Windows 用户名常含空格），
 * fd 复制（`>&2`）与 `/dev/null` 由提取器丢掉。
 */
const BASH_REDIRECT_RE = /(?:^|[\s;&|()])\d?>>?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g;

/** tee 的目标文件（跳过 `-a` 之类选项）。 */
const BASH_TEE_RE = /(?:^|[\s;&|()])tee\b(?:\s+-{1,2}[A-Za-z]+)*\s+([^;&|()]+)/g;

/** sed -i：就地改文件，参数形式太多（macOS 还要跟一个备份后缀），按整条命令保守判。 */
const BASH_SED_I_RE = /(?:^|[\s;&|()])sed\s+(?:[^;&|()]*?\s)?-i\b/;

/**
 * 记忆路径字面量（bash command 里可能出现的形态）。
 * 匹配前命令文本会先展开 `~` / `$HOME` / `%USERPROFILE%` 并把反斜杠归一成 `/`，
 * 因此这里只留归一化后的绝对形态即可覆盖 Windows 与 POSIX 两种写法。
 */
const MEMORY_PATH_TOKENS = [`${HOME}/.dsh/memory.md`, `${HOME}/.dsh/AGENTS.md`, `${HOME}/.dsh/memory`];

/**
 * shell 命令文本归一化（**只用于匹配，不用于执行**）：反斜杠转 `/`、展开 home 别名。
 * @param {unknown} command - shell 命令。
 * @returns {string} 归一化后的命令文本。
 */
function normalizeCommandText(command) {
  let s = String(command ?? "").replace(/\\/g, "/");
  s = s.replace(/\$\{HOME\}|\$HOME\b|%USERPROFILE%|\$env:USERPROFILE/gi, () => HOME);
  return s.replace(/(^|[\s"'=:(;&|])~(?=\/)/g, (_match, lead) => `${lead}${HOME}`);
}

/**
 * 命令文本里是否出现记忆管辖路径（大小写按平台规则比较）。
 * @param {unknown} command - shell 命令。
 * @returns {boolean} 是否提及。
 */
function mentionsMemoryPath(command) {
  const hay = pathKey(normalizeCommandText(command));
  return MEMORY_PATH_TOKENS.some((token) => hay.includes(pathKey(token)));
}

/** audit.log 的轮转阈值。 */
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

/** 外部钩子默认超时。 */
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * 判断路径是否落在钩子管辖范围内，并给出层归属。
 * @param {string} path - 绝对路径。
 * @returns {{kind:string, layer:string}|null} 层归属；null = 不归记忆钩子管。
 */
// ══ 卡片记忆层：召唤状态探测与小工具 ══════════════════════════════════════════
// 召唤状态是 dsh-card-summon 的 store（~/.dsh/card-summon/summons.json），
// 这里只读：missing / 坏 JSON 都当「不在召唤中」，宁可漏判也不误屏蔽正常会话。

/** slug：与 dsh-card-summon lib/state.js 的 safeId 同构 —— 卡 fullPath → 文件安全串。 */
function cardSlugOf(fullPath) {
  return String(fullPath ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 卡片记忆文件路径（slug 已安全化时才合法）。 */
function cardMemoryPathOf(slug) {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 160 || !/^[A-Za-z0-9_-]+$/.test(slug)) return null;
  return `${CARDS_DIR}/${slug}.md`;
}

/**
 * 给一条召唤记录算卡片记忆路径。阵容（cast）的 fullPath 是逗号串 → 没有单卡记忆可写。
 * @param {object} hit - summons.json 里该会话的记录（fullPath/name/kind…）。
 * @returns {{slug:string,path:string}|null} null = 没有可写的单卡记忆路径。
 */
function cardMemoryOfSummon(hit) {
  const fullPath = String(hit?.fullPath ?? "");
  if (fullPath.length === 0 || fullPath.includes(",")) return null;
  const slug = cardSlugOf(fullPath);
  const path = cardMemoryPathOf(slug);
  return path ? { slug, path } : null;
}

/** mtime 缓存：compose / writeGuard 每轮都会问，同一 mtime 只读一次盘。 */
let summonCache = { mtime: -1, map: {} };

/**
 * 读 dsh-card-summon 的召唤状态表（会话 id → 记录）。失败一律返回空表。
 * @returns {Record<string, object>}
 */
function summonMapOnDisk() {
  const store = `${CARD_SUMMON_STATE}/summons.json`;
  try {
    const mtime = statSync(store).mtimeMs;
    if (summonCache.mtime === mtime) return summonCache.map;
    const raw = JSON.parse(readFileSync(store, "utf8"));
    const map = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    summonCache = { mtime, map };
    return map;
  } catch {
    summonCache = { mtime: -1, map: {} };
    return {};
  }
}

/**
 * 该会话是否正处于召唤中（读 card-summon 的落盘状态）。
 * @param {string|undefined} sessionId
 * @returns {object|null} 召唤记录（fullPath/name/kind…）；不在召唤中 = null。
 */
function summonOfSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const hit = summonMapOnDisk()[sessionId];
  return hit && typeof hit === "object" ? hit : null;
}

/**
 * 当前会话的调用方想屏蔽哪些层 —— compose 与 writeGuard 共用的语义：
 * 召唤中（有记录）→ 全局层 + 项目层 + 规则层全部视为被屏蔽，写指引给卡片记忆路径。
 */
function summonGuardHit(sessionId) {
  const hit = summonOfSession(sessionId);
  if (!hit) return null;
  return { hit, card: cardMemoryOfSummon(hit) };
}

/**
 * bash 命令的落盘目标是否**全部**指向卡片记忆目录（召唤中放行的唯一 bash 目标）。
 * `~` / `$HOME` 在 [normalizeToolPath] 里展开；失败/抽不出目标 = 不放行（保守）。
 * @param {string} command
 * @returns {boolean}
 */
function bashTargetCardOnly(command) {
  const targets = bashWriteTargets(command);
  if (targets.length === 0) return false;
  return targets.every((target) => isUnderPath(target, CARDS_DIR));
}

/**
 * 卡片记忆文件头（写文件时模型自带最好；没有也能从头部注释里解析出展示名）。
 * @param {object} hit - 召唤记录。
 * @returns {string}
 */
/**
 * 卡片记忆正文预算截断：超预算在行边界截断并留一行提示（与普通层的 clamp 不同，
 * 卡片记忆不逐行建索引 —— 一卡的条目量级小，超预算者在文件里按条目 read 即可）。
 * @param {string} text
 * @param {string} path - 提示里要给的文件路径。
 * @param {number} [budget=DEFAULT_CARD_BUDGET]
 * @returns {string}
 */
function clampCard(text, path, budget = DEFAULT_CARD_BUDGET) {
  if (budget <= 0 || text.length <= budget) return text;
  let cut = text.lastIndexOf("\n", budget);
  if (cut < Math.floor(budget / 2)) cut = budget;
  return `${text.slice(0, cut)}\n<!-- 卡片记忆超预算已截断（剩 ${text.length - cut} 字符）：旧条目按需 read ${path} -->`;
}

/**
 * 召唤会话的注入文案（compose 的卡片记忆块）。
 * 结构：说明块（长期记忆已屏蔽 + 写入指引）+ 卡片记忆正文。
 * 阵容（cast）会话：各成员卡的记忆分摊注入，不给写入路径（没有单卡sink）。
 * @param {{hit:object,card:object|null}} guarded - summonGuardHit 的返回。
 * @param {{cardsEnabled?:boolean}} values - 当前设置。
 * @returns {string}
 */
function messagesOfSummon(guarded, values) {
  const { hit, card } = guarded;

  // ── 说明块 ──────────────────────────────────────────────────────────────
  const name = String(hit?.name ?? "角色卡");
  const lines = [];
  lines.push(
    `<!-- 卡片召唤记忆块 · ${name} -->`,
    `本会话由 dsh-card-summon 召唤（${name}）。长期记忆（全局 ~/.dsh/memory/topics/、项目层、规则文件）【已屏蔽注入，也不应写入】`,
    `——剧情/世界观/互动事实是卡片上下文，不是用户与仓库的事实，留在长期记忆会污染后续所有会话。`,
  );
  if (card && values?.cardsEnabled !== false) {
    lines.push(
      `本卡剧情/世界事实【只】写卡片记忆：\`${card.path}\`（一张卡一个文件，随卡保留，召唤面板可清除）。`,
      `条目格式 \`- [YYYY-MM-DD] 事实\`；新建该文件时第一行写头注释 \`<!-- 卡片记忆 · ${name} · ${String(hit?.fullPath ?? "")} -->\`（清除面板靠它显示卡名）。`,
      `长文/截图不要进这里，引用文件路径即可。`,
    );
  } else {
    // cardsEnabled 关闭 / 阵容没有单卡路径：明确告知没有可写处，不给模糊暗示。
    lines.push(
      card
        ? "卡片记忆层已在设置中关闭：本会话没有任何可写的记忆路径，剧情事实不记录。"
        : "本会话是多卡阵容（cast），没有单卡记忆路径：剧情事实不记录，任何长期记忆路径都不要写。",
    );
  }

  // ── 卡片记忆正文 ────────────────────────────────────────────────────────
  const bodies = [];
  if (values?.cardsEnabled !== false) {
    if (card) {
      // 单卡：读自己那份。文件可能还没有（首次召唤）→ 只给说明 + 让模型按需创建。
      const body = readOrEmpty(card.path).trim();
      const text = body.length === 0 ? `（本卡还没有卡片记忆，按上面的格式开新条目即可。）` : clampCard(body, card.path);
      bodies.push(`<!-- 卡片记忆 · ${card.slug} -->\n${text}`);
    } else {
      // 阵容：读各成员卡的记忆（fullPath 逗号串），预算整体分摊。
      const fullPaths = String(hit?.fullPath ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const perBudget = Math.max(600, Math.floor(DEFAULT_CARD_BUDGET / Math.max(1, fullPaths.length)));
      for (const fp of fullPaths) {
        const path = cardMemoryPathOf(cardSlugOf(fp));
        if (!path) continue;
        const body = readOrEmpty(path).trim();
        if (body.length === 0) continue;
        bodies.push(`<!-- 卡片记忆 · ${cardSlugOf(fp)} -->\n${clampCard(body, path, perBudget)}`);
      }
    }
  }

  const cardText = bodies.length > 0 ? `\n\n${bodies.join("\n\n")}` : "";
  return neutralizePromptVars(`${lines.join("\n")}${cardText}`);
}

/**
 * 判断路径是否落在钩子管辖范围内，并给出层归属。
 *
 * 比较前先归一化（反斜杠 → `/`、展开 `~` / `$HOME`），Windows / macOS 再按大小写不敏感比较 ——
 * 否则 Windows 上真实的 `C:\Users\me\.dsh\memory\...` 永远匹配不上 `${HOME}/.dsh/memory`，
 * 写入守卫、审计与读取提醒都会静默失效（issue #1）。
 * @param {string} path - 工具给出的文件路径。
 * @returns {{kind:string, layer:string}|null} 层归属；null = 不归记忆钩子管。
 */
function memoryTargetOf(path) {
  const normalized = normalizeToolPath(path);
  if (normalized.length === 0) return null;
  if (samePath(normalized, `${HOME}/.dsh/memory.md`)) return { kind: "global-single", layer: "global" };
  if (samePath(normalized, `${HOME}/.dsh/AGENTS.md`)) return { kind: "rules", layer: "rules" };
  const root = `${HOME}/.dsh/memory`;
  if (!isUnderPath(normalized, root) || samePath(normalized, root)) return null;
  const rel = normalized.slice(root.length + 1);
  const relKey = pathKey(rel);
  if (relKey.startsWith("topics/")) return { kind: relKey.endsWith(".md") ? "topic" : "plugin-internal", layer: "global" };
  if (relKey.startsWith("cards/")) {
    // 卡片记忆层：一层一级的一张 .md 一张卡；子层级或非 .md 都算插件内部资产。
    const rest = rel.slice("cards/".length);
    const key = pathKey(rest);
    if (key.endsWith(".md") && !key.slice(0, -3).includes("/")) {
      return { kind: "card", layer: `card:${rest.slice(0, -3)}` };
    }
    return { kind: "plugin-internal", layer: "global" };
  }
  if (relKey.startsWith("projects/")) {
    const rest = rel.slice("projects/".length);
    const key = pathKey(rest);
    const slash = key.indexOf("/");
    if (slash === -1) {
      return {
        kind: key.endsWith(".md") ? "project-single" : "plugin-internal",
        layer: `project:${rest.replace(/\.md$/i, "")}`,
      };
    }
    const slug = rest.slice(0, slash);
    const file = rest.slice(slash + 1);
    const fileKey = key.slice(slash + 1);
    if (pathKey(file) === pathKey("MEMORY.md")) return { kind: "project-index", layer: `project:${slug}` };
    if (fileKey.endsWith(".md")) return { kind: "project-body", layer: `project:${slug}` };
    return { kind: "plugin-internal", layer: `project:${slug}` };
  }
  if (relKey === "audit.log" || relKey.endsWith(".bak")) return { kind: "plugin-internal", layer: "global" };
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
 * 外部钩子 / 注入过滤命令所用的 shell。
 *
 * Windows 用 `%ComSpec%`（cmd.exe）；POSIX 优先 zsh（保持旧行为），其次 `$SHELL`，
 * 最后 `/bin/sh`。旧实现硬编码 `/bin/zsh` —— Windows / 精简 Linux 上 spawn 直接
 * ENOENT，`writeGuard:"full"` 与 `injectHookCommand` 会静默退化成「放行 / 不过滤」。
 * @param {string} command - 交给 shell 的一整条命令。
 * @returns {{file:string,args:string[]}} execFile / spawnSync 的 file + args。
 */
function shellInvocation(command) {
  if (process.platform === "win32") {
    return { file: firstText(process.env.ComSpec) || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const shell = ["/bin/zsh", firstText(process.env.SHELL), "/bin/sh"].find((candidate) => candidate && existsSync(candidate)) ?? "/bin/sh";
  return { file: shell, args: ["-c", command] };
}

/**
 * 跑一次外部命令钩子：stdin 传 payload JSON。
 * @param {string} command - shell 命令（经 [shellInvocation] 选定的 shell 执行）。
 * @param {object} payload - 判定输入。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<{decision:string, reason?:string, note?:string}>} 决策。
 */
function runCommandHook(command, payload, timeoutMs) {
  return new Promise((resolve) => {
    const shell = shellInvocation(command);
    const child = execFile(shell.file, shell.args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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
 * 抽出 bash 命令里真正落盘的目标路径。
 *
 * 纯 fd 复制（`>&2`）与 `/dev/null` 不算落盘 —— 这正是「只读命令带
 * `2>/dev/null` 被误判成改记忆」的根因。只读命令（cat/ls/grep）抽不出任何目标。
 * 每个目标都过 [normalizeToolPath]：去引号、展开 `~` / `$HOME`、反斜杠转 `/`，
 * 这样 Windows 的 `C:\Users\me\.dsh\memory\a.md` 与 POSIX 写法能走同一套比较。
 *
 * @param {string} command - bash 命令。
 * @returns {string[]} 目标路径（已归一化）；没有写入时为空数组。
 */
function bashWriteTargets(command) {
  const cmd = String(command ?? "");
  const out = [];
  const push = (chunk) => {
    for (const raw of splitShellWords(chunk)) {
      if (!raw || raw === "/dev/null" || /^&\d*$/.test(raw)) continue;
      const target = normalizeToolPath(raw);
      if (target.length > 0) out.push(target);
    }
  };
  for (const m of cmd.matchAll(BASH_REDIRECT_RE)) push(m[1]);
  for (const m of cmd.matchAll(BASH_TEE_RE)) push(m[1]);
  return out;
}

/**
 * 按 shell 引号规则切词（只用于提取落盘目标，不执行命令）：
 * 双引号 / 单引号内的空格不切，引号本身不进结果。
 * @param {unknown} text - 一段命令文本。
 * @returns {string[]} 去引号后的词。
 */
function splitShellWords(text) {
  const words = [];
  let buffer = "";
  let quote = "";
  for (const ch of String(text ?? "")) {
    if (quote) {
      if (ch === quote) quote = "";
      else buffer += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buffer.length > 0) {
        words.push(buffer);
        buffer = "";
      }
      continue;
    }
    buffer += ch;
  }
  if (buffer.length > 0) words.push(buffer);
  return words;
}

/**
 * bash command 的保守启发式：只有「真的写向记忆路径」才交人工确认。
 *
 * 先定位落盘目标，再拿目标比对记忆路径字面量；不再因为命令里同时出现
 * 记忆路径和任意一个 `>`（如 `... 2>/dev/null`）就误判。sed -i 无法可靠
 * 拆出目标，退回整条命令判定（保守）。
 *
 * @param {string} command - bash 命令。
 * @returns {boolean} 是否命中。
 */
function bashTouchesMemory(command) {
  const cmd = String(command ?? "");
  if (!BASH_MUTATE_RE.test(cmd)) return false;
  if (BASH_SED_I_RE.test(cmd)) return mentionsMemoryPath(cmd);
  const scope = bashWriteTargets(cmd).join(" ");
  if (!scope) return false;
  return mentionsMemoryPath(scope);
}

/** 写入钩子的当前配置。 */
function guardConfig() {
  const v = readSettings();
  const guard = v.writeGuard === "off" || v.writeGuard === "full" ? v.writeGuard : "rules";
  return {
    guard,
    command: typeof v.writeHookCommand === "string" ? v.writeHookCommand : "",
    timeoutMs: Number.isFinite(v.hookTimeoutMs) ? Math.max(1000, Math.floor(v.hookTimeoutMs)) : DEFAULT_HOOK_TIMEOUT_MS,
    values: v,
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

  // ── 召唤判定（write/edit/bash 三个分支共用）──────────────────────────────
  // exec.agent 是宿主挂上的会话 Agent（只带 id）；取不到 = 不屏蔽。
  const values = cfg.values;
  const sessionId = exec?.agent?.id;
  const guarded = summonGuardHit(sessionId);

  let decided = null;
  let payloadRef = null;

  if (exec.name === "write" || exec.name === "edit") {
    const built = buildWritePayload(exec.name, exec.arguments);
    if (built) {
      payloadRef = built;
      // 召唤中：只有卡片记忆层放行且走完整规则；其余记忆层一律 deny + 给定向。
      if (guarded && built.target.kind !== "card") {
        const isCast = String(guarded.hit?.fullPath ?? "").includes(",");
        const cardHint = guarded.card && values?.cardsEnabled !== false
          ? `本卡的剧情/世界事实只写卡片记忆：\`${guarded.card.path}\`（条目格式 - [YYYY-MM-DD] 事实）。`
          : isCast
            ? "本会话是多卡阵容（cast），没有单卡记忆路径，请不要写长期记忆。"
            : "本会话的卡片记忆层已关闭：没有任何可写记忆路径，请不要写长期记忆。";
        decided = {
          decision: "deny",
          reason:
            `dsh-memory write-guard：本会话处于角色卡召唤（${String(guarded.hit?.name ?? "卡片")}），` +
            `长期记忆（全局 topics/ · 项目层 · 规则文件）已屏蔽 —— 剧情事实留在这里会污染后续所有会话。${cardHint}`,
        };
      } else {
        // 卡片层 / 非召唤：走原有规则引擎。放行卡片层前确保目录存在（native write 不建父目录）。
        if (!guarded && built.target.kind === "card") mkdirSync(CARDS_DIR, { recursive: true });
        decided = runWriteRules({ ...built.payload, target: built.target });
        if (cfg.guard === "full" && cfg.command) {
          const ext = await runCommandHook(cfg.command, built.payload, cfg.timeoutMs);
          decided = mergeDecisions(decided, ext);
        }
      }
    }
  } else if (exec.name === "bash" && bashTouchesMemory(exec.arguments?.command)) {
    if (guarded) {
      // 召唤中 bash 写记忆：目标全在卡片记忆目录里才放行；否则不给 ask（没人守屏幕，
      // 配合「屏蔽」也要拦 shell 绕行）——直接 deny 并给卡片路径。
      if (bashTargetCardOnly(exec.arguments?.command)) {
        mkdirSync(CARDS_DIR, { recursive: true });
      } else {
        decided = {
          decision: "deny",
          reason:
            "dsh-memory write-guard：本会话处于角色卡召唤，shell 不允许写记忆（全局/项目/规则层已屏蔽，" +
            "卡片记忆也只能用 write/edit 工具走完整规则）。",
        };
      }
    } else {
      // 非召唤：直接放行（2026-10-23 用户决定：不要「转人工确认」）。
      // 但放行 ≠ 免检：命令文本里的凭据字面量（echo sk-xxx >> 记忆）在这里
      // 落盘前 deny —— 与 write/edit 的凭据红线同一条。只报 pattern 名，
      // 不回显命中值。范围受外层 bashTouchesMemory 限定：只有真的写向记忆
      // 路径的命令才会进到这里，写 /tmp 等无关目标不受影响。
      // 已知边界（刻意不做）：命令经变量/heredoc/脚本解释器间接写凭据时
      // 文本里看不见，post-execute 落盘校验未实现（并发/CRLF/无基线快照的
      // 复杂度收益比不划算）；writeGuard=off 可整体停用本钩子。
      const secretHits = scanSecrets(normalizeCommandText(exec.arguments?.command));
      if (secretHits.length > 0) {
        const listed = [...new Set(secretHits.map((s) => s.pattern))].slice(0, 4).join("；");
        decided = {
          decision: "deny",
          reason:
            `dsh-memory write-guard：这条 shell 命令疑似包含凭据（${listed}），禁止写进记忆 —— 记忆会随每次请求注入并离开本机。` +
            "把值写进普通文件或环境变量，记忆里只允许写「凭据存放在哪里」这类指针。",
        };
      }
      // 审计里记一条 allow，路径可追溯。
      auditLog({
        event: "pre-execute",
        tool: "bash",
        decision: "allow",
        notes: ["shell 写记忆放行（write-guard bash-ask 已按用户要求停用）"],
      });
    }
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
        const text = readOrEmpty(normalizeToolPath(exec.arguments.file_path));
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

/**
 * 各注入模式的**开场两条**纪律（检索方式随档位变，其余条共用）。
 *
 * 地图模式（默认）下条目标题不在提示词里，所以第一条必须给出确定动作（先调 memory_search），
 * 否则会退化成「没线索就不读」—— 那个失败模式在 2026-09-28 的索引预算事故里已经见过一次。
 */
const DISCIPLINE_HEAD = {
  map: [
    "     · 【开工先查】非琐碎任务开头先取线索：拿任务里的关键词（框架 / 工具 / 文件名 / 报错码 / 用户原话里的名词）先调 `memory_search` 查记忆；命中条目 / 行号再动手，没命中就不读，别整库通读。只有 `memory_search` 无命中、或要精确正则 / 按路径限定范围 / 回读已知文件时，才用 `grep` / `read` 直查记忆目录 —— 全局为 `~/.dsh/memory/topics`，项目层路径见下面各片段。（片段里**已经逐条内联**的层不用再检索：直接按行号 `read` 即可；标着「地图模式」的层才需要先查）",
    "     · 【读法】`memory_search` 命中行自带行号 → `read path=<片路径> offset=<行号> limit=<要几条>`；片名与关键词只说明主题、不保证内容，禁止凭片名臆测",
  ],
  index: [
    "     · 【开工先查】非琐碎任务开头先扫上面的索引：拿任务里的关键词（框架 / 工具 / 文件名 / 报错码 / 用户原话里的名词）先调 `memory_search` 查记忆；命中就 `read` 该片对应行号再动手；没命中就不读，别整库通读。只有无命中 / 要精确正则 / 已知路径时，才直接按片名与「关键词」行定位后 `grep` / `read`",
    "     · 【读法】按行号精确 read（offset = 条目行号），禁止凭片名或标题臆测内容；某片只列了最新几条时，按提示的行号区间读更早的条目",
  ],
  full: [
    "     · 【正文已在提示词里】本层记忆已整篇注入，直接用即可，不必再 read 同一份文件；只有片级统计提到而正文没展开的部分才需要读",
  ],
};

/** 与注入模式无关的通用纪律。 */
const DISCIPLINE_TAIL = [
  "     · 【检索分级】1–2 条由主代理自己读；要同时读 ≥3 条 / 跨 ≥2 片 / 某片正文 ≥3k 字符时 → 派**检索子代理**：工具表里有 `subagent_memory` 就用它（固定低档思考强度、工具面只留 read/grep/glob，返回更快），没有就退回 `subagent`。只让它回「与任务相关的事实 + 所在文件与行号」，不要把整片原文带回主对话（原文留在它的上下文里）",
  "     · 【写入判据】值得记：可复用的结论、用户偏好、坑与成因；不值得记：过程叙述、能从仓库或 git 推导的内容、一次性中间状态",
  "     · 条目格式 `- [YYYY-MM-DD] 事实`；全局层写 ~/.dsh/memory/topics/ 分片（**新片首行写 `<!-- 片名 · 关键词… -->`**，关键词会进索引供路由），项目层写对应文件并登记 MEMORY.md；某片出现 ⚠️超建议 时按子主题就地拆片",
  "     · 同一事实有了新结论就**就地改写那一行**（不追加第二条、不写「已改为」的变迁史）；发现过时条目就地修正",
  "     · 写入动作由钩子校验：格式错/含凭据/覆盖历史 → 直接拒绝（deny，原因会回到你面前）；shell 写记忆不转人工，凭据字面量同样落盘前 deny",
];

/**
 * 按注入模式取纪律块。
 * @param {string} mode - `map` / `index` / `full`（未知值按 `index` 处理）。
 * @returns {string} 纪律块正文。
 */
function disciplineBlock(mode) {
  const head = DISCIPLINE_HEAD[mode] ?? DISCIPLINE_HEAD.index;
  return ["<!-- 记忆纪律（dsh-memory 钩子强制执行，不只是建议）：", ...head, ...DISCIPLINE_TAIL, " -->"].join("\n");
}

/** 注入层强制附加的记忆纪律块（索引档文本；其它档位由 [disciplineBlock] 现取）。 */
const DISCIPLINE_BLOCK = disciplineBlock("index");

/**
 * 对注入文本应用可选的外部过滤命令（同步；compose 的 text 是同步求值）。
 * @param {string} text - 组装后的注入正文。
 * @returns {string} 过滤结果；失败/空输出回落原文。
 */
function applyInjectFilter(text) {
  const cmd = readSettings().injectHookCommand;
  if (typeof cmd !== "string" || cmd.length === 0) return text;
  try {
    const shell = shellInvocation(cmd);
    const r = spawnSync(shell.file, shell.args, {
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

// ── 卡片记忆层路由：列表 + 按卡清除（设置面板 / dsh-card-summon 召唤面板共用）──

/**
 * `GET /dsh-memory/cards`：列卡片记忆分片（只读）。
 * 头部注释里带展示名与 fullPath（写入说明块里有，模型按格式写时一并带上）；
 * 解析不出就用 slug 兜底。响应：`{ok, cards:[{slug,name,fullPath,size,entries,updatedAt}]}`
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<void>}
 */
async function handleCardList(req, res) {
  if (String(req.method ?? "GET").toUpperCase() !== "GET") {
    return sendJson(res, 405, { ok: false, error: "use GET" });
  }
  let names = [];
  try {
    if (existsSync(CARDS_DIR)) names = readdirSync(CARDS_DIR).filter((n) => n.endsWith(".md"));
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
  const cards = names.map((file) => {
    const slug = file.slice(0, -3);
    const path = `${CARDS_DIR}/${file}`;
    let size = 0;
    let updatedAt = null;
    let entries = 0;
    let name = slug;
    let fullPath = "";
    try {
      const text = readFileSync(path, "utf8");
      size = text.length;
      entries = extractEntries(text).length;
      updatedAt = statSync(path).mtime.toISOString();
      const head = /<!--\s*卡片记忆\s*·\s*([^·]*)·\s*(.*?)\s*-->/.exec(text.slice(0, 400));
      if (head) {
        name = head[1].trim() || slug;
        fullPath = head[2].trim();
      }
    } catch {
      // 读失败的单卡保持默认值，别让一张坏文件拖垮列表。
    }
    return { slug, name, fullPath, size, entries, updatedAt };
  });
  return sendJson(res, 200, { ok: true, cards });
}

/**
 * `POST /dsh-memory/cards/delete`：按 slug 清除一张卡的卡片记忆。需要 `x-dsh-memory: 1` 头。
 * 安全边界（照 dsh-temp-chat 的删除纪律）：slug 白名单正则 → 拼出目标路径 → resolve 必须
 * 以 CARDS_DIR 为前缀 → lstat 拒 symlink → 删除前把全文记进 audit.log（唯一回滚点）→ rm。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<void>}
 */
async function handleCardDelete(req, res) {
  if (String(req.headers?.["x-dsh-memory"] ?? "") !== "1") {
    return sendJson(res, 403, { ok: false, error: "missing x-dsh-memory header" });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
  }
  const path = cardMemoryPathOf(payload?.slug);
  if (!path) return sendJson(res, 400, { ok: false, error: "bad slug" });

  // resolve 后必须仍在 CARDS_DIR 内 —— slug 正则已挡 ../，这里是第二道防线。
  // Windows 的 resolve() 返回反斜杠，先归一化再比较，否则每次删除都会被误判成越界。
  const resolved = normalizePathText(resolve(path));
  if (!isUnderPath(resolved, normalizePathText(CARDS_DIR))) {
    return sendJson(res, 403, { ok: false, error: "path escapes cards dir" });
  }
  if (!existsSync(resolved)) return sendJson(res, 404, { ok: false, error: "no such card memory" });
  try {
    // symlink / 非常规文件拒绝 —— 只删真正的普通 .md 文件。
    const st = lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile()) {
      return sendJson(res, 403, { ok: false, error: "not a regular file" });
    }
    // 回滚点：全文进审计（手动拷回即恢复）。
    auditLog({ event: "card-memory-delete", path: resolved, oldText: readOrEmpty(resolved).slice(0, MAX_WRITE_BYTES) });
    rmSync(resolved);
    return sendJson(res, 200, { ok: true, slug: payload.slug });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
}


// ── 回合记忆活动投影（v0.8，借鉴 dsh-mnemon 的 TurnActivityProjection）────────
// 数据源是 session 持久日志（agent.session.snapshotEvents()），请求时增量消费——
// 不挂事件监听、不需要 per-agent 安装，对插件激活前就存在的会话同样生效。
// 识别 read/grep/glob/write/edit/bash 中命中记忆管辖路径的调用，按 (sessionId, turn) 聚合。

/** 每会话保留的回合数上限（环形裁剪最旧 turn）。 */
const ACTIVITY_TURN_KEEP = 50;
/** sessionId → {eventCount, lastEventSeq, byTurn: Map<turn, activity>, pending: Map<callId, call>} */
const activityStates = new Map();

/**
 * 判定一次工具调用是否触及记忆管辖路径。
 * @param {string} name - 工具名。
 * @param {object} args - 已解析的调用参数。
 * @returns {{path:string,kind:string,layer:string,offset?:number}|null} 命中信息；null = 与记忆无关。
 */
function toolMemoryHit(name, args) {
  if (!args || typeof args !== "object") return null;
  // 自家检索工具：无单一文件 path，整轮记一条「记忆检索」（活动栏可见，不进文件明细）。
  // layer 现阶段记忆根只有全局/项目两层由检索结果各自携带，活动条目统一记 global 层。
  if (name === "memory_search") {
    return { path: `${HOME}/.dsh/memory`, kind: "search", layer: "global", label: "记忆检索" };
  }
  if (name === "read" || name === "write" || name === "edit") {
    const hit = memoryTargetOf(args.file_path);
    if (!hit || hit.kind === "plugin-internal" || hit.kind === "other") return null;
    return {
      path: args.file_path,
      kind: hit.kind,
      layer: hit.layer,
      ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
    };
  }
  if (name === "grep" || name === "glob") {
    // grep/glob 的 path 常常是目录（如 …/topics）——memoryTargetOf 会归为 "other"，
    // 对这两个工具它是合法且最常见的形态，放行；只挡 plugin-internal（audit.log/.bak）。
    const hit = memoryTargetOf(args.path);
    if (!hit || hit.kind === "plugin-internal") return null;
    return { path: args.path, kind: hit.kind === "other" ? "topics-dir" : hit.kind, layer: hit.layer };
  }
  if (name === "bash" && typeof args.command === "string" && mentionsMemoryPath(args.command)) {
    return { path: `${HOME}/.dsh/memory`, kind: "other", layer: "global" };
  }
  return null;
}

/** 文件路径 → 展示名（点击打开用的短标签）。 */
function activityLabel(path) {
  const base = String(path ?? "").split("/").pop() ?? "";
  return base.replace(/\.md$/, "") || base;
}

/** 单个事件消费：tool/call 记 pending，tool/result 落账（失败不计入 reads/writes）。 */
function consumeActivityEvent(state, event) {
  if (event.type === "tool/call") {
    const data = event.data ?? {};
    const { turn, callId, name } = data;
    if (typeof turn !== "number" || typeof callId !== "string" || typeof name !== "string") return;
    let args = data.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = undefined;
      }
    }
    const hit = toolMemoryHit(name, args);
    if (hit) state.pending.set(callId, { turn, name, hit });
    return;
  }
  if (event.type !== "tool/result") return;
  const callId = event.data?.message?.source?.callId;
  if (typeof callId !== "string") return;
  const call = state.pending.get(callId);
  if (call === undefined) return;
  state.pending.delete(callId);
  if (event.data.error !== undefined) return; // deny/失败不计入活动
  let activity = state.byTurn.get(call.turn);
  if (activity === undefined) {
    activity = { turn: call.turn, reads: [], writes: [] };
    state.byTurn.set(call.turn, activity);
  }
  const entry = {
    tool: call.name,
    path: call.hit.path,
    // label 覆盖仅限 memory_search 分支（hit.label 只在那儿有），其余路径走文件名推导
    label: call.hit.label ?? activityLabel(call.hit.path),
    kind: call.hit.kind,
    layer: call.hit.layer,
    ...(call.hit.offset !== undefined ? { offset: call.hit.offset } : {}),
  };
  (call.name === "write" || call.name === "edit" ? activity.writes : activity.reads).push(entry);
}

/**
 * 增量投影某会话的记忆活动（照 mnemon 的游标语义：事件变短或尾 seq 变化即 reset）。
 * @param {string} sessionId - 会话 ID。
 * @param {{snapshotEvents:Function}} session - 会话对象（宿主 agent.session）。
 * @returns {Map<number,{turn:number,reads:object[],writes:object[]}>} turn → 活动。
 */
function projectMemoryActivity(sessionId, session) {
  let state = activityStates.get(sessionId);
  if (state === undefined) {
    state = { eventCount: 0, lastEventSeq: undefined, byTurn: new Map(), pending: new Map() };
    activityStates.set(sessionId, state);
  }
  const events = session.snapshotEvents();
  const lastSeq = events.at(-1)?.seq;
  if (events.length < state.eventCount || (events.length === state.eventCount && state.lastEventSeq !== lastSeq)) {
    state.eventCount = 0;
    state.lastEventSeq = undefined;
    state.byTurn.clear();
    state.pending.clear();
  }
  for (let i = state.eventCount; i < events.length; i++) consumeActivityEvent(state, events[i]);
  state.eventCount = events.length;
  state.lastEventSeq = typeof lastSeq === "number" ? lastSeq : undefined;
  if (state.byTurn.size > ACTIVITY_TURN_KEEP) {
    const turns = [...state.byTurn.keys()].sort((a, b) => a - b);
    for (const t of turns.slice(0, state.byTurn.size - ACTIVITY_TURN_KEEP)) state.byTurn.delete(t);
  }
  return state.byTurn;
}

/**
 * `GET /dsh-memory/activity?sessionId=…&turn=N`：某会话某回合的记忆活动。
 * turn 缺省时返回该会话全部已投影回合（调试用）。
 */
function handleActivity(req, res, url) {
  const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
  const turnParam = String(url.searchParams.get("turn") ?? "").trim();
  const turn = /^\d+$/.test(turnParam) ? Number(turnParam) : null;
  const agent = sessionId !== "" && HOST_CTX?.agents ? HOST_CTX.agents.get(sessionId) : undefined;
  if (!agent?.session) return sendJson(res, 200, { ok: true, activity: null });
  const byTurn = projectMemoryActivity(sessionId, agent.session);
  if (turn === null) {
    return sendJson(res, 200, { ok: true, activities: [...byTurn.values()] });
  }
  return sendJson(res, 200, { ok: true, activity: byTurn.get(turn) ?? null });
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
    if (url.pathname === "/dsh-memory/activity") return handleActivity(req, res, url);
    if (url.pathname === "/dsh-memory/cards") return handleCardList(req, res);
    if (url.pathname === "/dsh-memory/cards/delete") {
      if (method !== "POST") return sendJson(res, 405, { ok: false, error: "use POST" });
      return await handleCardDelete(req, res);
    }
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
  // 路由侧要按 sessionId 取 agent.session —— 存模块级引用（handleActivity 用）。
  // agents 服务同样经软注入拿【回调参数视图】（deepseek-account 的 scope.agents 同款）；
  // 外层 ctx 上 agents 可能不可见。视图同时保留 effect/on 等能力（回调整个 ctx 传形）。
  ctx.inject(["agents"], (agentsCtx) => {
    HOST_CTX = agentsCtx;
  });
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "dsh-memory:long-term",
        order: 9500, // 靠后（DELIVERABLE_FILE_REFERENCES 9000 与 STRUCTURED_OUTPUT 9900 之间的空档）：记忆段是函数式注入，写一条记忆就使该段之后的前缀缓存全部作废——位置越靠后，缓存失效面越小（原 order 1 时失效面=整个系统提示词+全部消息历史）；「开工先查」的注意力由 AGENTS.md 与注入块尾部的纪律注释兜底
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

  // memory_search 工具：词法检索长期记忆（中文 bigram + 加权排序 + 覆盖度门槛）。
  // 服务挂【注入回调的参数】上，不是外层 ctx —— 宿主通行模式（agent-default-model 的
  // child.settings、agent-tool-presentation 的 runtimeCtx.tools 都从回调参数取）；
  // 用外层 ctx.tools 在真实宿主是 undefined，注册静默失败（v0.8 首发实测踩的坑）。
  // tools 服务缺席（老宿主）时软注入直接跳过，不影响其余功能。
  ctx.inject(["tools"], (toolCtx) => {
    ctx.effect(
      () =>
        toolCtx.tools.register({
          name: "memory_search",
          description:
            "按相关度检索长期记忆（全局分片 + 项目记忆），返回条目及其文件行号。" +
            "任务开工找线索、找以前记过的事，先调它；无命中、或要精确正则 / 按路径限定 / 回读已知文件时，再用 grep/read。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "检索词（中文/英文/混合，越具体越好）" },
              limit: { type: "integer", description: "返回条数上限，默认 8，最大 20" },
              scope: {
                type: "string",
                enum: ["current", "all"],
                description:
                  "检索范围：current（默认）= 全局分片 + 当前项目记忆；all = 连其它项目的记忆一起搜（跨项目排查、找「好像在别的仓库记过」时用）",
              },
            },
            required: ["query"],
          },
          output: {
            schema: { type: "object", additionalProperties: true },
            render: (_args, value) => [{ type: "text", text: formatSearchResults(value) }],
          },
          // exec.agent 是宿主契约（packages/core/tools/src/index.ts:340「The agent on whose
          // behalf the call runs」，可选字段）；cwd 走 compose() 同一条链
          // （agent.session.header.cwd，packages/core/session/src/types.ts:106）。
          // 任一环取不到 → cwd 为空串 → searchMemory 自动退回全库，绝不静默少给。
          execute: async (args, exec) => {
            const limit = Number.isFinite(args?.limit) ? args.limit : undefined;
            const cwd = exec?.agent?.session?.header?.cwd;
            return searchMemory(String(args?.query ?? ""), {
              limit,
              scope: args?.scope === "all" ? "all" : undefined,
              cwd: typeof cwd === "string" ? cwd : "",
            });
          },
        }),
      "dsh-memory: memory_search tool",
    );
  });
}
