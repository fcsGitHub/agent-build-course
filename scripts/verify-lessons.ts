/**
 * verify:lessons —— 课程发布检查（T34）。
 * 所有课程必须通过 linter（无 error 级问题）；开放区域文件必须存在。
 */
import { join } from "node:path";
import { LessonRegistry, lintAll } from "../packages/lessons/src/index.js";

const lessonsDir = process.env.AGENTGLASS_LESSONS ?? join(process.cwd(), "lessons");
const registry = new LessonRegistry(lessonsDir);
const catalog = registry.catalog();

if (catalog.length === 0) {
  console.error(`[verify:lessons] 未找到课程（${lessonsDir}）`);
  process.exit(1);
}

const { ok, issues } = lintAll(registry);
for (const issue of issues) {
  const mark = issue.severity === "error" ? "✗" : "!";
  console.log(`${mark} [${issue.lessonId}] ${issue.code}: ${issue.message}`);
}

// 开放区域文件存在性
let missing = 0;
for (const entry of catalog) {
  const policy = registry.editPolicy(entry.id);
  if (!policy) continue;
  const baseline = registry.baselineFiles(entry.id);
  for (const region of policy.regions) {
    if (!(region.path in baseline)) {
      console.error(`✗ [${entry.id}] 开放区域文件缺失: ${region.path}`);
      missing += 1;
    }
  }
}

const expected = 46; // L00-L45（阶段 IX 前沿与 RSI 后的发布底线）
if (catalog.length < expected) {
  console.error(`✗ 课程数量 ${catalog.length} 少于发布底线 ${expected}`);
  process.exit(1);
}

if (!ok || missing > 0) {
  console.error(`[verify:lessons] 失败：${issues.filter((i) => i.severity === "error").length} 个 error，${missing} 个缺失文件`);
  process.exit(1);
}
console.log(`[verify:lessons] 通过：${catalog.length} 门课程全部通过发布检查`);
