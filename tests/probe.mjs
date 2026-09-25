/**
 * dsh-memory probe：验证 host 半（两层注入 + 开关 + 内容/写入路由）与 client 半（设置面板的
 * 查看→编辑→保存）。完全自包含 —— 在临时 HOME 里造记忆文件，不依赖任何真实项目数据。
 * 无需浏览器 / 网络 / API Key。
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 造一个隔离的 HOME（必须在 import 插件之前：插件的路径常量在模块加载时求值）──────
const HOME = mkdtempSync(join(tmpdir(), "dsh-memory-probe-"));
process.env.HOME = HOME;

const SLUG = "--Users-probe-code-demo--";
const SINGLE_SLUG = "--Users-probe-code-single--";
const GLOBAL_TEXT = "# Global memory\n- [2026-01-01] probe global fact\n";
const INDEX_TEXT = "- [Demo topic](demo-topic.md) — probe project index entry\n";
const AGENTS_TEXT = "# global rules\n- probe rule\n";

mkdirSync(join(HOME, ".dsh/memory/projects", SLUG), { recursive: true });
writeFileSync(join(HOME, ".dsh/memory.md"), GLOBAL_TEXT, { mode: 0o644 });
writeFileSync(join(HOME, ".dsh/AGENTS.md"), AGENTS_TEXT);
writeFileSync(join(HOME, ".dsh/memory/projects", SLUG, "MEMORY.md"), INDEX_TEXT);
writeFileSync(join(HOME, ".dsh/memory/projects", SLUG, "demo-topic.md"), "# demo topic body\n");

const results = [];
const check = (ok, label) => results.push({ ok, label });

// ── 环境替身 ────────────────────────────────────────────────────────────────
const styleTags = [];
globalThis.document = {
  head: { appendChild: (el) => styleTags.push(el) },
  createElement: () => ({ id: "", textContent: "", dataset: {} }),
  getElementById: () => null,
};

function makeReact() {
  const hooks = new Map();
  let cursor = 0;
  let mountedOnce = false; // useEffect(deps=[]) 的挂载语义：只在首次执行
  return {
    createElement: (type, props, ...children) => ({
      __el: true, type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    }),
    Fragment: "Fragment",
    useState: (init) => {
      const k = cursor++;
      if (!hooks.has(k)) hooks.set(k, typeof init === "function" ? init() : init);
      return [hooks.get(k), (v) => hooks.set(k, typeof v === "function" ? v(hooks.get(k)) : v)];
    },
    useRef: (init) => ({ current: init }),
    // 面板挂载时拉一次 /dsh-memory/settings：真实 React 里 deps=[] 只在挂载跑，probe 同样只跑首次
    useEffect: (fn) => {
      if (mountedOnce) return;
      mountedOnce = true;
      try { fn(); } catch { /* noop */ }
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (sub, get) => { try { sub(() => {}); } catch { /* noop */ } return get(); },
    // 测试专用：每次「渲染」前把 hook 游标归零（真实 React 每渲染一次就重置顺序）
    __reset: () => { cursor = 0; },
  };
}

function resolve(el, depth = 0) {
  if (!el || typeof el !== "object" || !el.__el || depth > 14) return el;
  const out = typeof el.type === "function" ? resolve(el.type(el.props), depth + 1) : el;
  if (Array.isArray(out.children)) out.children = out.children.map((c) => resolve(c, depth + 1)).filter(Boolean);
  return out;
}

function collect(node, pred, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (pred(node)) acc.push(node);
  for (const c of node.children ?? []) collect(c, pred, acc);
  return acc;
}

const textOf = (el) => (el?.children ?? []).filter((c) => typeof c === "string").join("");
const hasClass = (name) => (n) => String(n.props?.className ?? "").split(" ").includes(name);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ══ host 半 ═════════════════════════════════════════════════════════════════
const host = await import("../index.js");
const sections = [];
const routes = [];
const mountedHooks = {};
const store = new Proxy(
  {
    globalEnabled: true,
    projectEnabled: {},
    injectMode: "index",
    maxChars: 24000,
    writeGuard: "rules",
    writeHookCommand: "",
    hookTimeoutMs: 10000,
    readReminder: true,
    discipline: true,
    injectHookCommand: "",
    audit: true,
  },
  {
    // 开关注落在 ~/.dsh/memory/settings.json；host 每次现读 → 复制真实语义
    set(target, key, value) {
      target[key] = value;
      writeFileSync(join(HOME, ".dsh/memory/settings.json"), `${JSON.stringify(target)}\n`);
      return true;
    },
  },
);
writeFileSync(join(HOME, ".dsh/memory/settings.json"), `${JSON.stringify(store)}\n`);
host.apply({
  effect: (fn) => fn(),
  on: (event, handler) => { mountedHooks[event] = handler; return () => {}; },
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  inject: (deps, cb) => {
    if (deps.includes("webServer")) cb({ webServer: { register: (r) => { routes.push(r); return () => {}; } } });
  },
});

const compose = sections[0].text;
const at = (cwd) => compose({ agent: { session: { header: { cwd } } } });
const CWD = "/Users/probe/code/demo";

