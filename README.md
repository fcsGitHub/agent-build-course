# AgentGlass：Agent 原理可观测实验室（R6 本地实验版）

> 能运行、能拆开、能修改、能对照、能回放的 Agent 实验室。
> 同一次真实运行，从任务、源码、信息流、模型可见上下文、工具副作用与成本多个角度观察；所有视图指向同一份运行证据。

本仓库是《AgentGlass_Agent教学软件_设计方案与开发计划_v1.1》（`doc/`）的 **R0—R6 实现：纵向闭环、知识层、技能/图/审批/MCP/Harness、多 Agent/评测/编码沙箱、反思重试与演进门控、远程协作与全部 46 门课程（含前沿 RSI 阶段）**：
用户实时输入 → 真实模型调用 → 真实工具执行 → 完整事件账本 → 前端修改受控代码 → 隔离校验 → 用户确认再次运行 → 差异观察 → 断网回放。
R5 新增（前沿与可观测性）：**实验台前端重设计**（借鉴 Langfuse/LangSmith 的 trace 视图、Chainlit 的步骤流、Vercel AI Elements 的流式交互）——对话区按「回合」分组（一次模型调用=一回合）、SSE 打字机流式输出、智能吸底；观察区「上下文」检视器逐轮展示组成条、模型实际收到的完整消息卡与未选入清单（逐条给出排除原因）；「⏯ 单步」= turn_end 断点逐轮驻留，暂停横幅一键深链「查看此刻上下文组装」，断点随输入提交原子播种、驻留时间豁免墙钟预算。**流程图断点**——在架构/信息流图上点击「模型调用 / 工具执行 / 停止判定 / 图节点」即可设断点，运行到达目标边界即驻留（`run.breakpoint_hit` 事件可回放），恢复沿用既有 resume 语义；断点存于服务端 `run_breakpoints` 表，`node:<id>` 支持状态图课程按节点断点。**有界 RSI 运行器**（`packages/runtime-reference/src/rsi-loop.ts`）：生成器×对象×评估器×记忆四要素的 DGM 教学骨架——变异提示 → 冻结集确定性判分 → 严格改进才晋级、被拒变体入档保留（垫脚石原则）；代数/预算/变体长度均为服务端硬上限；权重级 RSI（SEAL 类）如实声明不可执行。**阶段 IX 前沿课程**（L42 前沿全景 / L43 上下文工程 / L44 DeepResearch 式多源研究 / L45 有界 RSI）。**状态图真实渲染**：L19/L20 的 graph.json 节点与谓词边按分层 DAG 绘制。**信息流动画重写**：CSS motion path 替代 SMIL（修复动态插入包的时基问题），活动路径入边高亮、计数徽章弹跳、断点命中红环驻留。
R6 新增（多 Agent 通信可观测）：**子 agent 全链可观测**——每个 worker 的模型调用与主循环同一事件合同（`context.compiled`（含 workerId 与上下文隔离标注）→ `model.request_prepared`（wire 证据）→ `model.request_dispatched` → `model.delta_batch` 流式片段 → `model.response_completed` 全文/用量），并行 worker 事件交错时前端按 workerId 分槽归属。**对话区多 agent 通信输出**——委派卡（worker + 目标）、控制权移交链、结果回收卡（成功/失败/黑板冲突）、MCP 连接与协议行、A2A 连接、技能加载行，与回合按事件顺序穿插；worker 回合有独立皮肤（W 左轨、子 agent 气泡），运行收尾以「Σ 合并输出」气泡呈现协调器确定性合并。**上下文轮间对比**——检视器新增「⇄ 与上一轮对比」：逐消息标注本轮新增/保留，被预算/压缩/策略移出的条目划线陈列，worker 回合在切换条上单独标注（上下文隔离一屏可见）。**动画与展示增强**——框图信息包按 worker 精确路由（委派/流式/结果落到具体子 agent 节点与边），worker 节点显示真实完成计数；流式回合显示生成计时与片段数；L18/L22/L30—L32 课程提示卡与系统提示词升级为更具说明性的演示样例。
R6b 新增（前端显示优化）：**深色主题**——设计系统全面令牌化（125+ 硬编码色收敛为语义令牌），`html[data-theme=dark]` 整套深色令牌（含 SVG 框图节点/边线/信息包/箭头 marker），顶栏一键切换、localStorage 记忆、缺省跟随系统 `prefers-color-scheme`，`color-scheme` 同步保证原生控件与滚动条适配。**课程地图**——搜索框按编号/标题/摘要过滤（带命中计数与空态提示）、阶段折叠（单个 ▾ 或一键全部收起）。**回放控制**——播放速度（0.5×—4×）、进度条拖拽直达任意事件、键盘快捷键（←/→ 步进、空格 播放/暂停、Home/End 跳转）。**历史页**——相对时间（刚刚/N 分钟前/今天 HH:mm）、空状态引导。
R4c 新增（课程收官，T34 累计 42 门）：A2A 远程 Agent 课程化（L33）、同预算四架构对照实验（L34）、有界递归运行器（T29：外部化长输入、行边界二分递归树、深度/节点双重硬上限、子调用从父预算原子预留；L35）、提示候选评测与晋级（T38 子集：共享冻结验证集、确定性选优、安全回归拒绝操纵性提示；L38）、诚实训练接口（T32 子集：synthetic 运行显式排除、无后端任务停在 unsupported 不可补标完成、completed 必须携带权重工件摘要；L40）、毕业全链实验（L41：读取→审批写入→引用证据作答）。运维面（T35 子集）：组件级健康检查（/api/v1/health：db/blobs/metrics）、备份与恢复（`pnpm backup`/`pnpm restore`：数据库与 blob 成对打包、逐文件 sha256 清单、篡改即拒绝、恢复后完整性核对）、回放负载基准（5000 事件：导出/导入/投影实测值见 `docs/operations/runbook.md`）、compose healthcheck 与工具授权基线（deploy/）。
R4b 新增：远程 MCP HTTP transport（streamable POST JSON-RPC、MCP-Protocol-Version 头、mcp-session-id 会话、Bearer 环境变量密钥、401/403 显式授权失败不静默重试）与 A2A 远程 Agent 协议（agent card 发现、message/send、tasks/get/cancel、artifact 校验）；http_fetch 工具（白名单 + SSRF 防护 + 不可信内容标记）；课程 L27 受控联网 / L28 数据注入防护 / L29 评测与故障注入。
R4 新增：演进层（packages/evolution）——T30 反思重试（失败→结构化反思带来源标签→注入下一步；对照模式不注入）与 T31 演进门控（证据门→安全回归→冻结验证集→并发版本检查，四门全过才晋级技能新版本；拒绝保留记录）。
R3b 新增：CLI 与 Web 一致性（同一 API/账本/退出码语义）与编码沙箱（run_test 受控执行器：白名单单文件、硬超时 SIGKILL、输出上限、命令注入拒绝；L26 全链 读 bug→写修复→真实测试通过）。
R3 新增：多 Agent 协调器（parallel/handoff/blackboard 三拓扑、TaskEnvelope 子预算从父预算原子扣减、取消传播、因果链、黑板并发写冲突保留两版本）与评估服务（冻结数据切分、确定性评分器、成功率按可适用用例计、配对对照；小样本不给出统计结论）。
R2b 新增：本地 MCP 教学闭环（stdio JSON-RPC、能力协商、tools/resources/prompts、协议事件脱敏记录、工具描述注入防护）与 Harness（固定阶段 HookRegistry：超时/失败策略/mutating diff、长期任务进展工件）。
R2 新增：技能包与三层渐进加载（安装≠授权、脚本默认不执行）、状态图运行时（注册谓词条件分支、访问上限、校验器拒死循环图）、具体效果审批（awaiting_approval 驻留、参数摘要绑定、变更失效、决策 API）、write_file 工具（workspace_write 级）。
R1 新增：资料导入/切块/索引（含确定性 fake 嵌入，显式标记）、BM25+向量+RRF 融合检索与引用校验、Wiki 版本/冲突/影响分析、长期记忆（作用域/版本链/遗忘传播）、固定工作流链（L08）与上下文压缩对照（L15）。

