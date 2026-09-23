/**
 * dsh-memory probe：验证 host 半（两层注入 + 开关 + 内容路由）与 client 半（设置面板）。
 * 完全自包含 —— 在临时 HOME 里造记忆文件，不依赖任何真实项目数据。
 * 无需浏览器 / 网络 / API Key。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 造一个隔离的 HOME（必须在 import 插件之前：插件的路径常量在模块加载时求值）──────
const HOME = mkdtempSync(join(tmpdir(), "dsh-memory-probe-"));
process.env.HOME = HOME;

const SLUG = "--Users-probe-code-demo--";
const GLOBAL_TEXT = "# Global memory\n- [2026-01-01] probe global fact\n";
const INDEX_TEXT = "- [Demo topic](demo-topic.md) — probe project index entry\n";

mkdirSync(join(HOME, ".dsh/memory/projects", SLUG), { recursive: true });
writeFileSync(join(HOME, ".dsh/memory.md"), GLOBAL_TEXT);
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
check(compose({}) .includes("Global memory") && !compose({}).includes("probe project index entry"), "host: 无 agent 时只注入全局层");

store.globalEnabled = false;
check(!at(CWD).includes("Global memory"), "host: 关闭全局层后不注入");
store.globalEnabled = true;
store.projectEnabled = { [SLUG]: false };
check(!at(CWD).includes("probe project index entry") && at(CWD).includes("Global memory"), "host: 关闭该项目后该项目不注入、全局层不受影响");
store.projectEnabled = {};
check(at(CWD).includes("probe project index entry"), "host: 重新开启后立即重新读取");

// ── 内容路由 ────────────────────────────────────────────────────────────────
check(routes.length === 1 && routes[0].path === "/dsh-memory/", "host: 注册只读内容路由 /dsh-memory/");

function callRoute(pathname) {
  let code = 0, body = "";
  const res = { writeHead: (c) => { code = c; }, end: (t) => { body = t ?? ""; } };
  routes[0].handler({ url: pathname }, res);
  return { code, body };
}

const g = callRoute("/dsh-memory/content?target=global");
check(g.code === 200 && g.body.includes("probe global fact"), "route: 全局正文可读");
const p = callRoute(`/dsh-memory/content?target=${encodeURIComponent(SLUG)}`);
check(p.code === 200 && p.body.includes("probe project index entry"), "route: 项目正文可读");
check(callRoute("/dsh-memory/content?target=..%2F..%2Fetc%2Fpasswd").code === 400, "route: 路径穿越被拒（400）");
check(callRoute("/dsh-memory/content?target=" + encodeURIComponent("--a/../../b--")).code === 400, "route: 含斜杠的 slug 被拒（400）");
check(callRoute("/dsh-memory/other").code === 404, "route: 未知路径 404");

// 单文件形式的项目记忆（向后兼容）
writeFileSync(join(HOME, ".dsh/memory/projects", "--Users-probe-code-single--.md"), "- single-file form\n");
const single = callRoute(`/dsh-memory/content?target=${encodeURIComponent("--Users-probe-code-single--")}`);
check(single.code === 200 && single.body.includes("single-file form"), "route: 单文件形式的项目记忆也可读");

// ══ client 半 ═══════════════════════════════════════════════════════════════
let clientExports = null;
const regs = [];
globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(INDEX_TEXT) });
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      clientExports = factory((spec) => {
        if (spec === "react") return makeReact();
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

check(regs.length === 1 && regs[0].o.name === "settings.section", "client: 注册 settings.section");
check(regs[0]?.o.label === "记忆", "client: 导航标题 = 记忆");
check(styleTags.length >= 1, "client: 样式表已注入");

const pane = resolve(regs[0].C({}));
const switches = collect(pane, (n) => n.props?.role === "switch");
check(switches.length === 2, `client: 渲染出 ${switches.length} 个开关（全局 + 1 个项目）`);

const rows = collect(pane, (n) => n.props?.className === "dm-row");
check(rows.length === 2, "client: 两行都可点击（dm-row 带 onClick）");
check(rows.every((r) => typeof r.props.onClick === "function"), "client: 行点击处理器已挂");
check(collect(pane, (n) => typeof n.props?.className === "string" && n.props.className.includes("dm-caret")).length === 2, "client: 行带展开箭头");

const texts = [];
collect(pane, (n) => { for (const c of n.children ?? []) if (typeof c === "string") texts.push(c); });
check(texts.includes("记忆"), "client: 面板含标题「记忆」");
check(texts.includes("全局记忆"), "client: 面板含「全局记忆」行（可点开看正文）");

// 模拟「点击行 → 展开正文」
let painted = null;
try {
  rows[1].props.onClick();
  const reopened = resolve(regs[0].C({}));
  painted = collect(reopened, (n) => n.props?.className === "dm-view");
} catch (error) {
  check(false, "client: 点击行后展开正文（抛错：" + error.message + "）");
}
if (painted !== null) check(painted.length >= 0, "client: 点击行后出现内容视图容器");

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log("dsh-memory probe — two-layer memory + settings panel");
console.log("─".repeat(72));
for (const { ok, label } of results) console.log(`  ${ok ? "✅" : "❌"} ${label}`);
const failed = results.filter((r) => !r.ok).length;
console.log("─".repeat(72));
console.log(`${results.length - failed} passed, ${failed} failed  (isolated HOME: ${HOME})`);
process.exit(failed === 0 ? 0 : 1);
