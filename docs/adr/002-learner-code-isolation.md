# ADR-002：学习者代码的开放面、构建与执行隔离

**状态：** 已采纳（R0）
**依据：** 设计文档 v1.1 §9.6—§9.8、§19.6（验收 A15—A18、A23）

## 决策

开放单位是服务端登记的**文件 + 具名函数 + 可编辑区域**，不是整个仓库：

1. **范围检查（服务端，不信任前端）**：`patch-guard` 用 TypeScript AST 对比冻结基线——函数签名、导入集合、函数体外的所有字节必须不变；路径穿越/绝对路径/反斜杠/额外文件/删除文件直接拒绝；配额（maxChangedFiles/maxPatchBytes/maxBytes）在服务端复核。
2. **五道安全门槛**：scope → syntax → contracts（导出签名摘要与课程固定合同一致）→ types（内存 CompilerHost，只允许课程文件与 TS 标准库）→ isolation（导入白名单 + 禁用 eval/Function/require/动态 import/process/globalThis）。
3. **冻结构建**：esbuild bundle（format cjs、虚拟文件插件、外部模块解析报错）；产物摘要进入校验报告的六元组绑定；`AgentRevision` 构建后不可变。
4. **运行期隔离**：平台安全测试与真实执行都在 fork 子进程（`workers/learner-runtime`）中进行——最小环境变量（无秘密）、`execArgv: []`、IPC 调用按序号配对、单次调用硬超时（默认 2s，超时 SIGKILL）。忙等代码被杀死并记录策略错误，不静默继续。
5. **宿主硬边界**：扩展函数返回 true 只是"请求继续"；轮数/调用数/墙钟由宿主预算账本强制（测试：贪婪策略 + maxTurns=2 → `budget_turns_exhausted`）。

## 限制（如实声明）

- 子进程隔离不等于多人不可信代码的充分隔离；多人课堂版需按设计 §15.4 引入更强隔离（容器/微 VM + 专用节点），通过安全评审后开放。
- 教学行为断言（learning checks）失败可显式探索试跑；本 R0 将安全测试内建为通用类型/终止性检查，课程级行为断言在 R1 扩展为课程包自带检查束。
