# 运维手册（Runbook，T35）

本地实验版（单用户 / SQLite / node:sqlite，见 ADR-003）的观测、备份恢复与故障处置。
发布检查口径：`pnpm test`（含 performance/fault/security）、`pnpm verify:lessons`、`pnpm verify:source-bindings`、`pnpm verify:trace-bundles` 全绿。

## 1. 进程与端口

| 进程 | 启动 | 职责 |
|---|---|---|
| api | `AGENTGLASS_SEED_FAKE=1 pnpm dev:api` | 静态页面 + REST；不执行运行 |
| worker | `pnpm dev:worker` | 轮询排队输入 → 执行 Agent 运行（租约 + 控制命令） |

容器部署见 `deploy/compose.yaml`（api 带 `/api/v1/health` healthcheck；worker 依赖 api healthy）。
工具授权基线见 `deploy/policies/tool-baseline.json`（白名单三重交集：课程声明 ∩ 基线 ∩ 平台注册表）。

## 2. 健康检查与观测

`GET /api/v1/health` 返回组件级真实状态（不做假健康）：

```json
{
  "ok": true,
  "version": "0.1.0",
  "mode": "local",
  "components": {
    "db": "ok",                    // PRAGMA quick_check
    "blobs": "ok",                 // blobs/ 目录存在
    "metrics": { "lessons": 42, "runsTotal": 12, "runsActive": 0, "outboxPending": 0, "inputsQueued": 0 }
  }
}
```

告警口径：
- `db != ok` 或 `blobs != ok` → 服务不可用，立即处置（见 §4）。
- `outboxPending` 持续 > 1000 → 事件投递积压，检查 worker 是否存活。
- `runsActive` 长时间 > 0 且无日志 → 运行卡住（查 `run_commands` 表与 worker 日志）。
- 运行级观测走事件账本（`/api/v1/runs/:id/events` 分页补拉），UI 观察区五页签同源。

## 3. 备份与恢复（数据库与 blob 成对）

```bash
pnpm backup                                   # data/ → backups/backup_<时间戳>/
pnpm backup -- --data-dir X --out Y           # 指定目录
pnpm restore -- --from backups/backup_... --to data   # 摘要校验后成对恢复
```

- 备份内容：WAL checkpoint 后的 SQLite 主文件 + `blobs/` + `revisions/` + `exports/`，`MANIFEST.json` 记录逐文件 sha256 与 runs/events 计数。
- 恢复保证：任何文件缺失或摘要不匹配 → `DIGEST_MISMATCH`，**拒绝恢复且不写目标目录**（无半恢复状态）；只有 db 没有 blob 的备份同样拒绝（成对约束）；恢复后自动 `PRAGMA integrity_check` + 计数核对。
- 建议节奏：课堂/演示结束后备份一次；升级代码前必须备份。
- 测试证据：`tests/fault/backup-restore.spec.ts`（正常恢复 / 篡改拒绝 / 缺 blob 拒绝）。

## 4. 常见故障处置

| 现象 | 判断 | 处置 |
|---|---|---|
| 运行停在 `awaiting_approval` | 审批驻留（设计行为，非故障） | UI 对话区审批卡批准/拒绝，或 `POST /api/v1/approvals/:id/decision` |
| worker 停止后输入一直 queued | worker 不在轮询 | 重启 `pnpm dev:worker`；租约过期后 run 会被重新接纳或标记 `reconciliation_required` |
| `SQLITE_BUSY` / 锁等待 | 两个 worker 指向同一 data 目录 | 只保留一个 worker（本地单用户档位假设单 worker） |
| blob 读取 404（ARTIFACT_NOT_FOUND） | blobs 与 db 不同步 | 停止写入 → `pnpm backup`（当前状态留证）→ 用最近一次完整备份恢复 |
| 模型调用全部失败 | 端点/密钥问题 | 设置页「探测」看逐步报告；fake 模拟档位不依赖网络 |
| 事件时间轴缺事件 | 前端断线 | 分页补拉是幂等语义，刷新页面即按 seq 续拉 |

## 5. 负载基准（固定参考环境实测）

参考环境：Windows 11 x64 · Node 24 · node:sqlite（WAL）· 单 worker。
基准测试：`pnpm test:performance`（`tests/performance/replay-load.spec.ts`，5000 事件）。

| 阶段 | 实测值 | 宽松上界（超界即缺陷） |
|---|---|---|
| 5000 事件写入（10×500 事务批） | ~190 ms | — |
| agtrace 导出（含脱敏+摘要） | ~55 ms（191 KB） | 15 s |
| agtrace 导入（含校验） | ~33 ms | 15 s |
| 纯函数投影回放 | ~11 ms | 10 s |

其他观测：L05 全链集成（fake 模型、真实工具、隔离 guest）< 1 s；L26 审批全链 < 1 s；安全测试中忙等脚本被硬超时 SIGKILL（约 3.5 s 含超时窗口）。

## 6. 秘密与网络边界

- 模型密钥只以 `env:变量名` 引用（packages/policy secrets），不落库明文；导出的 .agtrace.zip 经脱敏。
- http_fetch / MCP HTTP / A2A 默认拒绝私网与回环地址（SSRF 防护）；域名白名单由课程声明。
- 学生代码在无秘密子进程客体中执行（PATH-only env + SIGKILL 硬超时）。
- 回放导入不执行包内任何脚本（纯函数投影）。

## 7. 发布检查清单（稳定期）

1. `pnpm typecheck` 0 错误。
2. `pnpm test` 全绿（跳过项必须显式标注原因）。
3. `pnpm verify:lessons` / `verify:source-bindings` / `verify:trace-bundles` 全绿。
4. `pnpm --filter @agentglass/web build` 成功（产物本地化，无 CDN 资源）。
5. `dependency-lock.json` 与 `package.json` 同步（`pnpm gen:lock`；同时充当离线 SBOM 清单）。
6. `pnpm test:performance` 实测值未劣化超出 §5 上界。
7. 备份/恢复演练一次（`pnpm backup` → 删除 data → `pnpm restore` → health ok）。
