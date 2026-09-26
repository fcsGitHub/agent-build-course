# ADR-001：教学公共合同与运行时边界

**状态：** 已采纳（R0）
**依据：** 设计文档 v1.1 §7/§8/§26.1（ADR-01/04/05）

## 决策

1. 教学公共合同由本系统拥有（`packages/contracts`），不暴露任何 SDK 内部类型。第三方运行时通过 `AgentRuntimePort`（capabilities/start/resume）接入。
2. 规范事件账本是唯一权威证据源：事件类型必须属于版本化注册表；`(run_id, seq)` 由持久层事务分配；状态变更、事件、outbox 同事务提交。
3. 模型与工具必须经过独立受控代理（ModelGateway / ToolBroker）：预算预留、schema 校验、白名单、效果账本在代理侧完成；运行时代码只拿到受控结果。
4. 基础形态为模块化单体 + worker：API 不执行运行；worker 持租约执行；两者只共享 SQLite 合同与事件账本。

## 结果

- 透明参考循环（`packages/runtime-reference`）是第一个 `AgentRuntimePort` 实现；Pi/LangGraph 适配器（R1）按同一端口接入，能力矩阵如实声明，不支持的能力返回 `UNSUPPORTED_CAPABILITY` 而非伪装。
- 回放（`packages/projections` + `packages/replay`）只依赖事件与工件，依赖方向上与执行服务隔离；A03/A04 可测。

## 偏差记录

- 本地模式存储采用 SQLite（`node:sqlite`）而非设计基线 PostgreSQL：见 ADR-003。
