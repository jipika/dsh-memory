import { existsSync, readFileSync, readdirSync } from "node:fs";

// dsh-memory —— 两层长期记忆注入（全局 + 按项目），带开关，全部实时。
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
//
// 零额外 LLM 成本：不调用任何模型，只读 markdown 文件；写入由当前会话的 agent 顺手完成。

const HOME = process.env.HOME ?? "";

/** 全局层记忆文件。 */
const GLOBAL_MEMORY = `${HOME}/.dsh/memory.md`;

/** 项目层记忆目录。 */
const PROJECT_DIR = `${HOME}/.dsh/memory/projects`;

/** settings namespace（设置面板与 host 共享的开关状态）。 */
const NS = "dsh-memory";

/** 单层注入上限。 */
const MAX_CHARS = 24000;

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
  return {
    globalEnabled: v.globalEnabled !== false,
    projectEnabled: { ...enabled },
    knownProjects: [...known],
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
 * 截断保护。
 * @param {string} text - 正文。
 * @param {string} path - 来源路径（写进截断提示）。
 * @returns {string} 原正文或其截断版。
 */
function clamp(text, path) {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n\n<!-- 已截断：${path} 超过 ${MAX_CHARS} 字符 -->`;
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
  const blocks = [];

  // ── 全局层 ──────────────────────────────────────────────────────────────
  if (values.globalEnabled !== false) {
    const text = readOrEmpty(GLOBAL_MEMORY).trim();
    if (text) blocks.push(`<!-- 全局记忆 · ${GLOBAL_MEMORY} -->\n\n${clamp(text, GLOBAL_MEMORY)}`);
  }

  // ── 项目层 ──────────────────────────────────────────────────────────────
  const cwd = context?.agent?.session?.header?.cwd;
  if (typeof cwd === "string" && cwd.length > 0) {
    const slug = slugOf(cwd);
    if (values.projectEnabled?.[slug] !== false) {
      const dir = `${PROJECT_DIR}/${slug}`;
      const indexPath = `${dir}/MEMORY.md`;
      if (existsSync(indexPath)) {
        const body = readOrEmpty(indexPath).trim();
        if (body) {
          blocks.push(
            `<!-- 项目记忆 · ${cwd} -->\n\n${clamp(body, indexPath)}` +
              `\n\n<!-- 以上是索引。主题文件按需直接读：${dir}/<文件名>.md -->`,
          );
        }
      } else {
        const filePath = `${PROJECT_DIR}/${slug}.md`;
        const body = readOrEmpty(filePath).trim();
        if (body) {
          blocks.push(
            `<!-- 项目记忆 · ${cwd} -->\n\n${clamp(body, filePath)}\n\n<!-- 写入本层：${filePath} -->`,
          );
        }
      }
    }
  }

  return blocks.join("\n\n---\n\n");
}

/**
 * 只读内容路由：`GET /dsh-memory/content?target=global|<slug>`。
 * 供设置面板「点击查看记忆内容」。target 走白名单校验，无法越出记忆目录。
 * 已注册路由在 dsh-host-webserver 里先于 fallback 匹配，因此不受 SPA 的 403 影响。
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {import("node:http").ServerResponse} res - 响应。
 */
function handleContentRoute(req, res) {
  const send = (code, text) => {
    res.writeHead(code, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(text);
  };
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/dsh-memory/content") return send(404, "not found");

    const target = url.searchParams.get("target") ?? "global";
    if (target === "global") return send(200, readOrEmpty(GLOBAL_MEMORY) || "(空)");

    // slug 仅允许 `--<安全字符>--`：显式拒绝 `..` 与路径分隔符，杜绝穿越。
    if (!/^--[A-Za-z0-9\u4e00-\u9fff._ -]*--$/.test(target) || target.includes("..")) {
      return send(400, "bad target");
    }
    const dir = `${PROJECT_DIR}/${target}`;
    const indexPath = `${dir}/MEMORY.md`;
    if (existsSync(indexPath)) return send(200, readOrEmpty(indexPath) || "(空)");
    return send(200, readOrEmpty(`${PROJECT_DIR}/${target}.md`) || "(空)");
  } catch (error) {
    return send(500, String(error?.message ?? error));
  }
}

/**
 * 挂载：提示词段 + 设置 namespace + 内容路由。
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

  // 只读内容路由：设置面板「查看记忆内容」用。webServer 缺席时面板会提示读取失败。
  ctx.inject(["webServer"], (wctx) => {
    ctx.effect(
      () =>
        wctx.webServer.register({
          kind: "prefix",
          // 不带尾部斜杠：dsh-host-webserver 的 match() 自己会补 "/" 再比前缀
          path: "/dsh-memory",
          handler: handleContentRoute,
        }),
      "dsh-memory: content route",
    );
  });
}
