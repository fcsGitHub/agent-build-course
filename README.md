# 🔬 AgentGlass · Agent 原理可观测实验室

> 能运行、能拆开、能修改、能对照、能回放的 Agent 实验室。
> 同一次真实运行，从任务、源码、信息流、模型可见上下文、工具副作用与成本多个角度观察——所有视图指向同一份运行证据。

**当前版本 R6b** · 46 门课程（L00—L45）· 本地单机运行，无需 Docker · 逐版本增量见 [docs/CHANGELOG.md](docs/CHANGELOG.md)

---

## ✨ 核心特性

一次完整的教学闭环：**配模型 → 开课程 → 发任务 → 观察运行 → 改代码 → 再运行对照 → 导出回放**

- **真实执行优先** —— 真实模型调用、真实工具执行、完整事件账本；模拟一律显式标注（provider=fake），绝不冒充实时运行
- **用户主导对话** —— 打开课程零模型调用；课程案例提示只入草稿，是否发送永远由你决定
- **多角度观察同一份证据** —— 架构图 / 信息流 / 代码 / 上下文 / 运行五个页签，全部指向同一事件账本
- **上下文透视** —— 逐轮查看模型实际收到的完整消息、未选入清单（逐条给出预算/策略排除原因）、⇄ 与上一轮的新增/移除对比
- **断点与单步** —— 在流程图上对「模型调用 / 工具执行 / 停止判定 / 图节点」设断点，或「⏯ 单步」逐轮驻留；观察与思考时间豁免墙钟预算
- **多 Agent 全链可观测** —— worker 事件按 workerId 分槽、委派/移交/结果回收卡、Σ 合并输出、上下文隔离一屏可见
- **受控代码实验** —— 服务端权限 + AST patch-guard + 隔离构建与执行；「采用」新版本即与旧版本形成天然对照
- **断网回放** —— 导出脱敏 `.agtrace.zip`，离线逐事件回放（含框图时间旅行）；**回放不执行任何代码**

## 🚀 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.5 | 内置 `node:sqlite`，无需单独装数据库 |
| pnpm | ≥ 9 | `corepack enable` 可直接启用 |
| 操作系统 | Windows / macOS / Linux | 本地单机模式 |

### 一条命令跑起来

```bash
pnpm install
AGENTGLASS_SEED_FAKE=1 pnpm dev
```

打开 **http://localhost:5173** 即可使用。`AGENTGLASS_SEED_FAKE=1` 会注册一个**显式标记为「模拟」**的确定性教学模型（provider=fake），无需任何 API Key 即可完成 L04—L07 的完整工具循环演示；不设置该变量、或只打开课程，都不会产生模型调用。

> Windows PowerShell：`$env:AGENTGLASS_SEED_FAKE="1"; pnpm dev` ｜ CMD：`set AGENTGLASS_SEED_FAKE=1 && pnpm dev`

### 其他启动方式

| 方式 | 命令 | 访问入口 |
|---|---|---|
| 分进程开发 | `pnpm dev:api` ＋ `pnpm dev:worker`（可选 `pnpm dev:web` 前端热更新） | http://127.0.0.1:8787 |
| 生产模式 | `pnpm build` → `pnpm start` ＋ 另一终端 `pnpm --filter @agentglass/worker start` | http://127.0.0.1:8787 |

> ⚠️ Worker 必须启动，否则任务只会排队不会执行。不启动 `dev:web` 时，8787 自带打包好的 Web UI。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENTGLASS_DATA` | `<仓库根>/data` | 数据目录：SQLite、blob、运行工作区、代码修订 |
| `AGENTGLASS_LESSONS` | `<仓库根>/lessons` | 课程目录（46 门 L00—L45） |
| `AGENTGLASS_PORT` | `8787` | API 监听端口（绑定 127.0.0.1） |
| `AGENTGLASS_SEED_FAKE` | 未设置 | 设为 `1` 时注册 provider=fake 的教学模拟模型（UI/事件显式标注「模拟」） |
| `AGENTGLASS_URL` | `http://127.0.0.1:8787` | CLI 访问的 API 地址 |
| `<自定义名>`（如 `BIGMODEL_API_KEY`） | — | 真实模型密钥。平台只保存 `secretRef=env:变量名` 引用，**密钥本体不落库**，调用前经环境变量解析 |