check(sections[0].name === "dsh-memory:long-term", `host: 段名 dsh-memory:long-term (order ${sections[0].order})`);
check(typeof sections[0].text === "function", "host: text 是函数 → 每次组装重读（写完即生效）");
check(at(CWD).includes("Global memory"), "host: 全局层注入");
check(at(CWD).includes("probe project index entry"), "host: 项目层索引注入");
check(at(CWD).includes("索引模式") && at(CWD).includes("read path="), "host: 注入索引并给出读取指引（渐进式）");
check(at(CWD).includes(SLUG), `host: 由 cwd 推出的 slug 正确 (${SLUG})`);
check(host.knownProjects().includes(SLUG), "host: knownProjects 扫盘（面板列项目用）");
check(compose({}).includes("Global memory") && !compose({}).includes("probe project index entry"), "host: 无 agent 时只注入全局层");

store.globalEnabled = false;
check(!at(CWD).includes("Global memory"), "host: 关闭全局层后不注入");
store.globalEnabled = true;
store.projectEnabled = { [SLUG]: false };
check(!at(CWD).includes("probe project index entry") && at(CWD).includes("Global memory"), "host: 关闭该项目后该项目不注入、全局层不受影响");
store.projectEnabled = {};
check(at(CWD).includes("probe project index entry"), "host: 重新开启后立即重新读取");

writeFileSync(join(HOME, ".dsh/memory/projects", SLUG, "MEMORY.md"), "- Homebrew template uses {{staged_path}} as a cask placeholder\n");
const neutralized = at(CWD);
check(!neutralized.includes("{{staged_path}}"), "host: 注入前拆开 {{，避免 dsh-system-prompt 当未知变量抛错");
check(neutralized.includes("{ {staged_path}}"), "host: 拆开后仍能读出 staged_path 占位");
writeFileSync(join(HOME, ".dsh/memory/projects", SLUG, "MEMORY.md"), INDEX_TEXT);

// ── 渐进式注入：索引模式（片名 / 行号 / 分片优先 / full 回退 / 溢出索引）──────
check(at(CWD).includes("索引模式") && at(CWD).includes("read path="), "index: 注入的是索引并给出读取指引");
check(at(CWD).includes("- [L2] probe global fact"), "index: 条目带全文行号（read offset 可直接定位）");
check(at(CWD).includes("Global memory (1 条"), "index: 单文件模式的片名取文件 H1");

const TOPICS = join(HOME, ".dsh/memory/topics");
mkdirSync(TOPICS, { recursive: true });
writeFileSync(join(TOPICS, "probe-shard.md"), "# 探针分片\n\n- [2026-02-02] shard entry alpha\n");
const sharded = at(CWD);
check(sharded.includes("## 探针分片 (1 条"), "index: 分片片名取该文件 H1");
check(sharded.includes("probe-shard.md"), "index: 片路径写进索引");
check(sharded.includes("shard entry alpha"), "index: 片内条目以标题行出现");
check(!sharded.includes("probe global fact"), "index: 分片目录存在时不再回落读单文件 memory.md");

store.injectMode = "full";
check(at(CWD).includes("probe global fact") && !at(CWD).includes("探针分片"), "full: injectMode=full 时回到全文注入");
store.injectMode = "index";

store.maxChars = 20;
store.injectMode = "full";
const clamped = at(CWD);
check(clamped.includes("未全量注入") && /read path="[^"]+"/.test(clamped), "clamp: 超预算时给带行号的溢出索引而非静默截断");
store.maxChars = 24000;
store.injectMode = "index";

rmSync(join(TOPICS, "probe-shard.md"));
check(!at(CWD).includes("探针分片"), "index: 分片删掉后回落单文件（两种形态都工作）");

// ── 项目层（目录形式）：注入人写索引，只额外列**未被登记**的正文 ──────────────
const projDir = join(HOME, ".dsh/memory/projects", SLUG);
check(at(CWD).includes("probe project index entry"), "project: 目录形式注入 MEMORY.md 的索引正文（含摘要）");
check(at(CWD).includes("索引 (MEMORY.md)"), "project: 明确标注这是人写索引");
check(!at(CWD).includes("demo-topic.md ("), "project: 已登记的主题文件不重复列进清单");
check(!at(CWD).includes("（0 条"), "project: 不会把正文按条目索引（旧实现退化成路径清单）");

writeFileSync(join(projDir, "orphan-topic.md"), "# orphan\n\n没被索引登记\n");
check(at(CWD).includes("未被索引登记的正文"), "project: 未登记的正文有独立分组");
check(/\n- orphan-topic\.md \(/.test(at(CWD)), "project: 孤儿正文连同体量一起列出");

writeFileSync(join(projDir, "MEMORY.md"), `${INDEX_TEXT}- [Orphan](orphan-topic.md) — 补登记\n`);
check(!at(CWD).includes("未被索引登记的正文"), "project: 补登记进 MEMORY.md 后不再算孤儿");
rmSync(join(projDir, "orphan-topic.md"));
writeFileSync(join(projDir, "MEMORY.md"), INDEX_TEXT);

// ── 路由脚手架 ──────────────────────────────────────────────────────────────
check(routes.length === 1 && routes[0].path === "/dsh-memory", "host: 注册内容/写入路由 /dsh-memory");
// 用 dsh-host-webserver 的真实 match() 语义校验：pathname === prefix || startsWith(prefix + "/")
// （这条断言就是为了防住"注册路径多带一个尾斜杠导致永远匹配不上"那类 bug）
const routePath = routes[0].path;
const wouldMatch = (pathname) => pathname === routePath || pathname.startsWith(`${routePath}/`);
check(wouldMatch("/dsh-memory/content"), "route: 能被 /dsh-memory/content 命中（DSH match 语义）");
check(!wouldMatch("/dsh-memory-extra/content"), "route: 不会误命中 /dsh-memory-extra");

function makeReq({ url = "/", method = "GET", headers = {}, body = "" } = {}) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    url, method, headers,
    on(event, fn) { (listeners[event] ??= []).push(fn); return req; },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== "") for (const fn of listeners.data) fn(Buffer.from(body));
    for (const fn of listeners.end) fn();
  });
  return req;
}

