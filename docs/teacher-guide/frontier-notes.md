# 前沿调研笔记（阶段 IX 备课参考，2026-09 整理）

> 本文是 L42—L45 的备课素材来源与出处索引。数字与结论以原始论文/官方博客为准；
> 引用格式：机构，标题，日期，arXiv 编号（如有）。

## 1. RSI 谱系（按"改进对象"分层）

| 系统 | 改进对象 | 核心机制 | 关键结果 | 出处 |
|---|---|---|---|---|
| Self-Refine (NeurIPS 2023) | 单次任务内输出 | 生成→自评→再生成 | — | arXiv:2303.17651 |
| Reflexion (NeurIPS 2023) | 情景记忆 | 失败轨迹→语言反思→存记忆缓冲→条件下次尝试 | HumanEval ≈91% | arXiv:2303.11366 |
| ADAS (2024) | agent 设计（代码） | 元 agent 读**归档**（代码+描述+得分）再编程新设计 | 跨模型/跨域迁移 | arXiv:2408.08435 |
| **DGM**（Sakana+UBC, 2025-05） | agent 源码 | 归档保留**全部**变体（含变差者）；父代选择兼顾分数与新奇度；经验证代替形式证明 | SWE-bench 20.0%→50.0%；Polyglot 14.2%→30.7% | arXiv:2505.22954；sakana.ai/darwin-godel-machine |
| SICA (2025-04) | 自身源码 | agent 编辑自己代码；泛化随**训练环境数**扩展 | 17%→53%（SWE-Bench-Verified 子集） | arXiv:2504.15228 |
| **AlphaEvolve**（DeepMind, 2025-05） | 代码库 | MAP-Elites 程序数据库+提示采样器+Flash/Pro 级联+自动评估器 | 4×4 复数阵乘 48 次乘法（56 年首破 Strassen 该设定）；Borg 调度回收全球算力 ~0.7% | arXiv:2506.13131；deepmind.google 博客 2025-05-14 |
| **SEAL**（MIT, 2025-06） | **权重** | 模型生成"自编辑"（合成微调数据+超参指令）→自微调→外层 RL 强化有效自编辑 | 知识注入与少样本数学；自报梯度内优化慢/不稳、灾难性遗忘、奖励作弊 | arXiv:2506.10943 |
| AREX (2026-07) | 深研 harness | 外环审计内环产出；**只有通过验证的发现跨轮存活** | WideSearch-en SOTA | VectorSpaceLab |
| Anthropic《When AI Builds Itself》(2026-06) | — | 行业现状声明 | 内部 >80% 合并代码由 Claude 作者（2026-05）；训练代码优化 ~52x；明确"RSI 并非必然"，人类优势=研究品味与判断 | Anthropic Institute |

**统一骨架**（L45 的教学框架）：生成器（谁变异）× 对象（什么被改：权重/代码/提示/数据）× 评估器（什么算更好）× 记忆（变体存哪）。差异在：选择是开放探索（归档/新奇度）还是贪心（爬山）；评估门与沙箱；回滚/检查点。

## 2. 能力趋势与训练

- METR《Measuring AI Ability to Complete Long Tasks》(2025-03，追踪至 2026-05)：50% 成功率任务时长 2019-2025 约**每 7 个月翻倍**，近期拟合约 4.3 个月（加速）；结论对 10 倍测量误差稳健。
- RLVR（可验证奖励的 RL）是 agent 行为训练主流；OpenAI Deep Research（2025-02）为端到端 RL 标志案例。争论：Yue 等 pass@k 分析认为 RLVR 主要放大既有能力而非创造新能力。
- 基准演化：Terminal-Bench 2.0/4.0；τ²-bench（双控：模拟用户 LLM 共动）；GAIA 近饱和；SWE-bench Verified ~93.9% 饱和（OpenAI 2026-02 声明弃用理由：污染+测试缺陷）→ SWE-bench Pro / SWE-rebench。
- **评估器完整性警示**：Berkeley RDI《How We Broke Top AI Agent Benchmarks》(2026-04)——攻击评估 harness 在 SWE-bench Verified/Terminal-Bench/FieldWorkArena 拿 100%（98% GAIA、73% OSWorld）而未解任务。→ 阶段 IX 的主线：**验证先于自改进**（Stanford CS329A 同序）。

## 3. 工程范式

- **上下文工程**（Anthropic《Effective Context Engineering for AI Agents》2025-09-29）：上下文=有限且退化的资源；四技术：压缩 compaction / 结构化笔记 / 子代理上下文隔离 / 即时检索。context rot 证据：Chroma 技术报告 2025-07-14（相关内容变长也降性能）。L43 对应。
- 记忆：MemGPT→Letta（OS 式分页）；sleep-time compute（arXiv:2504.13171，空闲期第二 agent 预计算共享记忆块）；Claude memory tool（2025-09）。
- 协议：MCP（2024-11 开源→2025-12 捐赠 Linux 基金会 Agentic AI Foundation；社区估计采用速度约为同期 Kubernetes 10 倍）；A2A（Google 2025-04→2025-06 入 Linux 基金会，2026-04 150+ 组织，v1.0+TCK）；Agent Skills（SKILL.md 三级渐进披露，2025-12 开放标准 agentskills.io）。注意：agent card 是新兴注入面（Palo Alto 2025）。
- 多智能体：Anthropic《How We Built Our Multi-Agent Research System》(2025-06-13)——orchestrator-worker；内部评测较单 agent **+90.2%**，token **~15x**，用量解释 ~80% 结果方差。L44 对应。
- 深研 agent：OpenAI Deep Research（2025-02，o3 端到端 RL）→ChatGPT Agent（2025-07）；Gemini Deep Research（2024-12）。

## 4. 评估与可观测性

- Anthropic《Demystifying Evals for AI Agents》(2026-01-09)：三层判分（代码/LLM 判卷带 Unknown 出口/人工）；"单边评测造成单边优化"；能力评测 vs 回归评测毕业制；判**结果**而非轨迹（轨迹级作为补充）；20-50 条生产任务即可起步。轶事：Opus 4.5 在 CORE-Bench 修判分器 bug 后 42%→95%。
- LLM-as-judge 偏差与缓解（结构化单维 rubric、成对比较、多判官、人工校准）。
- 轨迹级评估与生产追踪回收为评测集是 2025-26 标准工作流（LangSmith/Langfuse/Braintrust/Phoenix）。

## 5. 教学参考（课程结构）

- **Stanford CS329A《Self-Improving AI Agents》**（2025 秋；视频 2026-08 公开）：scaling→test-time compute→**稳健验证**→反馈学习→规划→RL→**开放演进（ADAS/AI Scientist/AlphaEvolve）**→深研 agent→记忆→长程评测。最终项目占 35%。
- Berkeley CS294/194-196《LLM Agents》（2025 春）：论文阅读+学期项目主线。
- Anthropic《Building Effective Agents》(2024-12-19)：augmented LLM 原子单元；workflow vs agent；五模式（链/路由/并行/编排者-工人/评估者-优化器）；"从最简单方案开始"。
- OpenAI《A Practical Guide to Building Agents》(2025-06)：单 agent 起步→manager 编排。
- HuggingFace Agents Course（2025）：四单元+GAIA 型期末考。
- **市场空白**（本实验室定位）：几乎没有课程把 RSI 讲到"可安全动手"的机制层——CS329A 第 7 讲最接近；没人把 DGM 归档/AlphaEvolve 数据库做成可实现的练习。AgentGlass 的 L45（有界 RSI + 事件账本 + 断点观察）即填补此空白。
