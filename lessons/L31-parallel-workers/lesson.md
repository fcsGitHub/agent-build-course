# L31 多 Agent 获益需要任务可分解

三个 worker（specs/maintenance/warranty）并行执行，各自只有**自己的任务包**
（上下文隔离），模型调用全部从父预算**原子扣减**——预算耗尽时后来者被拒绝
（事件：agent.result_received status=failed reason=BUDGET_EXCEEDED）。

## 观察

1. `agent.delegated` 三条几乎同时出现（并发）。
2. 合并按**任务声明顺序**（w-specs → w-maintenance → w-warranty），与完成顺序无关。
3. 预算 6 次调用 = 父 0 + 子 3×2？不——本课每 worker 恰好 1 次调用；把 max_model_calls 调到 2 再跑，
   观察第 3 个 worker 被预算拒绝。

## 判断

任务可分解、证据互补时并行才有收益；同模型多角色意见一致不是独立来源验证。
