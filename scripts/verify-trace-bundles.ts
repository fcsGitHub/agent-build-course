/**
 * verify:trace-bundles —— 运行包完整性检查（T33）。
 * 对 data/exports 下所有 .agtrace.zip 执行导入校验（路径穿越/摘要/事件计数）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importBundle } from "../packages/replay/src/index.js";

const exportsDir = process.env.AGENTGLASS_EXPORTS ?? join(process.cwd(), "data", "exports");
if (!existsSync(exportsDir)) {
  console.log(`[verify:trace-bundles] 无导出目录（${exportsDir}），跳过`);
  process.exit(0);
}
const files = readdirSync(exportsDir).filter((f) => f.endsWith(".agtrace.zip"));
let failures = 0;
for (const file of files) {
  const bytes = readFileSync(join(exportsDir, file));
  const result = importBundle(new Uint8Array(bytes));
  if (!result.ok) {
    console.error(`✗ ${file}: ${result.errors.join("; ")}`);
    failures += 1;
  } else {
    console.log(`✓ ${file}: ${result.events?.length ?? 0} 事件`);
  }
}
if (failures > 0) {
  console.error(`[verify:trace-bundles] 失败：${failures} 个包损坏`);
  process.exit(1);
}
console.log(`[verify:trace-bundles] 通过：${files.length} 个运行包完整`);
