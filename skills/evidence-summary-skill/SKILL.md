---
name: evidence-summary-skill
description: 把资料整理成带证据的摘要：先结论后依据，每条结论标注来源块。
version: 1.0.0
requiredCapabilities:
allowedTools: search_documents
---
# 证据摘要技能

1. 先用 search_documents 检索相关资料。
2. 第一句话给出结论。
3. 之后每条依据单独成行，标注来源：`依据（【c:块ID】）：…`。
4. 资料没有覆盖的部分，明确写"资料未覆盖"。