## 启动方式

### 前置要求

- Node.js ≥ 22.5（内置 `node:sqlite`，无需单独装数据库）
- pnpm ≥ 9（`corepack enable` 可直接启用）
- 全平台可用（Windows / macOS / Linux），本地单机模式，无需 Docker

### 安装与构建

```bash
pnpm install
pnpm build            # 全仓构建，包含 apps/web 前端产物
```

### 方式一（推荐）：单命令开发模式

```bash
AGENTGLASS_SEED_FAKE=1 pnpm dev
```

一条命令并行启动三个进程：

- **API**：http://127.0.0.1:8787 （REST + SSE + 静态 UI）
- **Worker**：执行 Agent 运行（模型调用、工具、预算、审批都在这里发生）
- **Web 开发服务器**：http://localhost:5173 （前端热更新，`/api` 自动代理到 8787）

打开 **http://localhost:5173** 即可使用。`AGENTGLASS_SEED_FAKE=1` 会注册一个**显式标记为「模拟」**的确定性教学模型（provider=fake），无需任何 API Key 即可完成 L04—L07 的完整工具循环演示；打开课程与不开启该变量都不会产生模型调用。

Windows PowerShell 下设置环境变量：`$env:AGENTGLASS_SEED_FAKE="1"; pnpm dev`；CMD：`set AGENTGLASS_SEED_FAKE=1 && pnpm dev`。

