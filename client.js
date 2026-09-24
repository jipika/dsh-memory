(() => {
  try {
    /* dsh-memory client half —— 「设置 → 记忆」控制面板。
       三层内容：全局规则文件（~/.dsh/AGENTS.md）、全局记忆、按项目的记忆。
       每层一个开关（规则层没有开关），点标题就地展开：可看正文、也可直接编辑并保存。
       正文与写回都走 host 半的路由（/dsh-memory/content 读、/dsh-memory/write 写），
       开关只翻一个布尔值：host 的 text 是函数，每次 assemble 求值，所以关掉/开启立即生效。 */
    window.__ModuleLoader__.load({
      id: "@jipika/dsh-memory",
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
          ".dm-body{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l3)}",
          ".dm-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 0;background:var(--dsw-alias-bg-layer-2)}",
          ".dm-tab{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;padding:3px 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
          ".dm-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}",
          ".dm-tab-on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}",
          ".dm-tools{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:6px 12px;background:var(--dsw-alias-bg-layer-2)}",
          ".dm-status{margin-right:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
          ".dm-btn{flex:0 0 auto;font-size:11px;line-height:16px;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}",
          ".dm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
          ".dm-btn:disabled{opacity:.45;cursor:default}",
          ".dm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}",
          ".dm-view{margin:0;max-height:360px;overflow:auto;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;font-family:var(--dsw-font-markdown-code-block-small,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}",
          ".dm-empty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
          ".dm-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
          ".dm-layer-note{padding:6px 12px 10px;background:var(--dsw-alias-bg-layer-2)}",
          ".dm-err{color:var(--dsw-alias-state-error-primary)}",
          ".dm-editor{display:block;box-sizing:border-box;width:100%;min-height:220px;max-height:420px;resize:vertical;border:0;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;font-family:var(--dsw-font-markdown-code-block-small,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:17px;white-space:pre;overflow:auto;color:var(--dsw-alias-label-primary);outline:none}",
          ".dm-editor:focus{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}",
          ".dm-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background 120ms ease}",
          ".dm-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}",
          ".dm-switch:disabled{cursor:default;opacity:.5}",
          ".dm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
          ".dm-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}",
          ".dm-switch[aria-checked='true'] .dm-thumb{transform:translateX(16px)}",
          ".dm-limit{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px}",
          ".dm-limit-desc{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}",
          ".dm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
          ".dm-chip{font-size:11px;line-height:16px;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
          ".dm-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
          ".dm-chip-on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}",
          ".dm-num{box-sizing:border-box;width:104px;font-size:11px;line-height:16px;padding:3px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
          ".dm-num:focus{outline:none;box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}",
          ".dm-cmd{box-sizing:border-box;width:100%;font-size:11px;line-height:16px;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
          ".dm-cmd:focus{outline:none;box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}",
          ".dm-hookrow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0}",
          ".dm-hookrow-label{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary)}",
          ".dm-hookrow-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
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
                // 必须带上：漏掉它会让面板永久回落到默认值，档位与输入框都不跟着设置走。
                maxChars: Number.isFinite(v.maxChars) ? Math.max(0, Math.floor(v.maxChars)) : 24000,
                injectMode: v.injectMode === "full" ? "full" : "index",
                // 钩子子系统字段：同样必须进快照，否则设置里改了也会被这里洗回默认值。
                writeGuard: v.writeGuard === "off" || v.writeGuard === "full" ? v.writeGuard : "rules",
                writeHookCommand: typeof v.writeHookCommand === "string" ? v.writeHookCommand : "",
                hookTimeoutMs: Number.isFinite(v.hookTimeoutMs) ? Math.max(1000, Math.floor(v.hookTimeoutMs)) : 10000,
                readReminder: v.readReminder !== false,
                discipline: v.discipline !== false,
                injectHookCommand: typeof v.injectHookCommand === "string" ? v.injectHookCommand : "",
                audit: v.audit !== false,
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

        /** 面板里三层内容的序号：每次请求 +1，用来丢弃过期响应。 */
        var requestSeq = 0;

        /** 编辑缓冲的 key（target + 文件名）。 */
        function keyOf(target, name) { return target + "::" + name; }

        /**
         * 设置分栏本体：全局规则 + 全局层 + 项目层。每项可展开看正文，并可就地编辑保存。
         */
        function MemoryPane() {
          var snap = react.useSyncExternalStore(setting.store.subscribe, setting.store.getSnapshot, setting.store.getSnapshot);
          var value = snap.value || {};
          var globalEnabled = value.globalEnabled !== false;
          var projectEnabled = value.projectEnabled || {};
          var known = value.knownProjects || [];
          var maxCharsValue = Number.isFinite(value.maxChars) ? value.maxChars : 24000;
          var injectModeValue = value.injectMode === "full" ? "full" : "index";
          // 钩子子系统（host 半归一化的同名字段；这里只读值渲染 UI）
          var writeGuardValue = value.writeGuard === "off" || value.writeGuard === "full" ? value.writeGuard : "rules";
          var disciplineValue = value.discipline !== false;
          var readReminderValue = value.readReminder !== false;
          var auditValue = value.audit !== false;
          var writeHookCommandValue = typeof value.writeHookCommand === "string" ? value.writeHookCommand : "";
          var injectHookCommandValue = typeof value.injectHookCommand === "string" ? value.injectHookCommand : "";

          var openPair = react.useState(null);
          var open = openPair[0];
          var setOpen = openPair[1];
          var layerPair = react.useState({ status: "idle", files: [], error: "" });
          var layer = layerPair[0];
          var setLayer = layerPair[1];
          var pickedPair = react.useState({});
          var picked = pickedPair[0];
          var setPicked = pickedPair[1];
          var draftPair = react.useState({});
          var draft = draftPair[0];
          var setDraft = draftPair[1];
          var savePair = react.useState({ status: "idle", text: "" });
          var saveState = savePair[0];
          var setSaveState = savePair[1];
          var editPair = react.useState(false);
          var editing = editPair[0];
          var setEditing = editPair[1];

          /** 拉取某一层的正文（含层内全部文件）。 */
          var load = function (target) {
            var seq = ++requestSeq;
            setLayer({ status: "loading", files: [], error: "" });
            fetch("/dsh-memory/content?target=" + encodeURIComponent(target))
              .then(function (r) {
                return r.json().then(function (j) {
                  if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error) || ("HTTP " + r.status));
                  return j;
                });
              })
              .then(function (j) {
                if (seq !== requestSeq) return;
                setLayer({ status: "ready", files: j.files || [], error: "" });
              })
              .catch(function (e) {
                if (seq !== requestSeq) return;
                setLayer({ status: "error", files: [], error: String((e && e.message) || e) });
              });
          };

          /** 展开 / 收起一层。 */
          var toggleOpen = function (target) {
            if (open === target) { setOpen(null); return; }
            setOpen(target);
            setEditing(false);
            setSaveState({ status: "idle", text: "" });
            load(target);
          };

          /** 保存一个文件（走 host 的写路由）。 */
          var save = function (target, name, text) {
            var key = keyOf(target, name);
            setSaveState({ status: "saving", text: "保存中…" });
            fetch("/dsh-memory/write", {
              method: "POST",
              headers: { "content-type": "application/json", "x-dsh-memory": "1" },
              body: JSON.stringify({ target: target, file: name, text: text }),
            })
              .then(function (r) {
                return r.json().then(function (j) {
                  if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error) || ("HTTP " + r.status));
                  return j;
                });
              })
              .then(function (j) {
                if (target === open) {
                  setLayer(function (prev) {
                    return {
                      status: "ready",
                      error: "",
                      files: prev.files.map(function (f) {
                        return f.name === name ? Object.assign({}, f, { text: text, exists: true }) : f;
                      }),
                    };
                  });
                }
                setDraft(function (prev) {
                  var next = Object.assign({}, prev);
                  delete next[key];
                  return next;
                });
                setSaveState({ status: "saved", text: j && j.changed === false ? "已保存（内容未变）" : "已保存" });
              })
              .catch(function (e) {
                setSaveState({ status: "error", text: "保存失败：" + String((e && e.message) || e) });
              });
          };

          /** 展开体：文件切换 + 查看/编辑 + 保存。 */
          var renderBody = function (target, note) {
            if (layer.status === "loading") {
              return react.createElement("div", { className: "dm-body" }, react.createElement("p", { className: "dm-view" }, "读取中…"));
            }
            if (layer.status === "error") {
              return react.createElement(
                "div",
                { className: "dm-body" },
                react.createElement("p", { className: "dm-view dm-err" }, "读取失败：" + layer.error + "（若为 HTTP 403，说明该路由被部署的访问控制拦截）"),
              );
            }
            var files = layer.files || [];
            if (files.length === 0) {
              return react.createElement("div", { className: "dm-body" }, react.createElement("p", { className: "dm-view" }, "(无文件)"));
            }
            var activeName = picked[target] !== void 0 && files.some(function (f) { return f.name === picked[target]; })
              ? picked[target]
              : files[0].name;
            var file = files[0];
            for (var i = 0; i < files.length; i += 1) if (files[i].name === activeName) file = files[i];
            var key = keyOf(target, activeName);
            var buffered = draft[key];
            var text = buffered === void 0 ? file.text : buffered;
            var dirty = buffered !== void 0 && buffered !== file.text;

            var tabs = files.length > 1
              ? react.createElement(
                  "div",
                  { className: "dm-tabs" },
                  files.map(function (f) {
                    var bufferedFile = draft[keyOf(target, f.name)];
                    var fileDirty = bufferedFile !== void 0 && bufferedFile !== f.text;
                    return react.createElement(
                      "button",
                      {
                        key: f.name,
                        type: "button",
                        className: f.name === activeName ? "dm-tab dm-tab-on" : "dm-tab",
                        title: (f.path || f.name) + (f.injected ? "（注入系统提示词）" : "（按需读取的主题文件）"),
                        onClick: function () {
                          setPicked(function (prev) {
                            var next = Object.assign({}, prev);
                            next[target] = f.name;
                            return next;
                          });
                          setEditing(false);
                          setSaveState({ status: "idle", text: "" });
                        },
                      },
                      f.name + (fileDirty ? " ●" : ""),
                    );
                  }),
                )
              : null;

            // 该层正文的体量与注入状态（未编辑也未保存时显示，让超预算一眼可见）
            var charInfo = layer.status === "ready" && file.exists && file.injected
              ? (function () {
                  var n = (file.text || "").length;
                  if (maxCharsValue <= 0) return n + " 字符 · 全量注入";
                  if (n <= maxCharsValue) return n + " 字符 · 全量注入（上限 " + maxCharsValue + "）";
                  return n + " 字符 · 上限 " + maxCharsValue + "，约 " + Math.round((maxCharsValue / n) * 100) + "% 注入，其余转为带行号索引";
                })()
              : "";
            var statusText = layer.status !== "ready"
              ? ""
              : saveState.status === "saving"
                ? "保存中…"
                : dirty
                  ? "未保存"
                  : saveState.text !== ""
                    ? saveState.text
                    : file.exists ? charInfo : "该文件还不存在，保存即创建";
            var tools = react.createElement(
              "div",
              { className: "dm-tools" },
              react.createElement(
                "span",
                { className: saveState.status === "error" ? "dm-status dm-err" : "dm-status" },
                statusText,
              ),
              editing
                ? react.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dm-btn",
                      onClick: function () {
                        setDraft(function (prev) {
                          var next = Object.assign({}, prev);
                          delete next[key];
                          return next;
                        });
                        setEditing(false);
                        setSaveState({ status: "idle", text: "" });
                      },
                    },
                    "取消",
                  )
                : null,
              editing
                ? react.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dm-btn dm-btn-primary",
                      disabled: !dirty || saveState.status === "saving",
                      onClick: function () { save(target, activeName, text); },
                    },
                    "保存",
                  )
                : react.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dm-btn",
                      onClick: function () {
                        setDraft(function (prev) {
                          var next = Object.assign({}, prev);
                          if (next[key] === void 0) next[key] = file.text;
                          return next;
                        });
                        setEditing(true);
                        setSaveState({ status: "idle", text: "" });
                      },
                    },
                    "编辑",
                  ),
            );

            var content = editing
              ? react.createElement("textarea", {
                  className: "dm-editor",
                  spellCheck: false,
                  value: text,
                  onChange: function (event) {
                    var next = event.target.value;
                    setDraft(function (prev) {
                      var merged = Object.assign({}, prev);
                      merged[key] = next;
                      return merged;
                    });
                  },
                  onKeyDown: function (event) {
                    if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "S")) {
                      event.preventDefault();
                      var current = draft[key];
                      if (current !== void 0 && current !== file.text) save(target, activeName, current);
                    }
                  },
                })
              : react.createElement(
                  "pre",
                  { className: "dm-view" },
                  file.exists ? (file.text === "" ? "(空文件)" : file.text) : "(文件不存在 —— 点「编辑」即可创建)",
                );

            return react.createElement(
              "div",
              { className: "dm-body" },
              tabs,
              tools,
              content,
              note ? react.createElement("p", { className: "dm-note dm-layer-note" }, note) : null,
            );
          };

          /** 一层 = 一行（标题可点开）+ 展开体。 */
          var item = function (target, label, sub, toggleProps, note) {
            var isOpen = open === target;
            return react.createElement(
              "div",
              { className: toggleProps !== null && toggleProps !== void 0 && toggleProps.checked === false ? "dm-item dm-off" : "dm-item", key: target },
              react.createElement(
                "div",
                { className: "dm-row", onClick: function () { toggleOpen(target); }, title: "点击展开：查看并编辑" },
                react.createElement(
                  "div",
                  { className: "dm-main" },
                  react.createElement(
                    "span",
                    { className: "dm-name" },
                    react.createElement("span", { className: "dm-caret", "data-open": isOpen ? "true" : "false" }, "▶"),
                    label,
                  ),
                  react.createElement("span", { className: "dm-sub" }, sub),
                ),
                toggleProps === null || toggleProps === void 0
                  ? null
                  : react.createElement(Toggle, {
                      checked: toggleProps.checked,
                      onToggle: toggleProps.onToggle,
                      label: toggleProps.label,
                    }),
              ),
              isOpen ? renderBody(target, note) : null,
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
                  {
                    checked: enabled,
                    onToggle: function () {
                      var next = Object.assign({}, projectEnabled);
                      next[slug] = !enabled;
                      return setting.set("projectEnabled", next);
                    },
                    label: shortName(slug) + " 记忆开关",
                  },
                  "项目层在每个会话的提示词组装时实时重读：保存后下一条消息即生效。MEMORY.md 是注入入口（索引），其余 .md 是按需读取的主题文件。",
                );
              });

          return react.createElement(
            "section",
            { className: "dm-pane" },
            react.createElement("h2", { className: "dm-title" }, "记忆"),
            react.createElement(
              "p",
              { className: "dm-intro" },
              "三层内容：全局规则文件（所有会话都读）+ 全局记忆 + 按工作区的项目记忆。" +
                "点任意一行即可展开正文并就地编辑保存；开关关掉的那一层不再注入系统提示词，再次开启时立即重新读取文件。",
            ),
            react.createElement("h3", { className: "dm-group-title" }, "全局规则文件"),
            react.createElement(
              "div",
              { className: "dm-group" },
              item(
                "rules",
                "AGENTS.md",
                "~/.dsh/AGENTS.md · 全局指令（每个新会话开头注入）",
                null,
                "AGENTS.md 由 DSH 原生的 workspace instructions 读取：改完对新会话生效（当前会话不一定立刻重读）。",
              ),
            ),
            react.createElement("h3", { className: "dm-group-title" }, "全局层（跨项目）"),
            react.createElement(
              "div",
              { className: "dm-group" },
              item(
                "global",
                "全局记忆",
                "~/.dsh/memory.md · 用户偏好 / 环境事实 / 通用坑",
                {
                  checked: globalEnabled,
                  onToggle: function () { return setting.set("globalEnabled", !globalEnabled); },
                  label: "全局记忆开关",
                },
                "每次提示词组装都重读该文件：保存后下一条消息即生效，无需重启。保存前若内容有变化，旧版本自动留一份 memory.md.bak。",
              ),
            ),
            react.createElement("h3", { className: "dm-group-title" }, "项目层（按工作区）"),
            react.createElement("div", { className: "dm-group" }, projects),
            react.createElement("h3", { className: "dm-group-title" }, "注入方式"),
            react.createElement(
              "div",
              { className: "dm-limit" },
              react.createElement(
                "p",
                { className: "dm-limit-desc" },
                "索引模式（默认）：提示词里只放「片 · 条数 · 路径 · 条目标题与行号」，正文按需读取 —— 记忆再长，每轮注入开销也恒定。" +
                  "全文注入：把每片正文整篇放进提示词（超预算时保头部 + 附溢出索引）。",
              ),
              react.createElement(
                "div",
                { className: "dm-chips" },
                [["index", "索引模式（默认）"], ["full", "全文注入"]].map(function (pair) {
                  return react.createElement(
                    "button",
                    {
                      key: pair[0],
                      type: "button",
                      className: injectModeValue === pair[0] ? "dm-chip dm-chip-on" : "dm-chip",
                      onClick: function () { return setting.set("injectMode", pair[0]); },
                    },
                    pair[1],
                  );
                }),
              ),
              injectModeValue === "index"
                ? null
                : react.createElement(
                    "div",
                    { className: "dm-chips" },
                    react.createElement("span", { className: "dm-limit-desc" }, "字符预算"),
                    [[24000, "24K"], [48000, "48K"], [96000, "96K"], [0, "不限制"]].map(function (pair) {
                      return react.createElement(
                        "button",
                        {
                          key: String(pair[0]),
                          type: "button",
                          className: maxCharsValue === pair[0] ? "dm-chip dm-chip-on" : "dm-chip",
                          onClick: function () { return setting.set("maxChars", pair[0]); },
                        },
                        pair[1],
                      );
                    }),
                    react.createElement("input", {
                      type: "number",
                      className: "dm-num",
                      min: 0,
                      step: 1000,
                      value: String(maxCharsValue),
                      title: "自定义上限（字符，0 = 不限制）",
                      onChange: function (e) {
                        var n = Number(e.target.value);
                        if (Number.isFinite(n) && n >= 0) setting.set("maxChars", Math.floor(n));
                      },
                    }),
                  ),
            ),
            react.createElement("h3", { className: "dm-group-title" }, "写入 / 读取钩子"),
            react.createElement(
              "div",
              { className: "dm-limit" },
              react.createElement(
                "p",
                { className: "dm-limit-desc" },
                "写入钩子挂在 DSH 工具管线上：agent 用 write/edit/bash 改记忆文件时先经钩子判定——" +
                  "条目格式错、疑似凭据、覆盖历史、写错位置会被直接拒绝（原因回到模型面前），可疑改动转人工确认。" +
                  "读取钩子在注入层强制附加记忆纪律，并在读取记忆文件时附加提醒。",
              ),
              react.createElement(
                "div",
                { className: "dm-chips" },
                react.createElement("span", { className: "dm-limit-desc" }, "写入守卫"),
                [["rules", "规则引擎（默认）"], ["full", "规则 + 外部命令"], ["off", "关闭"]].map(function (pair) {
                  return react.createElement(
                    "button",
                    {
                      key: pair[0],
                      type: "button",
                      className: writeGuardValue === pair[0] ? "dm-chip dm-chip-on" : "dm-chip",
                      onClick: function () { return setting.set("writeGuard", pair[0]); },
                    },
                    pair[1],
                  );
                }),
              ),
              writeGuardValue !== "full"
                ? null
                : react.createElement(
                    "div",
                    { className: "dm-chips" },
                    react.createElement("span", { className: "dm-limit-desc" }, "外部判定命令（stdin 进 payload JSON；exit 2 = 拒绝，stdout JSON {decision,reason} 出决策，可接任意 LLM 脚本）"),
                    react.createElement("input", {
                      type: "text",
                      className: "dm-cmd",
                      value: writeHookCommandValue,
                      placeholder: "例如：node ~/bin/memory-judge.mjs",
                      onChange: function (e) { return setting.set("writeHookCommand", e.target.value); },
                    }),
                  ),
              react.createElement(
                "div",
                { className: "dm-hookrow" },
                react.createElement(
                  "div",
                  null,
                  react.createElement("div", { className: "dm-hookrow-label" }, "读取纪律块"),
                  react.createElement("div", { className: "dm-hookrow-sub" }, "注入层末尾强制附加「记忆纪律」：值不值得记、条目格式、按行号读取、钩子会拒绝什么"),
                ),
                react.createElement(Toggle, {
                  checked: disciplineValue,
                  label: "读取纪律块",
                  onToggle: function () { return setting.set("discipline", !disciplineValue); },
                }),
              ),
              react.createElement(
                "div",
                { className: "dm-hookrow" },
                react.createElement(
                  "div",
                  null,
                  react.createElement("div", { className: "dm-hookrow-label" }, "读取提醒"),
                  react.createElement("div", { className: "dm-hookrow-sub" }, "read 命中记忆文件时附加提醒：条目数/字符数、禁止凭索引臆测、过时就地修正"),
                ),
                react.createElement(Toggle, {
                  checked: readReminderValue,
                  label: "读取提醒",
                  onToggle: function () { return setting.set("readReminder", !readReminderValue); },
                }),
              ),
              react.createElement(
                "div",
                { className: "dm-hookrow" },
                react.createElement(
                  "div",
                  null,
                  react.createElement("div", { className: "dm-hookrow-label" }, "写入审计"),
                  react.createElement("div", { className: "dm-hookrow-sub" }, "每次记忆写入落盘后记一行 JSONL 到 ~/.dsh/memory/audit.log（谁、何时、增删几行、判定结果）"),
                ),
                react.createElement(Toggle, {
                  checked: auditValue,
                  label: "写入审计",
                  onToggle: function () { return setting.set("audit", !auditValue); },
                }),
              ),
              react.createElement(
                "div",
                { className: "dm-chips" },
                react.createElement("span", { className: "dm-limit-desc" }, "注入过滤命令（可选；stdin 进注入文本、stdout 出过滤结果，失败回落原文）"),
                react.createElement("input", {
                  type: "text",
                  className: "dm-cmd",
                  value: injectHookCommandValue,
                  placeholder: "留空 = 不过滤",
                  onChange: function (e) { return setting.set("injectHookCommand", e.target.value); },
                }),
              ),
            ),
            react.createElement(
              "p",
              { className: "dm-note" },
              "开关状态存 ~/.dsh/settings.yaml 的 dsh-memory 节；项目列表由 host 扫描 ~/.dsh/memory/projects/ 自动维护；" +
                "正文读写由 host 的 /dsh-memory/content 与 /dsh-memory/write 提供（路径白名单，越不出记忆目录与规则文件）。",
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