async function callRoute(url, options = {}) {
  const res = {
    code: 0, headers: null, body: "",
    writeHead(code, headers) { res.code = code; res.headers = headers ?? null; },
    end(text) { res.body = text ?? ""; },
  };
  await routes[0].handler(makeReq({ url, ...options }), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = null; }
  return { code: res.code, headers: res.headers, body: res.body, json };
}

const readTarget = async (target, file) => {
  const query = `/dsh-memory/content?target=${encodeURIComponent(target)}` + (file ? `&file=${encodeURIComponent(file)}` : "");
  return callRoute(query);
};
const writeTarget = (target, file, text, headers = { "x-dsh-memory": "1" }) =>
  callRoute("/dsh-memory/write", {
    method: "POST",
    headers,
    body: JSON.stringify({ target, file, text }),
  });

// ── 读路由 ──────────────────────────────────────────────────────────────────
const g = await readTarget("global");
check(g.code === 200 && g.json?.ok === true && g.json.files[0].name === "memory.md" && g.json.files[0].text.includes("probe global fact"), "route: 全局正文可读（JSON）");
check(g.json?.files[0].injected === true && g.json.files[0].exists === true, "route: 全局层标记 injected/exists");

const textForm = await callRoute("/dsh-memory/content?target=global&format=text");
check(textForm.code === 200 && textForm.body.includes("probe global fact"), "route: format=text 仍可拿到纯文本");

const p = await readTarget(SLUG);
check(p.code === 200 && p.json.files.some((f) => f.name === "MEMORY.md" && f.text.includes("probe project index entry")), "route: 项目 MEMORY.md 可读");
check(p.json.files.some((f) => f.name === "demo-topic.md" && f.injected === false), "route: 项目主题文件一并列出（injected=false）");
check(p.json.files[0].name === "MEMORY.md", "route: MEMORY.md 排在第一（编辑入口）");

const rules = await readTarget("rules");
check(rules.code === 200 && rules.json.files.length === 1, "route: 规则层只列 AGENTS.md 一个文件");
check(rules.json.files[0].name === "AGENTS.md" && rules.json.files[0].text.includes("probe rule"), "route: AGENTS.md 可读且是唯一入口");

writeFileSync(join(HOME, ".dsh/memory/projects", `${SINGLE_SLUG}.md`), "- single-file form\n");
const single = await readTarget(SINGLE_SLUG);
check(single.code === 200 && single.json.files[0].text.includes("single-file form"), "route: 单文件形式的项目记忆也可读");

// ── 路径白名单 ──────────────────────────────────────────────────────────────
check((await readTarget("../../etc/passwd")).code === 400, "guard: 路径穿越被拒（400）");
check((await readTarget("--a/../../b--")).code === 400, "guard: 含斜杠的 slug 被拒（400）");
check((await readTarget("rules", "../settings.yaml")).code === 400, "guard: 规则层的非法文件名被拒（400）");
check((await readTarget("rules", "system-role.md")).code === 400, "guard: 规则层不再接受 system-role.md（400）");
check((await readTarget(SLUG, "nope.md")).code === 400, "guard: 层内不存在的文件被拒（400）");
check((await readTarget(SLUG, "../MEMORY.md")).code === 400, "guard: 带分隔符的文件名被拒（400）");
check((await callRoute("/dsh-memory/other")).code === 404, "guard: 未知路径 404");
check((await callRoute("/dsh-memory/write")).code === 405, "guard: GET /dsh-memory/write → 405");

// ── 写路由 ──────────────────────────────────────────────────────────────────
const w1 = await writeTarget("global", "memory.md", "# Global memory\n- [2026-01-01] edited from panel\n");
check(w1.code === 200 && w1.json.ok === true && w1.json.changed === true, "write: 全局记忆写成功（200 changed）");
check(readFileSync(join(HOME, ".dsh/memory.md"), "utf8").includes("edited from panel"), "write: 内容真的落盘");
check(existsSync(join(HOME, ".dsh/memory.md.bak")) && readFileSync(join(HOME, ".dsh/memory.md.bak"), "utf8").includes("probe global fact"), "write: 旧版本自动留 .bak 回滚点");
check((statSync(join(HOME, ".dsh/memory.md")).mode & 0o777) === 0o644, "write: 权限沿用原文件（0644，不被改成 0600）");
check(!readdirSync(join(HOME, ".dsh")).some((n) => n.includes(".tmp-")), "write: 不留临时文件（原子写）");

