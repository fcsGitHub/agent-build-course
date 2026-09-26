import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@agentglass/db";
import { LessonRegistry } from "@agentglass/lessons";
import { RunCoordinator } from "./coordinator";

// pnpm 脚本以包目录（apps/worker）为 cwd，默认目录相对本文件上溯到仓库根；环境变量可覆盖。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dataDir = process.env.AGENTGLASS_DATA ?? join(repoRoot, "data");
const lessonsDir = process.env.AGENTGLASS_LESSONS ?? join(repoRoot, "lessons");

console.log(`[worker] data dir: ${dataDir}`);
console.log(`[worker] lessons dir: ${lessonsDir}`);

const db = openDatabase({ file: join(dataDir, "agentglass.db") });
const lessons = new LessonRegistry(lessonsDir);

// 预热课程基线 revision（缓存构建）
const coordinator = new RunCoordinator({ db, dataDir, lessons });
for (const entry of lessons.catalog()) {
  try {
    await coordinator.ensureCourseRevision(entry.id);
  } catch (err) {
    console.warn(`[worker] 课程 ${entry.id} 基线构建失败:`, err);
  }
}

coordinator.start();
console.log("[worker] 运行协调器已启动（Ctrl+C 停止）");

process.on("SIGINT", () => {
  coordinator.stop();
  process.exit(0);
});
