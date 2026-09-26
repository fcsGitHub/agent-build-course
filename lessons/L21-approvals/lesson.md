# L21 人机协同是控制合同

`write_file` 属于 workspace_write 级别：派发前必须持有**具体效果审批**。
审批绑定：run + 工具版本 + 参数摘要 + 目标 + 有效期。

## 流程

1. 发送写入任务 → 运行在 `awaiting_approval` 驻留，事件出现 `approval.requested`（含参数摘要）。
2. 教师决策：
   ```bash
   curl -X POST http://127.0.0.1:8787/api/v1/approvals/<id>/decision         -H "content-type: application/json" -d '{"decision":"grant"}'
   ```
3. 运行恢复：`approval.granted` → 写入执行 → `tool.call_completed`。
4. **失效演示**：拒绝后再请求相同写入 → 再次驻留；换一个目标路径的写入需要**新的**审批（参数摘要变化 = 旧审批失效）。

## 判断

- 无审批无法写入：拒绝后模型收到的是"拒绝原因"，不是静默失败。
- 审批绑定的是具体参数摘要，不是笼统的"同意继续"。
