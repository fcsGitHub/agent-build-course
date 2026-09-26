# L12 Wiki 不是答案缓存

Wiki 页面 = 正文 + 论断（claims）+ 证据链接（块/文档版本）+ 冲突记录 + 审核状态（draft → reviewed → published → superseded）。

## 本课事实（服务端预置）

课程资料已按两代文档装配：手册 v1（电压 12V / 滤芯 6 个月）与 v2（电压 24V / 滤芯 12 个月）。
基于 v1 证据的 Wiki 论断，在 v2 导入后会被**影响分析**定位，并被标记 `evidence_superseded` 冲突——
冲突不静默合并：页面保持 draft，直到用新证据复核。

## 操作路径（API 演示）

```bash
# 提案（带证据块 ID）
POST /api/v1/wiki/pages {"slug":"ag-2048-spec","body":"...","claims":[...]}
# 发布（有冲突则被拒绝 WIKI_CONFLICTS_UNRESOLVED）
POST /api/v1/wiki/revisions/{id}/publish
# 影响分析
GET  /api/v1/wiki/impact/{docRevisionId}
```

## 判断

引用存在 ≠ 引用支持结论；"检索到旧参数" 不等于 "当前参数就是它"。
