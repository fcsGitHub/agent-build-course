# L44 DeepResearch 式多源研究（orchestrator-worker）

2025 年的标志性 agent 形态之一是**深研 agent**（OpenAI Deep Research 2025-02、Gemini Deep Research 2024-12、
Anthropic 多智能体研究系统 2025-06）。它们共享同一个骨架：**规划 → 并行检索 → 交叉验证 → 综合引用**。

Anthropic 公开的诚实账本值得记住：多智能体研究系统在内部评测上比单 agent 高 **+90.2%**，
但 token 用量约 **15x**——且 token 用量能解释约 **80%** 的结果方差。换句话说：
并行 worker 买的是"更多探索"，不是魔法。

## 本课骨架

- **协调器**拆解研究任务 → 派发三个 worker（上下文相互隔离，各自只见任务包）：
  `w-evidence`（证据搜集）/ `w-verify`（交叉验证）/ `w-counter`（反例检查）；
- 每个 worker 用 `search_documents` 即时检索（对照 L43），引用块 ID；
- **确定性合并**（不是 LLM 随意拼接）+ 系统 prompt 要求三档结论分级：
  多源一致 / 单源待验证 / 存在反例。

## 观察要点

- 架构图：fan 拓扑的三个 worker 并行点亮；`agent.delegated` 与 `agent.result_received` 的计数对应派发与回收。
- 信息流：三条 merge 边的信息包几乎同时到达——这就是"并行探索"的可视化。
- 断点：worker 节点可设 `before_model` 断点，驻留时在 Prompt 页签查看该 worker 的隔离上下文
  （你会看到它**看不到**其他 worker 的检索结果——隔离是特性不是 bug）。
- 运行页签：三个 worker 的 token 用量与合并端对比——体会 15x 的账本从哪来。

## 思考题

1. 为什么反例检查（w-counter）要与证据搜集分开为独立 worker，而不是同一个 agent "顺便"做？
2. 确定性合并 vs LLM 合并：各自的风险是什么？本课为什么选前者？
3. 如果检索库本身有过期文档（v1 与 v2 并存），交叉验证 worker 应该如何使用块 ID 暴露版本冲突？