const w2 = await writeTarget("global", "memory.md", "# Global memory\n- [2026-01-01] edited from panel\n");
check(w2.code === 200 && w2.json.changed === false, "write: 内容未变时不重复写（changed=false）");

const w3 = await writeTarget(SLUG, "demo-topic.md", "# demo topic body\n- panel edit\n");
check(w3.code === 200 && readFileSync(join(HOME, ".dsh/memory/projects", SLUG, "demo-topic.md"), "utf8").includes("panel edit"), "write: 项目主题文件可写");
const w4 = await writeTarget(SLUG, "NEW.md", "x");
check(w4.code === 400, "write: 项目层不允许凭空新建任意文件（400）");

const FRESH_SLUG = "--Users-probe-code-fresh--";
mkdirSync(join(HOME, ".dsh/memory/projects", FRESH_SLUG), { recursive: true });
const w5 = await writeTarget(FRESH_SLUG, "MEMORY.md", "# fresh index\n");
check(w5.code === 200 && (statSync(join(HOME, ".dsh/memory/projects", FRESH_SLUG, "MEMORY.md")).mode & 0o777) === 0o600, "write: 首次为项目建 MEMORY.md 用 0600");
const w6 = await writeTarget("rules", "AGENTS.md", "# global rules\n- probe rule\n- panel edit\n");
check(w6.code === 200 && readFileSync(join(HOME, ".dsh/AGENTS.md"), "utf8").includes("panel edit"), "write: AGENTS.md 可写");

const w7 = await writeTarget("rules", "settings.yaml", "hacked: true\n");
check(w7.code === 400 && !existsSync(join(HOME, ".dsh/settings.yaml")), "write: 白名单外的文件写不进去（400 且未落盘）");

// ── 设置路由（面板唯一的开关通道）──────────────────────────────────────────
const settingsRead = await callRoute("/dsh-memory/settings");
check(settingsRead.code === 200 && settingsRead.json?.ok === true, "settings: GET 返回 ok");
check(settingsRead.json?.value?.injectMode === "index" && settingsRead.json?.value?.writeGuard === "rules", "settings: GET 返回归一化后的开关");
check(Array.isArray(settingsRead.json?.projects) && settingsRead.json.projects.includes(SLUG), "settings: GET 带上已知项目（扫盘）");

const settingsNoHeader = await callRoute("/dsh-memory/settings", {
  method: "POST",
  body: JSON.stringify({ patch: { audit: false } }),
});
check(settingsNoHeader.code === 403, "settings: 缺 x-dsh-memory 头 → 403（跨站简单请求带不上此头）");

const settingsBadPatch = await callRoute("/dsh-memory/settings", {
  method: "POST",
  headers: { "x-dsh-memory": "1" },
  body: JSON.stringify({ patch: 5 }),
});
check(settingsBadPatch.code === 400, "settings: patch 非对象 → 400");

const settingsWrite = await callRoute("/dsh-memory/settings", {
  method: "POST",
  headers: { "x-dsh-memory": "1" },
  body: JSON.stringify({ patch: { audit: false, maxChars: 1234 } }),
});
check(settingsWrite.json?.value?.audit === false && settingsWrite.json?.value?.maxChars === 1234, "settings: POST 写开关并回新值");
check(host.readSettings().audit === false && host.readSettings().maxChars === 1234, "settings: 写完 host 立刻读到（不做缓存）");
check(at(CWD).includes("记忆纪律"), "settings: 改开关后注入组装不受影响");
store.audit = true;
store.maxChars = 24000;
const w8 = await writeTarget("global", "memory.md", "x", {});
check(w8.code === 403, "write: 缺 x-dsh-memory 头 → 403（挡掉跨站简单请求）");
const w9 = await callRoute("/dsh-memory/write", { method: "POST", headers: { "x-dsh-memory": "1" }, body: "{not json" });
check(w9.code === 400, "write: 坏 JSON → 400");
const w10 = await writeTarget("global", "memory.md", 12345);
check(w10.code === 400, "write: text 非字符串 → 400");

check(at(CWD).includes("edited from panel"), "host: 面板写入后注入内容随之改变（实时重读）");

// ══ client 半 ═══════════════════════════════════════════════════════════════
let clientExports = null;
const regs = [];
const calls = [];
const LAYERS = {
  rules: [
    { name: "AGENTS.md", path: join(HOME, ".dsh/AGENTS.md"), injected: true, exists: true, text: AGENTS_TEXT },
  ],
  global: [{ name: "memory.md", path: join(HOME, ".dsh/memory.md"), injected: true, exists: true, text: GLOBAL_TEXT }],
  [SLUG]: [
    { name: "MEMORY.md", path: join(HOME, ".dsh/memory/projects", SLUG, "MEMORY.md"), injected: true, exists: true, text: INDEX_TEXT },
    { name: "demo-topic.md", path: join(HOME, ".dsh/memory/projects", SLUG, "demo-topic.md"), injected: false, exists: true, text: "# demo topic body\n" },
  ],
};
globalThis.fetch = (url, init) => {
  calls.push({ url: String(url), init });
  const target = new URL("http://x" + String(url)).searchParams.get("target");
  if (String(url).startsWith("/dsh-memory/content")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, target, files: LAYERS[target] ?? [] }),
    });
  }
  if (String(url).startsWith("/dsh-memory/write")) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, changed: true }) });
  }
  if (String(url).startsWith("/dsh-memory/settings")) {
    if (init?.method === "POST") Object.assign(store, JSON.parse(init.body).patch);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, value: { ...store }, projects: [SLUG] }),
    });
  }
  return Promise.reject(new Error("unexpected fetch " + url));
};

