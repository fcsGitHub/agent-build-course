# ADR-005：R0 的能力矩阵与未实现能力（诚实声明）

**状态：** 当前事实
**依据：** 设计文档 §21.5（A12）、§26.2

## 已实现（有测试证据）

**R5 追加（流程图断点 + 有界 RSI + 阶段 IX 课程，L00—L45 共 46 门）：**
- 流程图断点：UI 点击可断节点（边界 target=before_model/before_tool/after_tool/turn_end 或 `node:<graphNodeId>`）→ `run_breakpoints` 表（服务端持有，PUT/GET `/api/v1/runs/:id/breakpoints`，zod 白名单校验，终态运行 409 拒绝）→ ControlGate 在安全边界轮询命中即驻留；放行只认 `resumeEpoch` 推进（resume 命令递增；驻留中 run 状态已是 paused，不能依赖 pauseRequested 回落）；命中写 `run.breakpoint_hit` 事件（含 target/node）+ `run.paused`（summary 携带 reason=breakpoint）；断点跨命中保持（调试器语义），由用户显式移除；tests/unit/control-gate-breakpoints.spec.ts + tests/fault/breakpoint-pause.spec.ts 覆盖驻留/放行/取消/再命中路径
- 有界 RSI 运行器（RsiLoopRunner，L45）：DGM 教学骨架四要素——生成器（模型变异 system prompt，`<prompt>` 标记契约）/ 对象（提示层）/ 评估器（冻结验证集 + 确定性子串判分，平台持有、候选不可见）/ 记忆（变体归档，被拒变体保留）；严格改进才晋级（平分拒绝）；代数 ≤3、变体 ≤4000 字符、逐调用预算预留（耗尽优雅停止 budget_model_calls_exhausted，不伪造成失败或成功）；rsi.generation_started/completed + 复用 candidate.* 事件全留痕；权重级 RSI（SEAL 类）如实声明不可执行
- 课程阶段 IX：L42 前沿全景（简报进 system prompt 的问答课）、L43 上下文工程（remember/search + compaction 对照）、L44 DeepResearch 式多源研究（三 worker：证据/交叉验证/反例）、L45 有界 RSI
- 前端可观测性：状态图课程（L19/L20）按 graph.json 真实节点/谓词边分层 DAG 渲染（API 注入 `runtime.graph`）；信息包动画改 CSS motion path（修复 SMIL 文档时间轴与动态插入不兼容的问题）；断点红环/入边高亮/计数弹跳；`prefers-reduced-motion` 全局尊重

**R4c 追加（T35 子集，运维面）：**
- 健康检查：`/api/v1/health` 返回组件级真实状态（PRAGMA quick_check、blobs 目录、lessons/runs/outbox 队列指标；outbox 积压即 ok=false，不做假健康）
- 备份/恢复：`pnpm backup` / `pnpm restore`——WAL checkpoint 后数据库与 blob/revisions/exports 成对打包，MANIFEST.json 记录逐文件 sha256；恢复前全量校验（篡改/缺失即 DIGEST_MISMATCH 拒绝、无半恢复状态），恢复后 integrity_check + 计数核对；tests/fault/backup-restore.spec.ts 覆盖正常/篡改/缺 blob 三路径
- 负载基准：tests/performance/replay-load.spec.ts（5000 事件真实写入 → 导出 ~55ms / 导入 ~33ms / 投影回放 ~11ms，实测值记录于 docs/operations/runbook.md；超上界即缺陷不放宽）
- 部署：deploy/compose.yaml 补 healthcheck；deploy/policies/tool-baseline.json 工具授权基线（三重白名单交集口径）；运维手册 docs/operations/runbook.md（观测告警口径、故障处置表、发布检查清单、SBOM=dependency-lock.json）

**R4c 追加（T29 + T38/T32 子集 + 课程收官 42 门）：**
- 有界递归运行器（BoundedRecursionRunner）：长输入外部化（blob 一次、事件只引用）；行边界二分递归树；叶子答题/内部合并；深度上限 = min(manifest, 服务端绝对上限 8)，节点数硬上限 64（进入即计数，fan-out 前拒绝）；每个节点的模型调用从父预算**原子预留**，不足显式 BUDGET_EXCEEDED 且最终答案声明覆盖缺失（不伪造完整）；递归事件 recursion.node_started/completed 可审计
- 提示候选评测与晋级（PromptCandidateService，T38 子集）：所有候选共享同一冻结验证集与评分器（平台持有）；成功率最高者晋级、平分取更短提示；低于门槛全部拒绝不晋级；操纵性提示（评分器/隐藏测试/忽略指令）安全回归直接拒绝；candidate.evaluated/promoted/rejected 全部留痕
- 诚实训练接口（TrainingJobService，T32 子集）：数据集导出排除 synthetic（fake）运行并给出原因、版本为内容哈希；无训练后端 → 任务停在 unsupported（TRAINING_BACKEND_UNCONFIGURED，终态不可补标完成）；有后端时 completed 必须携带权重工件摘要，缺摘要 → failed；本地模式能力矩阵如实报告 training 不可用（L40 只讲数据流程/回放，绝不标注"本次训练完成"）
- 课程收官（T34 累计 42 门）：L33 A2A 远程（card 发现→委派→artifact 待验证标注）、L34 同预算四架构对照（loop/chain/graph/parallel 费用/延迟/失败模式配对取证）、L35 有界递归、L38 提示候选、L40 训练接口、L41 毕业全链（读取→审批驻留→批准写入→引用证据作答）

