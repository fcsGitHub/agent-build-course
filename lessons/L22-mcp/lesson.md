# L22 把 MCP 拆开（本地闭环）

本课启动课程自带的 MCP server（stdio 子进程）：
1. **initialize**：宿主与 server 协商协议版本（2025-11-25）与能力子集（tools/resources/prompts）；
2. **发现**：tools/list → `device_specs` 映射为宿主工具 `mcp_course_device_specs`；
3. **调用**：模型请求 → 宿主校验 → MCP tools/call → 真实结果回到上下文。

## 观察点

- 每条协议消息都有 `mcp.protocol_event` 事件（方向/方法/字节数；凭据与大载荷不进事件）。
- MCP 连接与模型 API 是**两条不同的连接**（检查器信息流里分属两个通道）。

## 练习

问"AG-2048 的额定电压是多少"，对照工具卡与协议事件。
