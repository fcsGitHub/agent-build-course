# L30 同样"调用另一个 Agent"，语义不同

本课演示 **handoff（移交）**：researcher 完成后把控制权（与输出）移交给 writer，
事件链出现 `agent.delegated → agent.handed_off → agent.result_received`。

## 对照（教师演示）

- **subagent 语义**（L31 parallel）：父保留控制权，worker 返回工件后父汇合；
- **工具委派语义**：worker 包装成工具，内部仍有独立运行与预算。

## 判断

移交改变了"当前负责方"；并行不改。语义不同，故障处理也不同（移交链中一环失败会阻断后续）。
