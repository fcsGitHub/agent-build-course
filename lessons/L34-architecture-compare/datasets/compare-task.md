# 对照实验任务单

任务（在四种架构下使用完全相同的文本运行）：
请读取 inventory.csv，统计所有品类的库存总量，并说明你的计算依据。

运行矩阵：
1. 单 Agent 循环：本课（agent_loop）
2. 固定工作流：L08（chain，三步固定）
3. 状态图：L20（graph，计划→检索→作答）
4. 多 Agent 并行：L31（parallel，三个 worker）

对照字段（历史页勾选两次运行可逐项对比）：
- 任务结果：最终回答与计算依据是否一致
- 费用：model.response_completed 的 usage（输入/输出 token）
- 延迟：run.created → run.completed 的墙钟时间
- 失败模式：stop_reason（final_answer / policy_stop / budget_exhausted）

判断标准：更复杂的拓扑只有在结果更好或失败更少时才"值得"；否则退回简单架构。