const reactMock = makeReact();
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      clientExports = factory((spec) => {
        if (spec === "react") return reactMock;
        throw new Error("unexpected require " + spec);
      });
      clientExports.apply({
        slots: { inject: (_s, fn) => fn(), register: (o, C) => regs.push({ o, C }) },
        effect: (fn) => fn(),
      });
    },
  },
};
new Function(readFileSync(new URL("../client.js", import.meta.url), "utf8"))();

const render = () => { reactMock.__reset(); return resolve(regs[0].C({})); };
const buttons = (pane, label) => collect(pane, (n) => n.type === "button" && textOf(n) === label);

check(regs.length === 1 && regs[0].o.name === "settings.section", "client: 注册 settings.section");
check(regs[0]?.o.label === "记忆", "client: 导航标题 = 记忆");
check(styleTags.length >= 1, "client: 样式表已注入");
check(/\.dm-editor\{/.test(styleTags[0].textContent), "client: 样式表含编辑器样式");

let pane = render();
await tick(); // 等面板挂载时那次 /dsh-memory/settings 拉取落地
pane = render();
const strings = [];
collect(pane, (n) => { for (const c of n.children ?? []) if (typeof c === "string") strings.push(c); });
check(strings.includes("记忆"), "client: 面板含标题「记忆」");
check(strings.includes("全局规则文件"), "client: 新增「全局规则文件」分组");
check(strings.includes("AGENTS.md"), "client: 规则层显示 AGENTS.md 一行");
check(strings.includes("全局记忆"), "client: 面板含「全局记忆」行（可点开看正文）");
check(strings.includes("项目层（按工作区）"), "client: 面板含项目层分组");

let rows = collect(pane, (n) => n.props?.className === "dm-row");
check(rows.length === 3, `client: 三行（规则 / 全局 / 1 个项目），实际 ${rows.length}`);
const switches = collect(pane, (n) => n.props?.role === "switch");
check(switches.length === 5, `client: 每层一个开关 + 钩子区 3 个（纪律/读取提醒/审计），实际 ${switches.length}`);
check(strings.includes("写入 / 读取钩子") && strings.includes("写入守卫"), "client: 面板含「写入 / 读取钩子」区块");

// ── 面板开关：读走 GET、写走 POST，闭环到 settings.json ─────────────────────
check(calls.some((c) => c.url === "/dsh-memory/settings"), "client: 面板挂载时拉取 /dsh-memory/settings");
const settingsPosts = () => calls.filter((c) => c.url === "/dsh-memory/settings" && c.init?.method === "POST");
const postsBefore = settingsPosts().length;
switches[switches.length - 1].props.onClick({ stopPropagation() {} });
await tick();
check(settingsPosts().length === postsBefore + 1, "client: 点开关 → POST /dsh-memory/settings");
const swPost = settingsPosts().pop();
const swPatch = JSON.parse(swPost.init.body).patch;
check(swPost.init.headers["x-dsh-memory"] === "1", "client: 开关请求带 x-dsh-memory 头");
check(typeof swPatch === "object" && Object.keys(swPatch).length === 1, "client: 请求体是单字段 patch");
check(host.readSettings()[Object.keys(swPatch)[0]] === swPatch[Object.keys(swPatch)[0]], "client: 开关改动落到 settings.json（host 立即可见）");
// 还原成默认，后面的注入断言仍按默认开关走
store.globalEnabled = true;
store.projectEnabled = {};
store.maxChars = 24000;
store.injectMode = "index";
store.discipline = true;
store.readReminder = true;
store.audit = true;
check(strings.includes("规则引擎（默认）") && strings.includes("规则 + 外部命令"), "client: 写入守卫三态 chips 渲染");
check(strings.includes("读取纪律块") && strings.includes("写入审计") && strings.includes("读取提醒"), "client: 钩子区三个开关行渲染");

// ── 展开全局记忆 → 编辑 → 保存 ──────────────────────────────────────────────
await rows[1].props.onClick();
await tick();
pane = render();
check(calls.some((c) => c.url === "/dsh-memory/content?target=global"), "client: 展开时向 host 拉取正文");
check(collect(pane, (n) => n.props?.className === "dm-view").length === 1, "client: 展开后出现只读正文视图");
check(buttons(pane, "编辑").length === 1, "client: 只读态有「编辑」按钮");

buttons(pane, "编辑")[0].props.onClick();
pane = render();
let editors = collect(pane, (n) => n.props?.className === "dm-editor");
check(editors.length === 1 && editors[0].props.value === GLOBAL_TEXT, "client: 点「编辑」后出现 textarea，且初值 = 原文");
check(buttons(pane, "保存")[0].props.disabled === true, "client: 未改动时「保存」禁用");

const beforeWrite = calls.length;
editors[0].props.onChange({ target: { value: "# Global memory\n- panel edit\n" } });
pane = render();
editors = collect(pane, (n) => n.props?.className === "dm-editor");
check(editors[0].props.value.includes("panel edit"), "client: 输入进缓冲区（受控值更新）");
check(collect(pane, (n) => n.props?.className === "dm-status").some((n) => textOf(n) === "未保存"), "client: 显示「未保存」状态");
check(buttons(pane, "保存")[0].props.disabled === false, "client: 有改动后「保存」可用");

buttons(pane, "保存")[0].props.onClick();
await tick();
const writeCall = calls[beforeWrite].init;
check(calls[beforeWrite].url === "/dsh-memory/write" && writeCall.method === "POST", "client: 保存走 POST /dsh-memory/write");
check(writeCall.headers["x-dsh-memory"] === "1", "client: 带上 x-dsh-memory 头");
check(JSON.parse(writeCall.body).text.includes("panel edit") && JSON.parse(writeCall.body).target === "global", "client: 请求体含 target/file/text");
pane = render();
check(collect(pane, (n) => n.props?.className === "dm-status").some((n) => textOf(n) === "已保存"), "client: 保存后状态显示「已保存」");
check(buttons(pane, "保存")[0].props.disabled === true, "client: 保存后缓冲清空、「保存」回到禁用");

// ── 取消编辑 ────────────────────────────────────────────────────────────────
buttons(pane, "取消")[0].props.onClick();
pane = render();
check(collect(pane, (n) => n.props?.className === "dm-editor").length === 0, "client: 点「取消」退回只读");
check(collect(pane, (n) => n.props?.className === "dm-view").length === 1, "client: 取消后仍显示正文");

// ── 规则层：只有一个文件 → 没有页签，直接可编辑 ─────────────────────────────
rows = collect(pane, (n) => n.props?.className === "dm-row");
await rows[0].props.onClick();
await tick();
pane = render();
check(calls.some((c) => c.url === "/dsh-memory/content?target=rules"), "client: 规则层展开时拉取 rules");
check(collect(pane, (n) => hasClass("dm-tab")(n)).length === 0, "client: 规则层只有一个文件 → 不显示页签");
check(collect(pane, (n) => n.props?.className === "dm-view")[0].children[0].includes("probe rule"), "client: 规则层正文 = AGENTS.md");
check(buttons(pane, "编辑").length === 1, "client: AGENTS.md 可直接编辑");

// ── 项目层：多文件 + 保存落回 ───────────────────────────────────────────────
rows = collect(pane, (n) => n.props?.className === "dm-row");
await rows[2].props.onClick();
await tick();
pane = render();
const tabs = collect(pane, (n) => hasClass("dm-tab")(n));
check(tabs.length === 2, "client: 项目层列出 MEMORY.md 与主题文件");
check(buttons(pane, "编辑").length === 1, "client: 项目层同样可编辑");

// 未保存的草稿在切页签后仍然保留
buttons(pane, "编辑")[0].props.onClick();
pane = render();
collect(pane, (n) => n.props?.className === "dm-editor")[0].props.onChange({ target: { value: "# draft index\n" } });
pane = render();
collect(pane, (n) => hasClass("dm-tab")(n))[1].props.onClick();
pane = render();
check(collect(pane, (n) => hasClass("dm-tab")(n)).some((t) => textOf(t).includes("●")), "client: 未保存的页签带 ● 标记");
check(collect(pane, (n) => n.props?.className === "dm-editor").length === 0, "client: 切页签会退出编辑态");
collect(pane, (n) => hasClass("dm-tab")(n))[0].props.onClick();
pane = render();
buttons(pane, "编辑")[0].props.onClick();
pane = render();
check(collect(pane, (n) => n.props?.className === "dm-editor")[0].props.value === "# draft index\n", "client: 切走再切回，草稿仍在");

// ── 输出 ────────────────────────────────────────────────────────────────────
// ══ 钩子系统 ═════════════════════════════════════════════════════════════════
// 路径归属：每个记忆形态一层，越出管辖返回 null
check(host.memoryTargetOf(`${HOME}/.dsh/memory.md`).kind === "global-single", "hook: memory.md → global-single");
check(host.memoryTargetOf(`${HOME}/.dsh/AGENTS.md`).kind === "rules", "hook: AGENTS.md → rules");
check(host.memoryTargetOf(`${HOME}/.dsh/memory/topics/plugins.md`).kind === "topic", "hook: topics/*.md → topic");
check(host.memoryTargetOf(`${HOME}/.dsh/memory/projects/${SLUG}/MEMORY.md`).kind === "project-index", "hook: 项目 MEMORY.md → project-index");
check(host.memoryTargetOf(`${HOME}/.dsh/memory/projects/${SLUG}/demo-topic.md`).kind === "project-body", "hook: 项目正文 → project-body");
check(host.memoryTargetOf(`${HOME}/.dsh/memory/projects/--x-y--.md`).kind === "project-single", "hook: 单文件项目 → project-single");
check(host.memoryTargetOf(`${HOME}/.dsh/memory/audit.log`)?.kind === "plugin-internal", "hook: audit.log → plugin-internal");
check(host.memoryTargetOf(`${HOME}/.dsh/memory/topics/plugins.md.bak`)?.kind === "plugin-internal", "hook: .bak → plugin-internal");
check(host.memoryTargetOf("/etc/hosts") === null, "hook: 记忆之外不管");

check(host.validEntryDate("2026-01-01") === true && host.validEntryDate(new Date().toISOString().slice(0, 10)) === true, "hook: 过去/今天日期合法");
check(host.validEntryDate("2099-01-01") === false && host.validEntryDate("2026-13-45") === false && host.validEntryDate("垃圾") === false, "hook: 未来/翻滚/垃圾日期拒绝");
check(host.extractEntries("- [2026-01-01] a\n普通行\n- [2026-01-02] b").length === 2, "hook: 条目提取只认 - [日期] 行");
check(host.extractEntries("- [标题](x.md) — 摘要", true).length === 1 && host.extractEntries("- [标题](x.md) — 摘要").length === 0, "hook: 索引链接行只在 indexShape 下算条目");
check(host.lineDiff("a\nb\n", "a\nc\n").added.join() === "c" && host.lineDiff("a\nb\n", "a\nc\n").removed.join() === "b", "hook: 行级 diff 增删各归其位");
check(host.scanSecrets("token = abcdef123456789\n普通文字").length === 1, "hook: 凭据赋值命中");
check(host.scanSecrets("sk-abcdefABCDEF123456\npassword: 'longpassword123'").length === 2, "hook: sk- 键与 password 命中");
check(host.scanSecrets("这是一条普通记忆，没有任何凭据").length === 0, "hook: 普通文本不误报");

const D = (decision, reason, notes) => ({ decision, reason, notes });
check(host.mergeDecisions(D("allow"), D("deny", "x")).decision === "deny", "hook: 决策合并 deny 胜出");
check(host.mergeDecisions(D("ask", "y"), D("allow")).decision === "ask", "hook: 决策合并 ask 胜出");
check(host.mergeDecisions(D("allow", "", ["n1"]), D("allow", "", ["n2"])).notes.join() === "n1,n2", "hook: 决策合并 notes 累积");

// 规则引擎：各拒绝路径与放行路径
const TOPIC = `${HOME}/.dsh/memory/topics/probe-hook.md`;
const denyOf = (p) => host.runWriteRules(p).decision === "deny";
check(denyOf({ target: { kind: "plugin-internal" }, added: [] }), "hook: 规则 — 内部资产（.bak/审计）deny");
check(denyOf({ target: { kind: "global-single" }, added: ["- [2026-01-01] 写进索引的条目"], removed: [] }), "hook: 规则 — 往 memory.md 写条目 deny");
check(denyOf({ target: { kind: "topic" }, added: ["- [某天] 格式不对"], removed: [] }), "hook: 规则 — 条目格式错 deny");
check(denyOf({ target: { kind: "topic" }, added: ["- [2099-01-01] 未来条目"], removed: [] }), "hook: 规则 — 未来日期 deny");
check(denyOf({ target: { kind: "topic" }, added: ["token = supersecret123"], removed: [] }), "hook: 规则 — 疑似凭据 deny");
check(denyOf({ target: { kind: "topic" }, tool: "write", oldText: "- [2026-01-01] a\n- [2026-01-02] b", newText: "- [2026-01-01] a", added: [], removed: ["- [2026-01-02] b"] }), "hook: 规则 — 覆盖删历史条目 deny");
const okRun = host.runWriteRules({ target: { kind: "topic" }, tool: "edit", oldText: "", newText: `- [${new Date().toISOString().slice(0, 10)}] 正常新条目`, added: [`- [${new Date().toISOString().slice(0, 10)}] 正常新条目`], removed: [] });
check(okRun.decision === "allow", "hook: 规则 — 今天日期的正常追加 allow");

// 外部命令钩子输出解析（与 dsh-hook-protocol 语义对齐）
check(host.parseHookOutcome(2, "", "不许写").decision === "deny" && host.parseHookOutcome(2, "", "不许写").reason === "不许写", "hook: 外部 exit 2 → deny(stderr=原因)");
check(host.parseHookOutcome(0, JSON.stringify({ decision: "deny", reason: "r" }), "").decision === "deny", "hook: 外部 JSON {decision} → deny");
check(host.parseHookOutcome(0, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "why" } }), "").decision === "ask", "hook: 外部 claude-code 风格 → ask");
check(host.parseHookOutcome(0, "plain text", "").decision === "allow", "hook: 外部普通 stdout → allow");
check(host.parseHookOutcome(1, "", "boom").decision === "allow" && !!host.parseHookOutcome(1, "", "boom").note, "hook: 外部异常退出 → 放行 + note");