### 方式二：分进程开发模式

```bash
# 终端 1：API（自带打包后的 Web UI + REST + SSE）
AGENTGLASS_SEED_FAKE=1 pnpm dev:api

# 终端 2：运行 worker —— 必须启动，否则任务只会排队不会执行
pnpm dev:worker

# 终端 3（可选）：前端热更新；不启动则直接用 8787 自带的 UI
pnpm dev:web
```

只启动终端 1、2 时，打开 http://127.0.0.1:8787 。

### 方式三：生产 / 打包模式

```bash
pnpm build
pnpm start                              # API + 打包后的 Web UI（http://127.0.0.1:8787）
pnpm --filter @agentglass/worker start  # 另开一个终端运行 worker
```

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

## 使用方式

一次完整的教学闭环：**配模型 → 开课程 → 发任务 → 观察运行 → 改代码 → 再运行对照 → 导出回放**。

1. **配置模型**（「设置」页）：新增模型配置，选择类型——
   - `fake`：确定性教学模拟，免费离线（方式一已自动注册）；
   - `openai-compatible`（/chat/completions）或 `anthropic`（/v1/messages）：填 endpoint 与 model id，密钥引用填 `env:你的环境变量名`。anthropic 协议已实测 BigModel 兼容路由 `https://open.bigmodel.cn/api/anthropic` + GLM 系列（适配器默认关闭思考，配置参数 `parameters.thinking="enabled"` 可开启）。
