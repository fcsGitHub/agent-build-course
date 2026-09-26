# L33 通过 A2A 调用远程教学 Agent

远程 Agent 协作 ≠ 本地工具调用。本课把一个真正的远程 Agent（本地桥接的 stdio 进程 + HTTP JSON-RPC）接入宿主：

1. **发现**：运行开始时宿主读取 agent card（`/.well-known/agent.json`），事件 `a2a.agent_connected` 记录 agent 名称与地址。
2. **委派**：模型发起 `a2a_research` 工具调用 → 宿主通过 A2A `message/send` 发送任务 → 远端返回 task 与 artifact。
3. **验证边界**：artifact 文本进入上下文时被标记为**待验证信息**——跨 Agent 通信不因对方"自称专家"而跳过证据审查。

## 观察要点

- `tool.call_completed` 的输出摘要含 taskId/state/text：这是远端真实响应，不是本地拼装。
- 最终回答会显式标注"待验证信息"——对比 L04：本地工具结果也并非天然可信，只是验证手段在手。
- 取消/查询（tasks/get、tasks/cancel）见合同测试；课堂演示以 message/send 为主。

## 安全边界

- 远程地址仅限本地回环课程桥；SSRF 防护默认拒绝私网/内网地址（`packages/a2a`）。
- 授权 token 不透传给远端；远端能力不能改变宿主白名单。