数据（运行账本、事件、blob、代码修订）持久化在 `data/`，删除该目录即完全重置。备份与恢复：`pnpm backup`（数据库 + blob 成对打包，逐文件 sha256 清单）/ `pnpm restore -- --from backups/<目录> --to data`。

## 🔌 接入真实模型

1. **配置**：「设置」页新增模型配置——`openai-compatible`（/chat/completions）或 `anthropic`（/v1/messages），填 endpoint 与 model id，密钥引用填 `env:你的环境变量名`
2. **探测**：点「探测」发送少量真实请求，回写能力矩阵（流式 / 原生工具 / 结构化输出 / 用量统计）——能力以实测为准，不虚报
3. **使用**：探测通过后，在实验台右上角切换使用

<details>
<summary><b>以 DeepSeek 为例（点击展开，含排障对照表）</b></summary>

```bash
# 1. 设置密钥环境变量（在启动服务的终端里；PowerShell: $env:AGENTGLASS_OPENAI_API_KEY="sk-…"）
export AGENTGLASS_OPENAI_API_KEY=sk-你的密钥

# 2. 启动（或重启）服务
AGENTGLASS_SEED_FAKE=1 pnpm dev
```

3. 「设置」页新增配置：提供方 `openai-compatible`，Endpoint `https://api.deepseek.com`，模型 ID `deepseek-flash`（以 `GET https://api.deepseek.com/models` 实际返回为准），密钥引用 `env:AGENTGLASS_OPENAI_API_KEY`
4. 点「探测」——五项全过即可切换使用。密钥列显示掩码（如 `sk-…eca`）表示服务进程能读到该变量；显示红色 `[MISSING]` 表示读不到

**探测报错对照**：

| 报错 | 含义 | 处理 |
|---|---|---|
| `SECRET_MISSING: 密钥引用 env:… 未设置或为空` | 服务进程读不到该环境变量 | 在启动 API 与 worker 的终端设置变量后**重启服务**，再探测 |
| `401 Authentication Fails` | 密钥被云端拒绝（变量读到了但值不对/失效） | 核对变量值；`curl https://api.deepseek.com/models -H "authorization: Bearer sk-…"` 验证密钥 |
| 模型相关 404/400 | 模型 ID 不存在 | 用 `GET /models` 查该端点实际可用的模型 ID |

> 密钥引用必须以 `env:` 开头——直接把密钥本体粘贴进「密钥引用」会被拒绝（密钥本体不落库，也是排障时最常见的 401 来源）。
>
> anthropic 协议已实测 BigModel 兼容路由 `https://open.bigmodel.cn/api/anthropic` + GLM 系列（适配器默认关闭思考，配置参数 `parameters.thinking="enabled"` 可开启）。

</details>

## 🖥️ 实验台

双分区布局（窄屏自动堆叠）：

- **左 · 对话区**：主流 GUI agent 式对话流——流式打字机输出（生成中显示计时与片段数）、回合分组（一次模型调用=一回合，回合头标注输入估算 token）、多 agent 通信窄卡（委派/移交/结果回收/MCP/A2A/技能加载）、工具活动单行卡（点击展开真实参数与工件）、审批卡（高影响写入 inline 批准/拒绝）、智能吸底（上翻阅读时停止跟随）
- **右 · 观察区**：五个页签共享同一份事件账本——**架构**（按课程 manifest 生成的 SVG 框图，事件计数点亮、边线流动、活动节点脉冲）、**信息流**（真实事件作为信息包沿边移动动画，多 agent 按 worker 精确路由）、**代码**（草稿 → 校验 → 采用，版本化对照）、**上下文**（token 组成条、完整消息卡、未选入清单、⇄ 轮间对比、一键复制 JSON）、**运行**（用量/预算/版本/子 agent 统计）

