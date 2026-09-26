# L37 经验 → 知识 → 候选：门控分离

失败经验不能直接变成操作策略（§17 禁止捷径）。演进链路：
**经验 → Wiki 修订提案（带证据）→ 门控 → 发布 → 才能被技能引用**。

## 本课事实

- 手册 v1（12V/6 个月）已被 v2（24V/12 个月）取代。
- 基于 v1 证据的 Wiki 提案会触发 `evidence_superseded` 冲突 → **拒绝发布**；
  基于 v2 证据的提案可发布。

## 操作路径（API）

```bash
POST /api/v1/wiki/pages            # 提案（claims + evidenceChunkIds）
POST /api/v1/wiki/revisions/:id/publish   # 冲突时 409
GET  /api/v1/wiki/impact/:docRevisionId   # 影响分析
```

## 判断

"曾经是对的"不等于"现在还是对的"——证据的**版本**是知识的一部分。
