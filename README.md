# dsh-memory

> Two-layer long-term memory for **DeepSeek Harness (DSH)** — global + per-project, plain
> markdown, **zero extra LLM cost**, effective the moment you write.
>
> 给 DeepSeek Harness 的**两层长期记忆**：全局层 + 项目层，纯 markdown、明文可编辑、
> **不产生任何额外 LLM 调用**，写完即生效。

---

## 它解决什么

Agent 每次会话都是失忆的。让记忆活下来通常只有两条路：

| 做法 | 代价 |
|---|---|
| 把记忆塞进系统提示词 | 需要"谁来写、写到哪、怎么注入"的一整套机制 |
| 用 LLM 从会话里提炼事实 | 每轮会话都在后台烧钱，且内容进了别人的向量库 |

本插件的取舍是：**记忆就是几个 markdown 文件，注入走 DSH 原生的提示词 seam，写入由当前会话的
agent 顺手完成** —— 于是它既不花钱，也不出本机，还能被 git 跟踪、被人手编辑。

## 特性

- **两层**：`~/.dsh/memory.md`（全局：用户偏好 / 环境事实 / 通用坑）+ 按工作区分级的项目层，
  切换项目自动切换内容。
- **零 LLM 成本**：插件本身不调用任何模型，只读文件；写记忆用的是会话已经在跑的那个模型。
- **写完即生效**：注册的是**函数式** `text`，每次提示词组装都重读文件 —— 不需要重启、不需要刷新。
  （对比：`cordis.patch.yml` 里 `personaPrefix` 的 `!!js` 只在 boot 求值一次。）
- **索引注入，不炸上下文**：项目记忆只注入 `MEMORY.md`（一个 `- [标题](文件.md) — 摘要` 的索引），
  主题正文按需读。上千行的记忆库也只占固定的索引体积。
- **设置面板**：DSH 设置里多一个「记忆」分栏 —— 每层一个开关，**点标题即可展开看正文**。
- **明文、可移植**：就是 markdown。可以 git、可以 diff、可以手改；删掉文件即停用（段渲染为空串，
  被 `renderPrompt()` 过滤，零残留）。

## 安装

```bash
git clone https://github.com/jipika/dsh-memory.git ~/.dsh/local-plugins/dsh-memory
```

然后把它加进你的 profile（以 `desktop` 为例）：

```bash
# 1) 依赖（~/.dsh/profiles/desktop/package.json）
#    "dsh-memory": "link:../../local-plugins/dsh-memory"

# 2) 挂载（~/.dsh/profiles/desktop/cordis.patch.yml 末尾追加）
#    - insert:
#        - id: dsh-memory
#          name: 'dsh-memory'

cd ~/.dsh/profiles/desktop && pnpm install
```

重启 DSH 一次（host 半在 boot 时加载），之后所有改动都是实时的。

## 记忆文件布局

```
~/.dsh/memory.md                                  ← 全局层（整个文件注入）
~/.dsh/memory/projects/
  ├── --Users-me-code-repo--/                     ← 项目层：目录形式
  │   ├── MEMORY.md                               ← 注入这一份（索引）
  │   ├── some-topic.md                           ← 主题正文，按需读
  │   └── another-topic.md
  └── --Users-me-other-repo--.md                  ← 项目层：单文件形式（同样支持）
```

项目层目录名由会话的 `cwd` 推出，规则与 DSH 自己的会话目录一致——路径里的 `/` 换成 `-`，
两端各加 `--`：

```
/Users/me/code/repo   →   --Users-me-code-repo--
```

所以 `~/.dsh/sessions/--Users-me-code-repo--/` 与 `~/.dsh/memory/projects/--Users-me-code-repo--/`
是同一个项目的两份数据，一眼能对上。

## 记忆怎么写

由 agent 顺手写（这也是"零 LLM 成本"的来源：写入搭的是本来就跑着的会话）。建议在
`~/.dsh/AGENTS.md` 里放几条纪律，例如：

```markdown
Memory upkeep (long-term memory):
- TWO layers, both injected on every assembly (no restart needed):
  · GLOBAL  `~/.dsh/memory.md` — facts that would bite in ANY repo.
  · PROJECT `~/.dsh/memory/projects/--<cwd-with-slashes-as-dashes>--.md` — facts
    that only hold in this workspace.
- Append one line `- [YYYY-MM-DD] fact` under the matching section, in the SAME
  turn you learn it. Do not batch for "later".
- Do NOT log narration or anything re-derivable from the repo.
- NEVER put secrets in it — both layers ride every request to the model provider.
- Record what IS true, never a removal: "X was uninstalled" is stale the moment
  it is written and taxes every future session.
```

## 设置面板

设置里会出现一个「记忆」分栏：

- 全局层一个开关；项目层每个项目一个开关（项目列表由 host 扫描记忆目录自动维护）。
- **点任意一行的标题即可就地展开该层的正文**（由 host 的只读路由 `/dsh-memory/content` 提供）。
- 关掉的那一层不再注入；再次开启**立即重新读取**文件。
- 开关状态存在 `~/.dsh/settings.yaml` 的 `dsh-memory` 节：

```yaml
dsh-memory:
  globalEnabled: true
  projectEnabled:
    --Users-me-code-repo--: false   # 关掉这个项目的记忆
  knownProjects:                     # host 自动维护，供面板列出
    - --Users-me-code-repo--
```

## 工作原理

```js
ctx.systemPrompt.section({
  name: "dsh-memory:long-term",
  order: 1,              // 紧跟 DEPLOYMENT_PERSONA_PREFIX(order 0)，先于工具规范
  text: compose,         // ← 函数：每次 assemble() 重新求值
});
```

`compose()` 按当前 `cwd` 决定注入哪些层，并遵守开关；任一层不可用（文件缺失 / 开关关闭）就返回空串，
而空段会被 `dsh-system-prompt` 的 `renderPrompt()` 过滤掉。

插件同时注册：

- 一个 settings namespace（`dsh-memory`）承载开关与自动维护的项目清单；
  host 半用手写 schema —— 插件装在 `node_modules` 之外，解析不到 `schemastery`。
- 一条只读 HTTP 路由 `GET /dsh-memory/content?target=global|<slug>`（`target` 走白名单校验，
  拒绝 `..` 与路径分隔符，无法越出记忆目录）。

## 验证

```bash
node tests/probe.mjs
```

28 项断言，全部在**临时 HOME** 里跑（自造记忆文件，不碰你的真实数据），覆盖：两层注入、
cwd→slug 推导、无 agent 时只注入全局、两个开关的开/关/重开、内容路由（含路径穿越被拒）、
以及面板渲染与行点击展开。

## 兼容性

依赖 DSH 的以下既有 seam：`systemPrompt.section()`（函数式 text）、`settings.register()`、
`webServer.register()`、client 的 `settings.section` 槽位与 `settingsScope.bind()`。
在 DSH Desktop 2.0.13 / dsh core 0.1.5-rc.2 上验证通过。

## License

MIT
