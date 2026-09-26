# L42 前沿全景：从 Agentic RL 到 RSI（2025-2026）

这门课不跑循环、不调工具——它把**前沿简报**作为 system prompt，让模型当讲师，
你问什么它答什么（每次运行一次真实调用；提问内容完全由你决定）。

## 简报覆盖的四条线

1. **RSI 谱系**：任务内反思（Self-Refine/Reflexion）→ 搜索 agent 设计（ADAS）→ 自改代码
   （DGM、SICA）→ 进化代码库（AlphaEvolve）→ 权重级（SEAL）→ 2026 的验证式 RSI（AREX/SIA）
   与 Anthropic《When AI Builds Itself》的内部数据与"RSI 并非必然"声明。
2. **能力趋势**：METR 时间跨度每 ~7 个月翻倍（近期拟合更快）；RLVR 与 pass@k 争论。
3. **工程范式**：上下文工程四技术；MCP/A2A/Agent Skills 的标准化时间线；
   多智能体 +90.2% 与 15x token 的诚实账本。
4. **评估**：三层判分；判分器 bug 42%→95% 的教训；Berkeley RDI 攻击评估器拿 100% 的警示——
   **验证先于自改进**（Stanford CS329A 的课程主线，也是本实验室 L36→L45 的顺序）。

## 观察要点

- Prompt 页签：课程 system prompt 即简报全文（服务端资产，不可被运行时修改）。
- 模型对简报未覆盖的问题应当如实承认——这是"诚实回答"的可观察面。
- 每个回答是一次模型调用：用量、费用、耗时都在运行页签可见。

## 思考题

1. DGM 与 AlphaEvolve 的"记忆"有什么本质差别？（agent 树 vs 程序数据库/岛屿）
2. 为什么 Anthropic 的多智能体系统敢用 15x token？什么任务值得，什么任务不值得？
3. "验证先于自改进"——如果评估器可被候选影响，RSI 会退变成什么？