**运行控制**：运行中可「中断」；开放代码的课程可「暂停并改代码」（草稿独立于活动运行）；图上点击可断节点设断点（多次命中间保持、按课程记忆），「⏯ 单步」即逐轮驻留，点「恢复」继续。「导出」下载脱敏 `.agtrace.zip`，「回放」页离线逐事件步进（0.5×—4× 变速、进度条拖拽、←/→ 步进、空格播放暂停）。

### CLI

```bash
pnpm cli doctor                                  # 环境自检
pnpm cli lesson run --lesson L05-observe-act     # 未给 --input 时交互式等待用户输入
pnpm cli run events RUN_ID --follow              # 跟踪事件账本
pnpm cli run export RUN_ID --out run.agtrace.zip # 导出脱敏运行包
pnpm cli replay run.agtrace.zip                  # 离线回放（不执行任何代码）
```

CLI 与 Web 走同一 API、同一事件账本、同一退出码语义。

## 📚 课程：46 门 · 九个阶段

从「第一次调用」到「有界 RSI 循环」。**打开课程零模型调用**；案例提示只显示为输入框上方的 chips，点击仅插入草稿。

| 阶段 | 课程 | 主题 |
|:---:|---|---|
| I | L00—L07 | 基础闭环：第一次调用、Prompt、结构化输出、流式、工具循环、观察-行动、停止条件、并行工具调用 |
| II | L08—L16 | 工作流与知识层：固定工作流、导入/检索/Agentic RAG、Wiki、上下文预算、压缩、长期记忆 |
| III | L17—L18 | 记忆种类（情节/语义/程序性）、技能包与渐进加载 |
| IV | L19—L21 | 计划图、状态图、写入前审批 |
| V | L22—L29 | 本地 MCP（含注入防护）、Harness、CLI/Web 一致性、沙箱编码修复、受控联网、数据注入防护、评测与故障注入 |
| VI | L30—L34 | 多 Agent：移交链、并行 worker、黑板冲突、A2A 远程协作、同预算架构对照 |
| VII | L35—L40 | 有界递归、反思重试、经验 Wiki、提示候选评测、技能演进门控、训练接口与诚实边界 |
| VIII | L41 | 毕业实验：带证据的研究与文档 Agent（读取→审批写入→引用作答） |
| IX | L42—L45 | 前沿与 RSI：前沿全景、上下文工程、DeepResearch 式多源研究、有界 RSI 循环 |

## 🧱 仓库结构

| 位置 | 内容 |
|---|---|
| `packages/contracts` | 公共 TypeScript 合同（runtime/events/context/model/code-edit/conversation/lesson/tools） |
| `packages/skills` | R2 技能注册表：安装、三层加载、脚本授权边界 |
| `packages/mcp` | MCP：stdio client + 远程 HTTP client（streamable JSON-RPC、会话、Bearer、SSRF 防护）、课程 server（.mjs 零依赖）、工具映射 |
| `packages/a2a` | A2A 远程 Agent 协议：agent card、message/send、任务查询/取消、artifact 校验、工具映射 |
| `packages/harness` | Harness：HookRegistry 固定阶段（超时/失败策略/diff）与长期任务进展 |
| `packages/multi-agent` | 多 Agent 协调器与有界递归：三拓扑、原子预算共享、因果链、黑板冲突合并；递归树深度/节点硬上限 |
| `packages/evaluation` | 评测服务：冻结切分、确定性评分、配对对照 |
| `packages/evolution` | 演进层：反思服务、技能候选四道门控、提示候选选优、诚实训练接口 |
| `packages/tools` | 工具代理：注册表、schema 校验、read_text（路径/符号链接防逃逸）、calculator（无 eval）、http_fetch（白名单 + SSRF 防护）、run_test 编码沙箱执行器、效果账本 |
| `packages/runtime-graph` | 状态图运行时：校验器 + 执行器（model/tool/transform/gate 节点、注册谓词、访问上限） |
| `packages/knowledge` | 知识层：切块、embedding（fake/真实）、索引快照、BM25/向量/RRF 检索、引用校验、Wiki、记忆 |
| `packages/db` | SQLite 迁移与连接（本地模式；多人版换 PG 适配器，schema 合同不变） |
| `packages/events` | 事务事件账本 + outbox + 内容寻址 blob 存储 |
| `packages/policy` | 共享原子预算账本、秘密引用（env）、审批绑定摘要 |
| `packages/provider-gateway` | 模型网关：openai-compatible（流式 SSE、wire capture）+ anthropic（/v1/messages SSE）+ fake（显式模拟）+ 能力探测 |
| `packages/context` | 上下文编译器：候选池 → 原子组保护 → 预算选择（含选入/排除原因） |
| `packages/runtime-reference` | 透明参考循环：控制门（暂停/取消边界）、扩展点、检查点、有界 RSI 运行器 |
| `packages/conversation` | 会话与输入队列：幂等键、排队/替换/撤回、会话前缀冻结 |
| `packages/code-lab` | 受控代码实验：AST patch-guard、草稿、隔离构建（esbuild 虚拟文件）、校验报告六摘要绑定 |
| `packages/lessons` | 课程注册表 + 发布 linter（拒绝 auto_send / 默认对话剧本） |
| `packages/projections` | 纯函数投影 reducer + 证据联动 |
| `packages/replay` | 回放会话 + .agtrace.zip 导出/导入（fflate） |
| `apps/api` `apps/worker` `apps/cli` `apps/web` | 四个入口，共用上述合同 |
| `workers/learner-runtime` | 学习者代码隔离客体（fork 子进程 + IPC + 硬超时 watchdog） |
| `lessons/L00—L45` | 46 门课程（阶段 IX 为前沿与 RSI） |
| `tests/` | unit / contract / integration / security / fault / e2e（真实 HTTP 注入） |

