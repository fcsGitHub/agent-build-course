# AGENTS.md — 给本仓库的自动化贡献者/评审代理

## 项目身份

AgentGlass：Agent 原理可观测实验室。设计基线：`doc/AgentGlass_Agent教学软件_设计方案与开发计划_v1.1.md`。
当前实现范围：R6（真实模型调用、真实工具、事件账本、受控代码编辑与隔离执行、回放、流程图断点、课程 L00—L45 共 46 门，阶段 IX 为前沿与 RSI：L42 前沿全景 / L43 上下文工程 / L44 DeepResearch 多源研究 / L45 有界 RSI 循环；R6：子 agent 全链可观测（worker 模型事件带 workerId）、对话区多 agent 通信输出（委派/移交/结果/MCP/A2A/技能卡 + worker 回合 + Σ 合并输出）、上下文轮间对比（⇄ 上一轮，新增/移除高亮）、框图按 worker 精确路由信息包）。

## 硬约束（违反即缺陷）

1. **真实执行优先**：禁止用隐藏 mock 冒充"实时运行"。fake 提供方必须显式标注（provider=fake，UI/事件可见"模拟"）。
2. **用户主导对话**：打开课程/会话零模型调用；案例提示只入草稿；课程 linter 拒绝 auto_send / 预置对话。
3. **平台边界不可被学生代码修改**：权限、预算、工具授权、审批在服务端；学习者代码只经隔离客体 + 受控代理；`packages/policy`、事件注册表、grader 不在编辑开放面。
4. **回放不执行**：投影 reducer 为纯函数；`.agtrace.zip` 导入不得执行包内脚本。
5. **诚实报告**：测试区分 passed/failed/skipped/unsupported/not_run；未实现能力在 UI 与 API 一致禁用（见 docs/adr/005）。

## 常用命令

```bash
pnpm typecheck          # 全仓 strict
pnpm test               # 全部测试（tests/ 下 42 个文件 213 项 + 2 个显式跳过）
pnpm verify:lessons     # 课程发布 linter
pnpm verify:source-bindings
pnpm verify:trace-bundles
pnpm gen:lock           # 重新生成 dependency-lock.json
```

## 变更约定

- 跨包只依赖公共合同（`packages/*/src/index.ts` 导出）；不 import 其他包内部文件。
- 事件类型必须先注册进 `packages/contracts/src/events.ts` 的 EVENT_REGISTRY。
- 修改模型/工具/权限/事件/恢复路径时，必须补充对应 security 或 fault 测试（设计 §25.3）。
- 数据库 schema 变更：新增 `packages/db/migrations/00N-*.sql` 并同步 `migrate()` 文件清单。
- 前端离线优先：不引入 CDN 资源；构建产物本地化。