**R4b 追加（T22 远程 HTTP 子集 + T28 A2A 子集 + http_fetch + L27—L29）：**
- 远程 MCP HTTP transport：streamable POST JSON-RPC（`MCP-Protocol-Version` 头、`mcp-session-id` 会话跟踪）、Bearer 密钥经 `env:` 环境变量解析、401/403 显式授权失败（不静默重试）、协议事件脱敏记录；SSRF 防护（仅 http(s)、拒绝私网/回环/内网主机名、DNS 解析后复核，`allowPrivateNetwork` 仅供本地测试夹具显式开启）
- A2A 远程 Agent 协议：agent card 发现（`/.well-known/agent.json`）、message/send、tasks/get、tasks/cancel、artifact 校验（仅 text、64KB 上限，非文本显式 A2A_ARTIFACT_INVALID）；远程 agent 映射为宿主白名单工具（`a2a_<name>`），策略不变
- http_fetch 工具：域名白名单 + SSRF 防护 + 响应尺寸上限 + 不可信内容显式标记（untrusted-content 标注进入上下文，供注入教学）
- 课程：L27 受控联网（白名单内真实抓取/白名单外拒绝）、L28 数据注入防护（检索/抓取内容含注入指令时 write_file 零触发）、L29 评测与故障注入（确定性故障 runner；错误用例显式"执行失败"不给假成功）

**R4 追加（T30 + T31）：**
- 反思重试：chain 步骤工具失败 → 结构化反思（来源标签 tool_error/test_failure/human/none，确定性规则分类）→ 注入下一步；reflection.recorded 事件可审计；对照模式（none）不注入以区分"反馈贡献"与"多算一次"
- 演进门控（CandidateService 四道门）：证据门（块存在且文档版本未被取代）→ 安全回归（禁用构造/保护路径如 hidden-tests、grader）→ 冻结验证集（EvaluationService，候选不可改 grader）→ 并发版本检查（乐观锁）；全过才晋级技能新版本（updateBody）；任一拒绝保留 candidate.rejected 记录不发布
- 事件注册：reflection.recorded / candidate.evaluated / candidate.promoted / candidate.rejected

**R3b 追加（T24 一致性测试 + T25 编码沙箱部分）：**
- CLI 与 Web 一致性：同一 API/事件账本/预算与授权；doctor 退出码语义（不可达非 0）；run inspect 与 Web 检查器读相同证据
- run_test 编码沙箱执行器：仅允许工作区内 .js/.mjs 单文件；PATH-only 环境；硬超时 SIGKILL；输出上限；非脚本文件与命令注入参数拒绝（SCRIPT_NOT_ALLOWED）；退出码忠实记录（模型声称通过 ≠ 真实通过）
- L26 全链集成：读 bug → 审批驻留 → 批准写入修复 → run_test 退出码 0 → grader 检查 ALL TESTS PASSED

**R3 追加（T27 + T26 基础）：**
- 多 Agent 协调器：parallel/handoff/blackboard 三拓扑；TaskEnvelope 子预算从父预算**原子预留**（共享 BudgetLedger 行，超出即 BUDGET_EXCEEDED 拒绝）；取消传播（父 AbortSignal → 全部子 controller）；因果链（agent.delegated → agent.result_received causationEventIds）；确定性合并（按任务声明顺序，与完成顺序无关）
- 黑板并发写：同键不同内容 → 冲突保留两版本（mergedBy=conflict-kept-both），不静默覆盖；写入带 worker 视角前缀
- 评估服务：freeze 数据切分（内容哈希幂等）、确定性评分器（contains_all/any/regex，平台持有不可被候选修改）、not_applicable 与成功率分离（A25）、配对对照（n<5 不给统计结论）
- 上下文隔离：子 agent 只见自己的任务包文本与白名单工具

