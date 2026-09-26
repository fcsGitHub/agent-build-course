# L18 安装 ≠ 授权，加载 ≠ 执行

技能包三层渐进加载：
1. **元信息**（list_skills）：名称/描述/版本 —— 用于选择；
2. **正文**（load_skill）：SKILL.md body 进入上下文 —— 每次加载产生事件与上下文增量；
3. **脚本/资源**：需要独立能力授权 —— 本版本脚本一律不执行（诚实返回 NOT_AUTHORIZED）。

## 观察

1. 先 load_skill 加载 evidence-summary-skill，看工具卡的正文内容。
2. 尝试加载不在课程白名单的技能 → `SKILL_NOT_ALLOWED`（白名单由课程 manifest 决定，不由模型决定）。
