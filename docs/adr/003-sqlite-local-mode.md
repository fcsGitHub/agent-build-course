# ADR-003：本地实验版使用 SQLite（node:sqlite）

**状态：** 已采纳（R0 本地档位）
**依据：** 设计文档 §20.1 部署档位；基线为 PostgreSQL

## 背景

设计基线存储为 PostgreSQL + pgvector。R0 的目标环境是单人本地实验（Windows/macOS/Linux 桌面），要求零外部服务安装即可运行完整教学闭环。

## 决策

- 本地档位使用 Node 内置 `node:sqlite`（同步 API、WAL 模式），schema 以同一组 SQL 迁移定义（`packages/db/migrations`），字段与约束忠实对应设计 §19.1/§19.2 的关系与唯一键（`(run_id, seq)`、`(session_id, client_message_id)`、效果幂等键等）。
- 所有数据访问通过 `packages/db` 的连接与事务辅助；不直接在业务代码散写 SQL 方言特性（避免 PG 迁移回溯成本）。
- 预算账本的原子性依赖 `BEGIN IMMEDIATE` 单写者语义（用例 6 的"共享原子账本"在本档位的等价实现）。

## 后果

- 多人课堂版切换 PostgreSQL 时：新增 `openPostgresDatabase` 适配 + 迁移方言改写；事件账本/会话/预算的合同与测试不变。
- 已知取舍：`node:sqlite` 当前为实验性 API（Node 22.5+）；SQLite 单写者限制并发写，本地档位足够。