2. **探测**：点「探测」发送少量真实请求，回写能力矩阵（流式 / 原生工具 / 结构化输出 / 用量统计）。能力以探测结果为准，不虚报。
3. **打开课程**：「课程」页 46 门课（L00—L45，九个阶段；阶段 IX 为前沿与 RSI），从"第一次调用"到"有界递归自我改进"。**打开课程零模型调用**；课程自带的案例提示只显示为输入框上方的 chips，点击仅插入草稿，是否发送永远由你决定。
4. **实验台发任务**（双分区布局，窄屏自动堆叠）：
   - **左·对话区**：主流 GUI agent 式对话流——用户气泡、**流式打字机输出**（SSE 推送 delta_batch，markdown 安全渲染、代码块可复制；生成中显示计时与片段数）、**回合分组**（一次模型调用=一回合，回合头标注输入估算 token，「◉ 上下文」一键深链该轮组装结果）、**多 agent 通信输出**（委派/移交/结果回收/MCP 协议/技能加载窄卡与回合穿插；worker 回合独立皮肤，收尾「Σ 合并输出」）、工具活动单行卡（类型图标 + 耗时徽章，点击展开真实参数与工件）、审批卡（高影响写入 inline 批准/拒绝）、实时状态行（含子 agent 阶段提示）、**智能吸底**（上翻阅读时停止跟随并浮出「回到最新」）；同一对话流跨多次运行累积，未配置有效模型时输入框拒绝发起实时运行。
   - **右·观察区**五个页签共享同一份事件账本：**架构**（按课程 manifest 生成的 SVG 框图，事件计数点亮、运行中边线流动、活动节点脉冲）、**信息流**（真实事件作为信息包沿边移动动画——多 agent 时按 worker 精确路由到对应节点与边 + 事件明细）、**代码**、**上下文**（上下文检视器：回合切换条（worker 回合单独标注）、token 组成条、模型实际收到的完整消息卡与工具 schema、**未选入清单**逐条给出预算/策略排除原因、**⇄ 与上一轮对比**（新增/保留/移除高亮，移除项划线陈列）、一键复制完整 JSON）、**运行**（用量/预算/版本/子 agent 统计）。
5. **运行控制**：运行中可「中断」；开放代码的课程可「暂停并改代码」直达代码页签（草稿独立于活动运行，改代码不影响正在跑的这一次）。**断点**：在架构/信息流图上点击可断节点（模型调用/工具执行/停止判定/状态图节点）设断点，运行到达即驻留（状态行提示命中位置，图上红环标记），点「恢复」继续；断点在多次命中间保持，按课程记忆。**单步调试**：工具栏「⏯ 单步」即逐轮驻留（turn_end 断点，每回合结束、检查点提交前驻留），暂停横幅显示命中轮次与预算进度，一键「◉ 查看此刻上下文组装」深链到上下文检视器；断点随输入提交、在运行创建事务内原子播种（首个运行也不会丢失）；断点/手动暂停与审批驻留的时间都自动顺延墙钟预算（观察与思考再久运行也不会被判超时，恢复事件如实记录驻留时长）。
6. **改代码**（开放代码的课程）：代码页签保存/校验（零模型调用）→ 点「采用」生成新版本 → 下一条消息起用新版本运行，与旧版本形成天然对照（「对照」页可选两次运行对比差异）。
7. **导出与回放**：运行页「导出」下载脱敏 `.agtrace.zip` → 「回放」页离线导入，逐事件步进回放（含框图时间旅行）。**回放不执行任何代码**。
8. **历史**：「历史」页列出全部运行（含模拟标记），点击进入回放。

### 接入 DeepSeek（示例）

```bash
# 1. 设置密钥环境变量（在启动服务的终端里；PowerShell: $env:AGENTGLASS_OPENAI_API_KEY="sk-…"）
export AGENTGLASS_OPENAI_API_KEY=sk-你的密钥

# 2. 启动（或重启）服务
AGENTGLASS_SEED_FAKE=1 pnpm dev
```

3. 「设置」页新增配置：提供方 `openai-compatible`，Endpoint `https://api.deepseek.com`，模型 ID `deepseek-flash`（以 `GET https://api.deepseek.com/models` 实际返回为准），密钥引用 `env:AGENTGLASS_OPENAI_API_KEY`。
4. 点「探测」——五项全过即可在实验台右上角切换使用。密钥列显示掩码（如 `sk-…eca`）表示服务进程能读到该变量；显示红色 `[MISSING]` 表示读不到，见下。

**探测报错对照**：

