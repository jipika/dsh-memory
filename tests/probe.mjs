/**
 * dsh-memory probe：验证 host 半（两层注入 + 开关 + 内容/写入路由）与 client 半（设置面板的
 * 查看→编辑→保存）。完全自包含 —— 在临时 HOME 里造记忆文件，不依赖任何真实项目数据。
 * 无需浏览器 / 网络 / API Key。
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    useEffect: () => {},
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
const store = { globalEnabled: true, projectEnabled: {}, knownProjects: [] };
const fakeScope = {
  get: () => store,
  update: (patch) => { Object.assign(store, patch); return Promise.resolve(); },
  watch: () => () => {},
};
host.apply({
  effect: (fn) => fn(),
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  inject: (deps, cb) => {
    if (deps.includes("settings")) cb({ settings: { register: () => fakeScope } });
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
check(at(CWD).includes("主题文件按需直接读"), "host: 附带主题文件目录提示");
check(at(CWD).includes(SLUG), `host: 由 cwd 推出的 slug 正确 (${SLUG})`);
check(store.knownProjects.includes(SLUG), "host: knownProjects 自动扫描同步");
check(compose({}).includes("Global memory") && !compose({}).includes("probe project index entry"), "host: 无 agent 时只注入全局层");

store.globalEnabled = false;
check(!at(CWD).includes("Global memory"), "host: 关闭全局层后不注入");
store.globalEnabled = true;
store.projectEnabled = { [SLUG]: false };
check(!at(CWD).includes("probe project index entry") && at(CWD).includes("Global memory"), "host: 关闭该项目后该项目不注入、全局层不受影响");
store.projectEnabled = {};
check(at(CWD).includes("probe project index entry"), "host: 重新开启后立即重新读取");

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
        inject: (deps, cb) => cb({
          settingsScope: { bind: () => ({ getSnapshot: () => ({ status: "ready", value: store, writable: true }), subscribe: () => () => {}, set: () => Promise.resolve() }) },
          effect: (fn) => fn(),
        }),
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
check(switches.length === 2, `client: 规则层没有开关，其余每层一个（共 ${switches.length}）`);

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
console.log("dsh-memory probe — two-layer memory + rules, viewable & editable");
console.log("─".repeat(72));
for (const { ok, label } of results) console.log(`  ${ok ? "✅" : "❌"} ${label}`);
const failed = results.filter((r) => !r.ok).length;
console.log("─".repeat(72));
console.log(`${results.length - failed} passed, ${failed} failed  (isolated HOME: ${HOME})`);
process.exit(failed === 0 ? 0 : 1);
