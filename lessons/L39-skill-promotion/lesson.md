# L39 自我改进是受控变更，不是越用越聪明

技能修订候选必须依次通过四道门（`packages/evolution` CandidateService）：
1. **证据门**：引用的证据块来自当前文档版本（旧版本 → 拒绝）；
2. **安全回归**：正文无禁用构造、不触碰保护路径/隐藏测试；
3. **冻结验证集**：平台持有的评测集上成功率 ≥ 门槛（候选不可改 grader）；
4. **并发版本检查**：基线版本未变（乐观锁）。

全部通过才晋级新版本；任一拒绝 → 候选记录保留（`candidate.rejected`），不发布。

## 操作路径（服务层/测试演示）

`CandidateService.evaluateAndPromote({ candidate, evalCases, runner, minSuccessRate })`
——门控拒绝矩阵在 `tests/security/candidate-evaluation.spec.ts` 全覆盖。