| 报错 | 含义 | 处理 |
|---|---|---|
| `SECRET_MISSING: 密钥引用 env:… 未设置或为空` | 服务进程读不到该环境变量 | 在启动 API 与 worker 的终端设置变量后**重启服务**，再探测 |
| `401 Authentication Fails` | 密钥被云端拒绝（变量读到了但值不对/失效） | 核对变量值；`curl https://api.deepseek.com/models -H "authorization: Bearer sk-…"` 验证密钥 |
| 模型相关 404/400 | 模型 ID 不存在 | 用 `GET /models` 查该端点实际可用的模型 ID |

注意：密钥引用必须以 `env:` 开头——直接把密钥本体粘贴进「密钥引用」会被拒绝（密钥本体不落库，也是排障时最常见的 401 来源）。

### CLI

```bash
pnpm cli doctor                                  # 环境自检
pnpm cli lesson run --lesson L05-observe-act     # 未给 --input 时交互式等待用户输入
pnpm cli run events RUN_ID --follow              # 跟踪事件账本
pnpm cli run export RUN_ID --out run.agtrace.zip # 导出脱敏运行包
pnpm cli replay run.agtrace.zip                  # 离线回放（不执行任何代码）
```

CLI 与 Web 走同一 API、同一事件账本、同一退出码语义。

## 仓库结构

| 位置 | 内容 |
|---|---|
| `packages/contracts` | 公共 TypeScript 合同（runtime/events/context/model/code-edit/conversation/lesson/tools） |
| `packages/skills` | R2 技能注册表：安装、三层加载、脚本授权边界 |
| `packages/mcp` | R2b/R4b MCP：stdio client + 远程 HTTP client（streamable JSON-RPC、会话、Bearer、SSRF 防护）、课程 server（.mjs 零依赖）、工具映射 |
| `packages/a2a` | R4b A2A 远程 Agent 协议：agent card、message/send、任务查询/取消、artifact 校验、工具映射 |
| `packages/harness` | R2b Harness：HookRegistry 固定阶段（超时/失败策略/diff）与长期任务进展 |
| `packages/multi-agent` | R3/R4c 多 Agent 协调器与有界递归：三拓扑、原子预算共享、因果链、黑板冲突合并；递归树深度/节点硬上限 |
| `packages/evaluation` | R3 评测服务：冻结切分、确定性评分、配对对照 |
| `packages/evolution` | R4 演进层：反思服务、技能候选四道门控、提示候选选优（T38 子集）、诚实训练接口（T32 子集） |
| `packages/tools`（run_test） | R3b 编码沙箱执行器：白名单单文件、SIGKILL 超时、注入拒绝 |
| `packages/runtime-graph` | R2 状态图运行时：校验器 + 执行器（model/tool/transform/gate 节点、注册谓词、访问上限） |
| `packages/knowledge` | R1 知识层：切块、embedding（fake/真实）、索引快照、BM25/向量/RRF 检索、引用校验、Wiki、记忆 |
| `packages/db` | SQLite 迁移与连接（本地模式；多人版换 PG 适配器，schema 合同不变） |
| `packages/events` | 事务事件账本 + outbox + 内容寻址 blob 存储 |
| `packages/policy` | 共享原子预算账本、秘密引用（env）、审批绑定摘要 |
| `packages/provider-gateway` | 模型网关：openai-compatible（流式 SSE、wire capture）+ anthropic（/v1/messages SSE）+ fake（显式模拟）+ 能力探测 |
| `packages/tools` | 工具代理：注册表、schema 校验、read_text（路径/符号链接防逃逸）、calculator（无 eval）、效果账本 |
| `packages/context` | 上下文编译器：候选池 → 原子组保护 → 预算选择（含选入/排除原因） |
| `packages/runtime-reference` | 透明参考循环：控制门（暂停/取消边界）、扩展点、检查点 |
| `packages/conversation` | 会话与输入队列：幂等键、排队/替换/撤回、会话前缀冻结 |
| `packages/code-lab` | 受控代码实验：AST patch-guard、草稿、隔离构建（esbuild 虚拟文件）、校验报告六摘要绑定 |
| `packages/lessons` | 课程注册表 + 发布 linter（拒绝 auto_send / 默认对话剧本） |
| `packages/projections` | 纯函数投影 reducer + 证据联动（用例 1） |
| `packages/replay` | 回放会话 + .agtrace.zip 导出/导入（fflate） |
| `apps/api` `apps/worker` `apps/cli` `apps/web` | 四个入口，共用上述合同 |
| `workers/learner-runtime` | 学习者代码隔离客体（fork 子进程 + IPC + 硬超时 watchdog） |
| `lessons/L00—L45` | 累计 46 门（R5 新增阶段 IX：L42 前沿全景、L43 上下文工程、L44 DeepResearch 多源研究、L45 有界 RSI） |
| `tests/` | unit / contract / integration / security / fault / e2e（真实 HTTP 注入） |

