# L25 CLI 是入口，不是另一套 Agent 原理

CLI（`pnpm cli lesson run --lesson L25-cli-web`）与 Web 实验台走**同一个 API、
同一个事件账本、同一套预算与授权**。两个入口创建的 run 在历史页并排可见，
事件结构完全一致（`run inspect` 与 Web 检查器读到相同证据）。

## 实验

1. 从 Web 发起一次运行，再从 CLI `lesson run --wait` 发起同一任务。
2. 历史页对照两条轨迹：状态、停止原因、事件结构应一致（输入不同则内容不同）。
3. `pnpm cli run events <RUN_ID>` 与 Web 时间轴逐条对应。

## 判断

退出码有语义：0=完成、非 0=失败/取消——CLI 文本输出不是唯一证据，账本才是。