check(host.bashTouchesMemory("echo x >> ~/.dsh/memory/topics/a.md") === true, "hook: bash 重定向写记忆命中");
check(host.bashTouchesMemory("cat ~/.dsh/memory/topics/a.md") === false && host.bashTouchesMemory("ls ~/.dsh/memory") === false, "hook: bash 只读记忆不拦");

// 端到端：writeGuardHook / postExecuteHook 挂载与决策
check(typeof mountedHooks["tools/pre-execute"] === "function" && typeof mountedHooks["tools/post-execute"] === "function", "hook: pre/post-execute 已挂载");
const NEXT_PASSED = Symbol("next");
const passNext = async () => NEXT_PASSED;
check(
  (await mountedHooks["tools/pre-execute"]({ name: "write", arguments: { file_path: TOPIC, content: `- [${new Date().toISOString().slice(0, 10)}] ok\n` } }, passNext)) === NEXT_PASSED,
  "hook: 正常写入 topics → 放行",
);
check(
  (await mountedHooks["tools/pre-execute"]({ name: "write", arguments: { file_path: `${HOME}/.dsh/memory.md`, content: "- [2026-01-01] bad\n" } }, passNext)).kind === "deny",
  "hook: 写 memory.md → deny",
);
check(
  (await mountedHooks["tools/pre-execute"]({ name: "bash", arguments: { command: "echo x >> ~/.dsh/memory/topics/a.md" } }, passNext)).kind === "ask",
  "hook: bash 改记忆 → ask（转人工确认）",
);
store.writeGuard = "off";
check(
  (await mountedHooks["tools/pre-execute"]({ name: "write", arguments: { file_path: `${HOME}/.dsh/memory.md`, content: "- [2026-01-01] bad\n" } }, passNext)) === NEXT_PASSED,
  "hook: writeGuard=off → 完全放行",
);
store.writeGuard = "rules";
check(
  (await mountedHooks["tools/pre-execute"]({ name: "write", arguments: { file_path: "/etc/hosts", content: "x" } }, passNext)) === NEXT_PASSED,
  "hook: 记忆之外的写入不进入判定",
);