**R2b 追加（T21 本地 + T23）：**
- 本地 MCP 教学闭环：stdio newline JSON-RPC client（固定命令启动、env 仅 PATH、请求超时、崩溃显式报错）、协议版本协商（2025-11-25，不符显式失败）、tools/resources/prompts 发现与调用、协议事件脱敏记录（方向/方法/字节数）
- MCP 工具映射：server 工具 → 宿主 ToolHandler（白名单/schema 校验不变）；**工具描述注入文本不改变宿主策略**（L23 教学点，注入文本可见可讲解）
- Harness：HookRegistry 固定阶段（before_context…after_run）、按注册顺序执行、单 hook 超时、失败策略（continue/fail）、mutating hook 产生 hook.diff 事件、after_run 长期任务进展工件（task.progress_updated）
- 安全边界：授权/预算/审批不经过 hook 管道，插件不可关闭

**R2 追加（T18 + T19/T20 核心 + L17—L21）：**
- 技能包：显式安装（不扫描用户目录）、三层渐进加载（元信息→正文→资源/脚本）、脚本默认不执行（NOT_AUTHORIZED）、课程白名单（安装≠授权，SKILL_NOT_ALLOWED）、skill.loaded 事件
- 状态图运行时：GraphDefinition 校验器（悬空边/未注册谓词/终止可达/访问上限）、执行器（model/tool/transform/gate 节点、注册谓词条件分支、maxNodeVisits 有限循环、逐节点检查点）
- 具体效果审批：ApprovalService（参数摘要绑定、run/目标/工具版本/策略/过期任一变化失效、决策幂等、显式失效）；write_file（workspace_write）派发前运行驻留 awaiting_approval，批准后恢复执行；决策 API
- 记忆类别维度（episodic/semantic/procedural，L17）

**R1 追加（T14—T17 基础 + T19 固定链子集）：**
- 资料导入/切块（标题边界/定长）与索引快照（embedding 版本 + 切块器版本绑定；版本混用拒绝）
- Embedding 提供方：`fake-embedding`（确定性 trigram 哈希，显式标记）与 `openai-compatible`（真实 /embeddings）
- 检索三阶段：自实现 Okapi BM25 / 向量余弦 / RRF 融合，各阶段候选与名次可解释；引用存在性校验（【c:块ID】）
- Wiki：页面/修订/论断/证据链接/反向链接；`evidence_superseded` 与 `missing_evidence` 冲突检测；冲突未处理禁止发布；影响分析定位受影响页面
- 记忆：作用域（user/project/session）、内容幂等与版本链、遗忘传播（遗忘后 recall/list 不再返回）、跨作用域读取与删除拒绝
- 固定工作流链（chain profile）：程序定义步骤、逐步事件标注（workflow/step）、与自主循环对照（L08）
- 上下文压缩策略 `tool_result_head`（L15）与课程级输入预算的排除原因可见（L14）

事件账本与投影回放、模型网关（openai-compatible 流式 + fake 显式模拟 + 能力探测 + wire 脱敏证据）、工具代理（read_text/calculator、路径/符号链接防逃逸、效果账本）、上下文编译（原子组、预算排除原因）、参考循环（控制门、暂停/取消、检查点事件）、受控编辑全链路（草稿/AST 范围/五门槛构建/不可变 revision/隔离执行/硬预算）、课程包 L00—L07 与发布 linter、CLI（doctor/lesson run/run */replay）、agtrace 导出导入、历史对照。

## 未实现（UI/API 一致禁用，不提供假能力）

- Pi / LangGraph / OpenAI Agents SDK 适配器（T12）——`AgentRuntimePort` 已留端口，`capabilities()` 如实声明。
- 检查点分支恢复：参考循环 `resume()` 返回 `UNSUPPORTED_CAPABILITY`；"从此处分支"UI 不提供（A26 的默认拒绝路径）。
- 测试执行的容器级隔离（当前为 PATH-only 子进程+SIGKILL，多不可信用户需更强隔离评审）、受控浏览器实验站点（T25 浏览器面）、远程 MCP 的 SSE 流式响应与 OAuth 授权过期刷新（当前为 Bearer env + 401/403 显式失败）、模型 judge 与统计显著性（T26 进阶）、A2A 流式/推送通知（当前仅轮询 tasks/get）、提示优化的自动搜索循环（T38 当前为候选对照评测，不含 DSPy/GEPA 类自动优化器接入）、真实训练闭环与 recorded-runs 课堂包（T32 训练接口已建，后端未接入；`tests/fixtures` 与 fake 运行明确标记 synthetic，不进入课程"真实历史"）。

## 升级路径

各能力按里程碑接入同一端口与事件注册表；接入前 UI/API 不出现对应入口，避免"看似支持"的演示陷阱。
