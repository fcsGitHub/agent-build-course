# L40 训练接口与诚实边界

只有发生权重更新才能标注为"训练完成"（设计 §17.6）。本交付不含真实训练后端，因此能力矩阵如实报告 training=不可用：

- `TrainingJobService.exportDataset`：纳入 real 运行，排除 synthetic（fake）运行并给出原因。
- `TrainingJobService.createJob`：无后端 → 任务状态 `unsupported`（附原因 TRAINING_BACKEND_UNCONFIGURED）。
- `pollJob`：unsupported 是终态，**不可补标完成**；有后端时 completed 必须携带权重工件摘要，缺摘要 → failed 并说明拒绝原因。

## 观察要点

- 能力降级是设计行为（§4.10）：L40 可以讲解数据流程或回放已有记录，不能把这种模式标为"本次训练完成"。
- UI/API 一致禁用：不存在"假装训练"的入口。
- 事件 `training.dataset_exported` / `training.job_created` 记录数据集版本与任务状态。
