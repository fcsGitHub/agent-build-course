import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
  },
  resolve: {
    alias: {
      "@agentglass/contracts": new URL("./packages/contracts/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/events": new URL("./packages/events/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/policy": new URL("./packages/policy/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/provider-gateway": new URL("./packages/provider-gateway/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/tools": new URL("./packages/tools/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/context": new URL("./packages/context/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/source-map": new URL("./packages/source-map/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/runtime-reference": new URL("./packages/runtime-reference/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/conversation": new URL("./packages/conversation/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/code-lab": new URL("./packages/code-lab/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/projections": new URL("./packages/projections/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/knowledge": new URL("./packages/knowledge/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/replay": new URL("./packages/replay/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/a2a": new URL("./packages/a2a/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/evolution": new URL("./packages/evolution/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/multi-agent": new URL("./packages/multi-agent/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/evaluation": new URL("./packages/evaluation/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/mcp": new URL("./packages/mcp/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/harness": new URL("./packages/harness/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/skills": new URL("./packages/skills/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/runtime-graph": new URL("./packages/runtime-graph/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/lessons": new URL("./packages/lessons/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/learner-runtime": new URL("./workers/learner-runtime/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "@agentglass/worker": new URL("./apps/worker/src/index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    },
  },
});
