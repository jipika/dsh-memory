# dsh-memory

> Progressive long-term memory for **DeepSeek Harness (DSH)** — memory lives as sharded plain
> markdown, and only a **live-generated index** enters the system prompt, so the prompt cost
> stays flat however large the memory grows. Two layers (global + per-project) plus the global
> rule files, **viewable and editable right in DSH Settings**, **zero extra LLM cost**, live re-read.
>
> 给 DeepSeek Harness 的**渐进式长期记忆**：正文是分片的纯 markdown，进系统提示词的只有
> **实时生成的索引**（片 · 条数 · 路径 · 条目行号），记忆再长、提示词开销也恒定。两层结构
> （全局层 + 项目层）外加全局规则文件，**在设置里就能查看并编辑**、**不产生任何额外 LLM 调用**、写完即生效。

[![npm](https://img.shields.io/npm/v/@jipika/dsh-memory?label=npm)](https://www.npmjs.com/package/@jipika/dsh-memory)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DSH 1024Store](https://img.shields.io/badge/DSH%201024Store-listed-10B981)](https://deepseek1024.com/)

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

- **两层**：`~/.dsh/memory/topics/*.md`（全局，按主题分片：用户偏好 / 环境事实 / 通用坑……）
  + 按工作区分级的项目层，切换项目自动切换内容。
- **零 LLM 成本**：插件本身不调用任何模型，只读文件；写记忆用的是会话已经在跑的那个模型。
- **写完即生效**：注册的是**函数式** `text`，每次提示词组装都重读文件 —— 不需要重启、不需要刷新。
  （对比：`cordis.patch.yml` 里 `personaPrefix` 的 `!!js` 只在 boot 求值一次。）
- **渐进式注入，记忆再长也不炸上下文**：注入的是**实时生成的索引** —— 每片一行
  「片名 · 条数 · 体量 · 路径」，片内每条一行「标题 + 行号」；需要细节时 agent 按行号 `read`
  那一片即可。索引每次组装现算，所以**永远不会和正文脱节**，正文怎么长、注入体积都恒定。
  实测：把 58k 字符的记忆分成 10 片后，每轮注入从 **29931 → 约 6.6k 字符**。
  想要老行为？设置 → 记忆 →「注入方式」切成**全文注入**（保留字符预算，超预算时给溢出索引）。
- **设置面板可读可写**：DSH 设置里多一个「记忆」分栏 —— 每层一个开关，点标题即可展开正文，
  还能**就地把改动保存回文件**（保存前自动留一份 `.bak`）。全局层按片一个页签；同一个分栏里
  可以查看并编辑**全局规则文件** `~/.dsh/AGENTS.md`。
- **明文、可移植**：就是 markdown。可以 git、可以 diff、可以手改；删掉文件即停用（段渲染为空串，
  被 `renderPrompt()` 过滤，零残留）。

## 安装

### 从 npm（推荐）

已发布为 `@jipika/dsh-memory`，也收录在 [DSH 1024Store](https://deepseek1024.com/) 目录里：

```bash
dsh plugin --profile web add @jipika/dsh-memory
```

本插件自带 `cordis.patch.yml`（`package.json` 里声明了 `dsh.bundle.patch`），安装时 DSH 会自动把它
挂进 profile 的组合树，**不需要手工编辑任何 profile 文件**。

### 从源码（想改代码时）

```bash
git clone https://github.com/jipika/dsh-memory.git ~/.dsh/local-plugins/dsh-memory
```

然后以 `link:` 方式挂进 profile（以 `desktop` 为例）：

```bash
# 1) 依赖（~/.dsh/profiles/desktop/package.json）
#    "@jipika/dsh-memory": "link:../../local-plugins/dsh-memory"

# 2) 挂载（~/.dsh/profiles/desktop/cordis.patch.yml 末尾追加）
#    - insert:
#        - id: dsh-memory
#          name: '@jipika/dsh-memory'

cd ~/.dsh/profiles/desktop && pnpm install
```

> 装完后若是 `link:` 方式，`pnpm install` 会重建 node_modules 链接并把 HMR 的基线路径换掉 —— 建议
> **重启一次 DSH**（host 半在 boot 时加载）。之后改记忆、翻开关都不再需要重启。

## 记忆文件布局

```
~/.dsh/memory/topics/                            ← 全局层：按主题分片（**新记忆写这里**）
  ├── preferences.md                             ← 用户偏好
  ├── dsh-platform.md                            ← 环境 / 平台事实
  └── …                                          ← 想加几片就加几片，索引自动收录
~/.dsh/memory.md                                 ← 导航索引（人读用；注入不读它）
~/.dsh/AGENTS.md                                 ← 全局规则（新会话注入，面板里也能编辑）
~/.dsh/memory/projects/
  ├── --Users-me-code-repo--/                    ← 项目层：目录形式
  │   ├── MEMORY.md                              ← 索引（同样只注入索引 + 行号）
  │   ├── some-topic.md                          ← 主题正文，按需读
  │   └── another-topic.md
  └── --Users-me-other-repo--.md                 ← 项目层：单文件形式（同样支持）
```

两种形态都支持：**有分片目录就按分片走，没有就回落到单文件** —— 所以从单文件迁移到分片
（或反过来）都不需要改配置。分片的片名优先取文件里的 H1 标题。

> **项目层两种形态的注入方式刻意不同**（这点踩过坑）：**单文件形式**的内容本身就是条目集合
> （`- [日期] 事实`），所以走索引化、只给标题与行号；**目录形式**里 `MEMORY.md` 已经是人写的
> 索引、其余 `.md` 是带 frontmatter 的正文段落，所以直接注入 `MEMORY.md` 正文（标题 + 链接 +
> 摘要，超长时仍走 clamp），另外只列出**没被索引登记的**正文文件 —— 顺带当索引一致性检查用。
> 反过来对正文再套一遍条目索引，只会退化成一张纯路径清单（实测某项目 74 篇正文被压成
> 14340 字符的文件列表，而 `MEMORY.md` 的摘要一条都没进来）。

> 从单文件迁移过来：`tools/migrate-to-shards.mjs` 是当时用的迁移脚本（人工语义分类 + 生成
> 导航文件 + 先备份），可以按自己的分类改写它。

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
  · GLOBAL  `~/.dsh/memory/topics/*.md` — facts that would bite in ANY repo,
    sharded by topic (each file starts with a comment saying what belongs there).
    `~/.dsh/memory.md` is only a navigation index — never append memory to it.
  · PROJECT `~/.dsh/memory/projects/--<cwd-with-slashes-as-dashes>--.md` — facts
    that only hold in this workspace.
- What the prompt shows is an INDEX (shard · count · path), not the full text:
  read that shard when you need the detail. Index lines carry line numbers.
- Append one line `- [YYYY-MM-DD] fact` under the matching section, in the SAME
  turn you learn it. Do not batch for "later". Keep each shard small (~12k chars)
  — when one outgrows that, split it by sub-topic in the same directory.
- Do NOT log narration or anything re-derivable from the repo.
- NEVER put secrets in it — both layers ride every request to the model provider.
- Record what IS true, never a removal: "X was uninstalled" is stale the moment
  it is written and taxes every future session.
```

## 设置面板

设置里会出现一个「记忆」分栏，三组内容：

| 分组 | 条目 | 可编辑的文件 |
|---|---|---|
| 全局规则文件 | AGENTS.md（无开关） | `~/.dsh/AGENTS.md` |
| 全局层（跨项目） | 全局记忆（带开关） | `~/.dsh/memory/topics/*.md`（一片一个页签） |
| 项目层（按工作区） | 每个项目一行（带开关） | 该项目目录下的全部 `.md`（`MEMORY.md` + 主题文件） |

- 点任意一行展开：先看到只读正文，点「编辑」变成可写的编辑器，`⌘/Ctrl + S` 或「保存」写回文件。
- 一层里有多个文件时（项目记忆的主题文件），用页签切换；**未保存的页签带 `●`**。
- 保存是**原子写**（先写临时文件再 rename），改动前的内容自动留一份 `<文件名>.bak`；
  新建的文件用 `0600`，已有文件沿用原权限。
- `AGENTS.md` 的生效时机（面板底部也写了）：它在每个新会话开头注入，改完对**新会话**生效。
- 记忆两层是**每次提示词组装时实时重读**的：保存后下一条消息就带上新内容，不需要重启。
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
- 两条 HTTP 路由（读写共用同一个白名单解析函数，越不出记忆目录与规则文件）：

```http
GET  /dsh-memory/content?target=global|rules|<slug>[&file=<名>][&format=text]
POST /dsh-memory/write   { target, file, text }     # 需请求头 x-dsh-memory: 1
```

`target` 只认 `global`（`~/.dsh/memory/topics/*.md`，无分片时回落 `~/.dsh/memory.md`）、
`rules`（`~/.dsh/` 下的两个规则文件）、
或形如 `--Users-me-code-repo--` 的项目 slug；`file` 只认该层里真实存在的 `.md`（或 `MEMORY.md` 新建）。
写路由要求 `x-dsh-memory: 1` —— 浏览器跨站简单请求带不上自定义头，省掉一整类 CSRF。

## 验证

```bash
node tests/probe.mjs
```

93 项断言，全部在**临时 HOME** 里跑（自造记忆文件，不碰你的真实数据），覆盖：两层注入、
cwd→slug 推导、无 agent 时只注入全局、两个开关的开/关/重开、**索引模式**（片名取文件 H1、
条目带行号、分片目录优先于单文件、`injectMode=full` 时回退全文、超预算时给溢出索引）、
注入前拆开 `{{`（否则整段组装会被 `dsh-system-prompt` 当未知变量抛错）、读路由（层内文件清单、AGENTS.md、
单文件形式、路径穿越被拒）、写路由（原子写、`.bak` 回滚点、权限保留、首次建 MEMORY.md、内容未变不重复写、
白名单外写不进去、缺 `x-dsh-memory` 头 → 403），以及设置面板的渲染与「展开 → 编辑 → 保存」全流程。

## 兼容性

依赖 DSH 的以下既有 seam：`systemPrompt.section()`（函数式 text）、`settings.register()`、
`webServer.register()`、client 的 `settings.section` 槽位与 `settingsScope.bind()`。
在 DSH Desktop 2.0.13 / dsh core 0.1.5-rc.2 上验证通过。

## License

MIT
