(() => {
  try {
    /* dsh-memory client half —— 「设置 → 记忆」控制面板。
       每层一个开关 + 点击标题即可就地展开该层的记忆正文（host 半的只读路由提供）。
       开关只翻一个布尔值：host 的 text 是函数，每次 assemble 求值，所以关掉/开启
       立即生效，无需重启或刷新。 */
    window.__ModuleLoader__.load({
      id: "dsh-memory",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");
        var inject = ["slots"];
        var NS = "dsh-memory";

        var STYLE_ID = "dsh-memory-style";
        var CSS = [
          ".dm-pane{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;padding:4px 0 24px;color:var(--dsw-alias-label-primary)}",
          ".dm-title{margin:0;font-size:16px;line-height:24px;font-weight:500}",
          ".dm-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
          ".dm-group{display:flex;flex-direction:column;gap:8px}",
          ".dm-group-title{margin:0;font-size:13px;line-height:20px;font-weight:500}",
          ".dm-item{display:flex;flex-direction:column;gap:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;overflow:hidden}",
          ".dm-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;cursor:pointer}",
          ".dm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
          ".dm-main{display:flex;flex-direction:column;gap:2px;min-width:0}",
          ".dm-name{font-size:13px;line-height:20px;display:flex;align-items:center;gap:6px}",
          ".dm-caret{transition:transform 120ms ease;color:var(--dsw-alias-label-tertiary);font-size:10px}",
          ".dm-caret[data-open='true']{transform:rotate(90deg)}",
          ".dm-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".dm-off .dm-name{color:var(--dsw-alias-label-tertiary)}",
          ".dm-view{margin:0;max-height:360px;overflow:auto;border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);padding:10px 12px;font-family:var(--dsw-font-markdown-code-block-small,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}",
          ".dm-empty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
          ".dm-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
          ".dm-err{color:var(--dsw-alias-state-error-primary)}",
          ".dm-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background 120ms ease}",
          ".dm-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}",
          ".dm-switch:disabled{cursor:default;opacity:.5}",
          ".dm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
          ".dm-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}",
          ".dm-switch[aria-checked='true'] .dm-thumb{transform:translateX(16px)}",
        ].join("");

        function ensureStyleSheet() {
          if (typeof document === "undefined") return;
          if (document.getElementById(STYLE_ID)) return;
          var el = document.createElement("style");
          el.id = STYLE_ID;
          el.textContent = CSS;
          document.head.appendChild(el);
        }

        /** 设置状态源：settings scope 的实时镜像。 */
        function createSettingSource() {
          var state = { value: {}, status: "loading", writable: false };
          var bound;
          var listeners = new Set();
          var publish = function (next) {
            if (next.value === state.value && next.status === state.status && next.writable === state.writable) return;
            state = next;
            listeners.forEach(function (fn) { fn(); });
          };
          var sync = function () {
            if (bound === void 0) return;
            var snap = bound.getSnapshot();
            var v = snap && snap.value !== null && typeof snap.value === "object" ? snap.value : {};
            publish({
              value: {
                globalEnabled: v.globalEnabled !== false,
                projectEnabled: v.projectEnabled !== null && typeof v.projectEnabled === "object" ? v.projectEnabled : {},
                knownProjects: Array.isArray(v.knownProjects) ? v.knownProjects : [],
              },
              status: snap.status === "ready" || snap.status === "unavailable" ? snap.status : "loading",
              writable: !!snap.writable,
            });
          };
          return {
            store: {
              subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
              getSnapshot: function () { return state; },
            },
            attach: function (next) { bound = next; sync(); return bound.subscribe(sync); },
            set: function (field, value) {
              if (bound === void 0) return Promise.resolve();
              return Promise.resolve(bound.set(field, value)).then(sync, function () { sync(); });
            },
            available: function () { return bound !== void 0; },
          };
        }

        var setting = createSettingSource();

        /** 内联开关（aria-checked 驱动，样式全在样式表里）。 */
        function Toggle(props) {
          var snap = react.useSyncExternalStore(setting.store.subscribe, setting.store.getSnapshot, setting.store.getSnapshot);
          var pendingPair = react.useState(false);
          var pending = pendingPair[0];
          var setPending = pendingPair[1];
          var checked = props.checked;
          var locked = pending || !setting.available() || !snap.writable;
          var title = !setting.available()
            ? "设置服务不可用，无法写入开关"
            : !snap.writable
              ? "设置文档只读"
              : checked ? "点击关闭" : "点击开启";
          var onClick = function (event) {
            event.stopPropagation(); // 别触发行上的「展开内容」
            if (locked) return;
            setPending(true);
            Promise.resolve(props.onToggle()).then(
              function () { setPending(false); },
              function () { setPending(false); },
            );
          };
          return react.createElement(
            "button",
            {
              type: "button",
              role: "switch",
              "aria-checked": checked ? "true" : "false",
              "aria-label": props.label,
              title: title,
              disabled: pending,
              onClick: onClick,
              className: "dm-switch",
            },
            react.createElement("span", { className: "dm-thumb" }),
          );
        }

        /** slug → 末段显示名。 */
        function shortName(slug) {
          var s = String(slug).replace(/^--/, "").replace(/--$/, "");
          var parts = s.split("-");
          return parts[parts.length - 1] || s;
        }

        /**
         * 设置分栏本体：全局层 + 项目层，每项可点开看正文。
         */
        function MemoryPane() {
          var snap = react.useSyncExternalStore(setting.store.subscribe, setting.store.getSnapshot, setting.store.getSnapshot);
          var value = snap.value || {};
          var globalEnabled = value.globalEnabled !== false;
          var projectEnabled = value.projectEnabled || {};
          var known = value.knownProjects || [];

          var openPair = react.useState(null);
          var open = openPair[0];
          var setOpen = openPair[1];
          var contentPair = react.useState({ status: "idle", text: "" });
          var content = contentPair[0];
          var setContent = contentPair[1];

          var toggleView = function (target) {
            if (open === target) { setOpen(null); return; }
            setOpen(target);
            setContent({ status: "loading", text: "" });
            fetch("/dsh-memory/content?target=" + encodeURIComponent(target))
              .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)); })
              .then(function (t) { setContent({ status: "ready", text: t }); })
              .catch(function (e) { setContent({ status: "error", text: String((e && e.message) || e) }); });
          };

          var item = function (target, name, sub, checked, onToggle, label) {
            var isOpen = open === target;
            var body = null;
            if (isOpen) {
              var text = content.status === "loading"
                ? "读取中…"
                : content.status === "error"
                  ? "读取失败：" + content.text + "（若为 HTTP 403，说明该路由被部署的访问控制拦截）"
                  : content.text;
              body = react.createElement("pre", {
                className: content.status === "error" ? "dm-view dm-err" : "dm-view",
              }, text);
            }
            return react.createElement(
              "div",
              { className: checked ? "dm-item" : "dm-item dm-off", key: target },
              react.createElement(
                "div",
                { className: "dm-row", onClick: function () { toggleView(target); }, title: "点击查看内容" },
                react.createElement(
                  "div",
                  { className: "dm-main" },
                  react.createElement(
                    "span",
                    { className: "dm-name" },
                    react.createElement("span", { className: "dm-caret", "data-open": isOpen ? "true" : "false" }, "▶"),
                    name,
                  ),
                  react.createElement("span", { className: "dm-sub" }, sub),
                ),
                react.createElement(Toggle, { checked: checked, onToggle: onToggle, label: label }),
              ),
              body,
            );
          };

          var projects = known.length === 0
            ? react.createElement("p", { className: "dm-empty" }, "还没有项目级记忆（~/.dsh/memory/projects/）。")
            : known.map(function (slug) {
                var enabled = projectEnabled[slug] !== false;
                return item(
                  slug,
                  shortName(slug),
                  slug,
                  enabled,
                  function () {
                    var next = Object.assign({}, projectEnabled);
                    next[slug] = !enabled;
                    return setting.set("projectEnabled", next);
                  },
                  shortName(slug) + " 记忆开关",
                );
              });

          return react.createElement(
            "section",
            { className: "dm-pane" },
            react.createElement("h2", { className: "dm-title" }, "记忆"),
            react.createElement(
              "p",
              { className: "dm-intro" },
              "两层长期记忆：全局层（所有项目）+ 项目层（按当前工作区）。点标题即可展开看正文；" +
                "开关关掉的那一层不再注入系统提示词，再次开启时立即重新读取文件。",
            ),
            react.createElement("h3", { className: "dm-group-title" }, "全局层（跨项目）"),
            react.createElement(
              "div",
              { className: "dm-group" },
              item(
                "global",
                "全局记忆",
                "~/.dsh/memory.md · 用户偏好 / 环境事实 / 通用坑",
                globalEnabled,
                function () { return setting.set("globalEnabled", !globalEnabled); },
                "全局记忆开关",
              ),
            ),
            react.createElement("h3", { className: "dm-group-title" }, "项目层（按工作区）"),
            react.createElement("div", { className: "dm-group" }, projects),
            react.createElement(
              "p",
              { className: "dm-note" },
              "开关状态存 ~/.dsh/settings.yaml 的 dsh-memory 节；项目列表由 host 扫描 ~/.dsh/memory/projects/ 自动维护；" +
                "正文由 host 的只读路由 /dsh-memory/content 提供。",
            ),
          );
        }

        function apply(ctx) {
          ensureStyleSheet();
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: "dsh-memory", order: 43, label: "记忆" },
              MemoryPane,
            ),
          );
          ctx.inject(["settingsScope"], function (scopeCtx) {
            var binder = scopeCtx.settingsScope;
            if (binder === void 0 || typeof binder.bind !== "function") return;
            scopeCtx.effect(function () {
              // decode 直通：host 半用的是手写 schema，无需客户端再 rehydrate 校验。
              return setting.attach(binder.bind({ namespace: NS, decode: function (v) { return v; } }));
            }, "dsh-memory: settings scope");
          });
        }

        exports.name = "dsh-memory";
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
      },
    });
  } catch (err) {
    console.warn("[AI Client Sandbox] dsh-memory runtime error:", err);
  }
})();