// 写入审计 + 读取提醒（post-execute）
const writeExec = { name: "edit", arguments: { file_path: TOPIC, old_string: "", new_string: `- [${new Date().toISOString().slice(0, 10)}] 审计用条目\n` } };
const postWrite = await mountedHooks["tools/post-execute"](writeExec, { content: [{ type: "text", text: "ok" }] }, async () => ({ kind: "accept" }));
check(postWrite.additionalContexts?.[0]?.content?.[0]?.text.includes("已审计"), "hook: 写入落盘 → 附加审计提醒");
check(existsSync(`${HOME}/.dsh/memory/audit.log`) && readFileSync(`${HOME}/.dsh/memory/audit.log`, "utf8").includes("post-write"), "hook: audit.log 落盘且记了 post-write");
mkdirSync(join(HOME, ".dsh/memory/topics"), { recursive: true });
writeFileSync(TOPIC, `# probe hook\n- [2026-01-01] probe hook fact\n`);
const postRead = await mountedHooks["tools/post-execute"]({ name: "read", arguments: { file_path: TOPIC } }, { content: [] }, async () => ({ kind: "accept" }));
check(postRead.additionalContexts?.[0]?.content?.[0]?.text.includes("read-hook") && postRead.additionalContexts[0].content[0].text.includes("1 条"), "hook: 读记忆文件 → 附加读取提醒（含条目数）");
const postReadOther = await mountedHooks["tools/post-execute"]({ name: "read", arguments: { file_path: "/etc/hosts" } }, { content: [] }, async () => ({ kind: "accept" }));
check(postReadOther.additionalContexts === undefined, "hook: 读记忆之外的文件不附加提醒");

