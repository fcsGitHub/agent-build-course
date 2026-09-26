# L32 共享内存不是免费的一致性机制

blackboard 拓扑下两个 worker 并发写同一键 `shared-findings`：
内容不同 → **冲突保留两版本**（mergedBy=conflict-kept-both），不静默覆盖；
合并记录（MergeRecord）带因果事件 ID，可回放。

## 观察

`agent.result_received` 的摘要含 `conflict: true, versions: 2`。

## 判断

并发写需要明确的合并策略；"最后写入者获胜"不是合并，是丢数据。
