# L19 计划是数据，不是执行事实

图定义（graph.json）描述控制流：
`plan（模型制定计划）→ search（工具检索）→ answer（模型汇合，终止）`，
`answer → search` 还有一条 `evidence_sufficient` 条件边——证据不足时再检索，
配合 maxNodeVisits=2 形成**有限**重规划循环。

## 观察

1. `graph.node_started/completed` 事件按节点顺序出现；每个节点后有一次 checkpoint。
2. 计划文本是节点输出（数据）；模型在回答里"勾选"计划不改变任何状态——成功只由验证与终止节点定义。
3. 检索节点直接由工具代理执行（无模型调用），成本单列。

## 对照 L08

chain 的路径写死；graph 的路径由**条件谓词**决定（注册谓词，非内联 JS）。
