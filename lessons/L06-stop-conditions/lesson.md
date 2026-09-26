# L06 自动循环为什么必须有边界

本课的基线策略是 `return s.hasNewObservation`（几乎总是请求继续），
而宿主硬预算 maxTurns=3。观察谁在什么时候真正停下了循环。

## 故障注入

1. 让模型读取不存在的 `missing.csv`：`tool.call_completed` 记录真实 READ_FAILED（文件读取、模型调用与错误都真实发生）。
2. 工具被移出白名单：`tool.denied` + 拒绝原因回到模型上下文。
3. 模型反复提出同类工具请求：`policy.stop_decision`（learner_policy 或 budget）与硬预算谁先生效？

## 通过条件

- 说明"策略软条件"与"宿主硬上限"的区别；
- 指出被终止、被拒绝与正常完成在事件记录中的不同停止原因；
- 被终止 ≠ 任务成功：运行状态不是 completed。