## 安全边界（R0 已实现）

- **模型外安全**：工具权限由代理校验（白名单 ∩ 注册表 ∩ schema），工具描述不能自授权限；预算为共享原子账本，学生策略不能突破宿主硬上限。
- **学习者代码隔离**：开放面由服务端 `LessonEditPolicy` + AST 检查（函数签名/导入集合/函数体外零改动）；构建走 esbuild 虚拟文件（禁外部模块解析）+ 五道安全门槛；执行在无秘密的子进程客体中，忙等被硬超时杀死。
- **版本不可变**：`AgentRevision` 构建后登记，校验报告绑定 `sourceDigest/baseManifestId/editPolicyDigest/toolchainDigest/testSuiteDigest/bundleDigest` 六元组；活动运行不受草稿影响。
- **回放不执行**：reducer 为纯函数；`.agtrace.zip` 导入检查路径穿越/尺寸/摘要；导出保留引用元信息。回放页与实验台共用同一套 SVG 框图：随游标推进重投影可见事件前缀（计数/点亮/信息包），导入包携带课程清单快照时同样重建框图，未携带时如实降级为事件流。
- **诚实标记**：fake 模型运行在事件与 UI 显式标注「模拟」；未配置模型不能发起实时运行；跳过的测试不能写成通过。

## 测试与发布检查

```bash
pnpm lint                 # 全仓 typecheck（strict）
pnpm test                 # 213 个测试 + 2 个显式跳过（42 个测试文件：unit/contract/integration/security/fault/e2e/performance/live）
pnpm verify:lessons       # 课程发布 linter
pnpm verify:source-bindings
pnpm verify:trace-bundles
pnpm backup              # 备份 data/（db+blob 成对，sha256 清单）
pnpm restore -- --from backups/<目录> --to data   # 校验后成对恢复
```

`test:live`（真实模型冒烟）需要显式配置模型并设置预算后单独运行，不混入常规 CI。

## 与设计文档的对应

- 设计 §24 的 T01/T03—T10、T13、T24、T26（确定性 grader）、T33（基础包）、T34（42 门全量）、T37—T42 基础子集已实现并有测试证据；对应验收项 A01—A05、A10、A15—A25 的本地模式子集见 `docs/adr/` 与测试。
- Pi / LangGraph 等工程运行时适配器（T12）按里程碑规划在后续版本接入；RAG/Wiki/记忆（T14—T18）、图与审批（T19/T20）、本地 MCP（T21）、远程 MCP HTTP transport（T22 子集）、Harness（T23）、多 Agent（T27）、A2A 远程协议（T28 子集）、有界递归（T29）、演进（T30/T31/T38 子集）、训练接口（T32 子集，诚实禁用）已实现并有测试证据；未实现能力在 UI/API 一致禁用（ADR-005）。

详细决策见 `docs/adr/`，教学使用见 `docs/teacher-guide/`。
