# L20 图必然终止：分支 + 访问上限

图：`entry → classify（模型分支判断）→ gather（检索）→ gate（transform 证据汇总）→ answer（终止）`，
`gate → gather` 有 `visits_under_limit` 边（有限回环，maxNodeVisits=2）。

## 实验

1. 问一个资料能回答的问题：看 gather→gate→answer 一路走完。
2. 访问上限：gather 第二次执行后 `visits_under_limit` 不再满足，图走终止路径或以
   `visit_limit_reached` 结束——**自动循环必须有边界**。
3. 悬空边/未注册谓词的图会在启动时被校验器拒绝（`graph_invalid`），不会带病运行。