// 注入纪律块 + 注入过滤命令
store.discipline = true;
check(at(CWD).includes("记忆纪律") && at(CWD).includes("deny"), "hook: 注入层附加记忆纪律块");
store.discipline = false;
check(!at(CWD).includes("记忆纪律"), "hook: discipline=false 可关闭纪律块");
store.discipline = true;
const unfiltered = host.applyInjectFilter("keep\nSKIPME\nmore"); // 命令为空 → 原样
store.injectHookCommand = "grep -v SKIPME";
const filtered2 = host.applyInjectFilter("keep\nSKIPME\nmore");
store.injectHookCommand = "";
check(unfiltered.includes("SKIPME") && !filtered2.includes("SKIPME") && filtered2.includes("keep"), "hook: injectHookCommand 可过滤注入文本（空 = 原样）");
check(at(CWD).includes("probe hook fact"), "hook: 过滤关闭后注入恢复原样");

// 外部命令钩子真进程：writeGuard=full + 一条 deny 命令
store.writeGuard = "full";
store.writeHookCommand = "test \"$DSH_SKIP\" = 1 && exit 0 || exit 2";
// 用一段 node 脚本当判定器：新增内容含 bad 就 exit 2
store.writeHookCommand = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);process.exit(p.added.some(l=>l.includes("badword"))?2:0)})'`;
check(
  (await mountedHooks["tools/pre-execute"]({ name: "write", arguments: { file_path: TOPIC, content: "badword here\n" } }, passNext)).kind === "deny",
  "hook: full 模式外部判定器 deny 生效（stdin payload 驱动）",
);
check(
  (await mountedHooks["tools/pre-execute"]({ name: "write", arguments: { file_path: TOPIC, content: "# probe hook\n- [2026-01-01] probe hook fact\n- clean line\n" } }, passNext)) === NEXT_PASSED,
  "hook: full 模式外部判定器放行干净写入",
);
store.writeGuard = "rules";
store.writeHookCommand = "";

console.log("dsh-memory probe — two-layer memory + rules, viewable & editable");
console.log("─".repeat(72));
for (const { ok, label } of results) console.log(`  ${ok ? "✅" : "❌"} ${label}`);
const failed = results.filter((r) => !r.ok).length;
console.log("─".repeat(72));
console.log(`${results.length - failed} passed, ${failed} failed  (isolated HOME: ${HOME})`);
process.exit(failed === 0 ? 0 : 1);
