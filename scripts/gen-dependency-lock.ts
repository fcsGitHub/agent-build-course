/** 生成 dependency-lock.json：关键工具链摘要 + 合同约束（完整解析树以 pnpm-lock.yaml 为准）。 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const lock = readFileSync("pnpm-lock.yaml", "utf8");
const root = JSON.parse(readFileSync("package.json", "utf8"));
const pkgs: Record<string, { spec: string; resolved: string; section: string }> = {};

function collect(deps: Record<string, string> | undefined, section: string): void {
  const lines = lock.split("\n");
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (spec.startsWith("workspace:")) continue;
    const escaped = name.replace(/[-/]/g, "\\$&");
    // pnpm-lock v9 行格式：  name@1.2.3:   或   '@scope/name@1.2.3':
    const re = new RegExp(`^ {2}'?${escaped}@([0-9][^( ']*)'?:$`);
    for (const line of lines) {
      const m = re.exec(line);
      if (m) {
        pkgs[name] = { spec, resolved: m[1] ?? "see-pnpm-lock.yaml", section };
        break;
      }
    }
    pkgs[name] = pkgs[name] ?? { spec, resolved: "see-pnpm-lock.yaml", section };
  }
}

collect(root.dependencies, "root");
collect(root.devDependencies, "root-dev");

const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  note: "供应链锁摘要：完整解析树以 pnpm-lock.yaml 为准；本文件记录关键工具链与合同约束（设计文档 §2.1/§20.6）。镜像与协议版本在部署时另行锁定。",
  toolchain: {
    node: process.version,
    pnpm: execSync("pnpm --version").toString().trim(),
    typescript: pkgs.typescript?.resolved,
    esbuild: pkgs.esbuild?.resolved,
    vite: pkgs.vite?.resolved,
    react: pkgs.react?.resolved,
    fastify: pkgs.fastify?.resolved,
    vitest: pkgs.vitest?.resolved,
    zod: pkgs.zod?.resolved,
  },
  protocolLocks: {
    openaiCompatWire: "openai/v1 chat completions（stream SSE）",
    mcp: "R1 计划；接入时锁定 spec 版本（设计核查版本 2025-11-25）",
    agtraceBundle: "schemaVersion 1（本仓库定义）",
  },
  constraints: [
    "拒绝浮动 git 依赖与运行镜像 latest 标签",
    "依赖升级必须通过适配器合同测试（provider/tools/events）",
    "许可证摘要与 SBOM 在发布前补全（T35 稳定期任务）",
  ],
  directDependencies: pkgs,
};

writeFileSync("dependency-lock.json", JSON.stringify(out, null, 2) + "\n");
console.log("dependency-lock.json written");