## 🛡️ 安全边界（自 R0 起为硬约束）

- **模型外安全**：工具权限由代理校验（白名单 ∩ 注册表 ∩ schema），工具描述不能自授权限；预算为共享原子账本，学生策略不能突破宿主硬上限。
- **学习者代码隔离**：开放面由服务端 `LessonEditPolicy` + AST 检查（函数签名/导入集合/函数体外零改动）；构建走 esbuild 虚拟文件（禁外部模块解析）+ 五道安全门槛；执行在无秘密的子进程客体中，忙等被硬超时杀死。
- **版本不可变**：`AgentRevision` 构建后登记，校验报告绑定 `sourceDigest/baseManifestId/editPolicyDigest/toolchainDigest/testSuiteDigest/bundleDigest` 六元组；活动运行不受草稿影响。
- **回放不执行**：reducer 为纯函数；`.agtrace.zip` 导入检查路径穿越/尺寸/摘要；导出保留引用元信息。
- **诚实标记**：fake 模型运行在事件与 UI 显式标注「模拟」；未配置模型不能发起实时运行；跳过的测试不能写成通过。

## ✅ 测试与发布检查

```bash
pnpm lint                 # 全仓 typecheck（strict）
pnpm test                 # 213 个测试 + 2 个显式跳过（42 个测试文件：unit/contract/integration/security/fault/e2e/performance/live）
pnpm verify:lessons       # 课程发布 linter
pnpm verify:source-bindings
pnpm verify:trace-bundles
pnpm backup               # 备份 data/（db+blob 成对，sha256 清单）
pnpm restore -- --from backups/<目录> --to data   # 校验后成对恢复
```

`test:live`（真实模型冒烟）需要显式配置模型并设置预算后单独运行，不混入常规 CI。

## 📖 文档索引

| 文档 | 内容 |
|---|---|
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | **版本说明**：R0 → R6b 逐版本增量、与设计文档的对应 |
| `doc/AgentGlass_Agent教学软件_设计方案与开发计划_v1.1.md` | 设计基线 |
| `docs/adr/` | 架构决策记录（运行时边界、学习者代码隔离、SQLite 本地模式、输入与编辑语义、能力矩阵诚实降级） |
| `docs/teacher-guide/` | 教师指南（46 门课程课前准备、无网络课堂方案） |
| `docs/operations/runbook.md` | 运维手册（健康检查、备份恢复、回放负载基准） |
