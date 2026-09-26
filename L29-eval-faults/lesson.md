# L29 用评测区分能力问题与系统故障

T26 评测服务支持故障注入（runner 抛错 → 该用例记 failed 而非崩溃）：
1. 正常套件：确定性 grader 逐用例评分；
2. 注入故障（runner 超时/异常）：失败原因可区分"执行失败"与"评分未过"；
3. 模型自述完成 ≠ 环境终态成功（A-gate：环境终态优先）。

## 操作路径

`EvaluationService.freeze(cases) → runSuite(runner)`；测试覆盖注入场景
（tests/integration/r3-multi-agent.spec.ts 评测部分 + 本课）。
