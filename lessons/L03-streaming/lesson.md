# L03 流式、取消与截断

## 机制

流式输出 = 模型边生成边返回片段。`model.delta_batch` 事件按批次记录片段；
`model.response_completed` 的 finishReason 才是权威终止原因。

## 观察点

1. 发送任务后观察时间轴：request_dispatched → delta_batch… → response_completed。
2. 运行中点击"停止"：运行进入 cancel_requested → cancelled。中断不是完成；
   已收到的片段保留，未完成部分显示缺口。
3. 输出达到 max_output_tokens 上限时 finishReason=length，回答被标记"截断"。

## 练习

- 用提示卡或自写一个长回答任务，播放时中途停止，检查事件记录的完整性。
