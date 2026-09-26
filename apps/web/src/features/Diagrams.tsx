/**
 * 观察区框图（内联 SVG，archify 风格）：
 * - 架构图：以课程 manifest（服务端持有，不可被运行时修改）为真相源的静态拓扑；
 *   节点按真实事件计数点亮，运行中边线流动（marching-ants），最近活动节点脉冲。
 * - 信息流图：同一拓扑上，真实事件作为"信息包"沿边移动（CSS motion path，
 *   插入即播放、到达后淡出），与下方事件明细一一对应。
 * - 断点：可断节点（模型/工具/停止判定/图节点）可点击设置断点；命中时节点红环驻留。
 * 拓扑为纯函数：linear（单链）/ loop（agent 循环）/ fan（多 agent）/ grid（状态图）。
 */
import type { ReactElement } from "react";
import type { LessonManifestDto, TraceEvent } from "../api";

export type NodeCls = "io" | "ctx" | "model" | "tool" | "policy" | "agent" | "special";

export interface GNode {
  id: string;
  label: string;
  sub?: string;
  /** 真实事件计数；null/undefined 表示不计数（I/O 节点） */
  count?: number | null;
  cls: NodeCls;
  dashed?: boolean;
  /** 断点目标：边界名（before_model 等）或 node:<graphNodeId>；undefined = 不可断 */
  breakpoint?: string;
  /** 多 agent：本节点对应的 worker id（事件 summary.workerId 据此精确路由） */
  agentId?: string;
}

export interface GEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind: "main" | "loop" | "fan" | "merge" | "branch";
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  layout: "linear" | "loop" | "fan" | "grid";
}

/** 由 manifest（服务端真相源）+ 已发生事件构建拓扑 */
export function buildGraph(manifest: LessonManifestDto, events: TraceEvent[]): Graph {
  const count = (t: string): number => events.filter((e) => e.type === t).length;
  const rt = manifest.runtime;
  const profile = rt.profile;
  const lastStop = events.filter((e) => e.type === "policy.stop_decision").at(-1);
  const modelCalls = count("model.request_dispatched");
  const toolCalls = count("tool.call_completed");
  const ctxCount = count("context.compiled");

  if (profile === "agent_loop") {
    return {
      layout: "loop",
      nodes: [
        { id: "input", label: "用户输入", cls: "io" },
        { id: "ctx", label: "上下文编译", sub: "原子组 + 预算选择", count: ctxCount, cls: "ctx" },
        { id: "model", label: "模型调用", count: modelCalls, cls: "model", breakpoint: "before_model" },
        { id: "tool", label: "工具执行", sub: "白名单 ∩ schema 校验", count: toolCalls, cls: "tool", breakpoint: "before_tool" },
        {
          id: "policy",
          label: "停止判定",
          sub: lastStop
            ? `第 ${String(lastStop.summary.completedTurns)} 轮 → ${lastStop.summary.decision === "continue" ? "继续" : "停止"}`
            : "shouldContinue / 硬预算",
          count: count("policy.stop_decision"),
          cls: "policy",
          breakpoint: "turn_end",
        },
        { id: "output", label: "最终输出", cls: "io" },
      ],
      edges: [
        { id: "E:input:ctx", from: "input", to: "ctx", kind: "main" },
        { id: "E:ctx:model", from: "ctx", to: "model", kind: "main" },
        { id: "E:model:tool", from: "model", to: "tool", kind: "main" },
        { id: "E:tool:policy", from: "tool", to: "policy", kind: "main" },
        { id: "E:policy:output", from: "policy", to: "output", kind: "main", label: "停止" },
        { id: "E:policy:ctx", from: "policy", to: "ctx", kind: "loop", label: "继续下一轮" },
      ],
    };
  }

  if (profile === "chain" && rt.chain_steps) {
    const nodes: GNode[] = [{ id: "input", label: "用户输入", cls: "io" }];
    rt.chain_steps.forEach((s, i) => {
      nodes.push({
        id: `step${i}`,
        label: `步骤 ${i + 1}`,
        sub: `${s.instruction.slice(0, 22)}（${s.allow_tools ? "可用工具" : "无工具"}）`,
        count: s.allow_tools ? toolCalls : undefined,
        cls: s.allow_tools ? "tool" : "ctx",
        breakpoint: "before_model",
      });
    });
    const lastStep = `step${rt.chain_steps.length - 1}`;
    if (rt.reflection_on_failure) {
      nodes.push({
        id: "reflect",
        label: "失败反思注入",
        sub: "工具失败 → 结构化反思 → 下一步",
        count: count("reflection.recorded"),
        cls: "special",
        dashed: true,
      });
    }
    nodes.push({ id: "output", label: "最终输出", cls: "io" });
    const edges: GEdge[] = [];
    let prev = "input";
    rt.chain_steps.forEach((_, i) => {
      edges.push({ id: `E:${prev}:step${i}`, from: prev, to: `step${i}`, kind: "main" });
      prev = `step${i}`;
    });
    if (rt.reflection_on_failure) {
      edges.push({ id: `E:${lastStep}:reflect`, from: lastStep, to: "reflect", kind: "branch", label: "失败时" });
      edges.push({ id: "E:reflect:output", from: "reflect", to: "output", kind: "branch" });
    }
    edges.push({
      id: `E:${lastStep}:output`,
      from: lastStep,
      to: "output",
      kind: "main",
      label: rt.reflection_on_failure ? "成功" : undefined,
    });
    return { nodes, edges, layout: "linear" };
  }

  if (profile === "multi_agent" && rt.multi_agent) {
    const ma = rt.multi_agent;
    // 每个 worker 的真实完成次数（其模型 response_completed 计数）
    const workerDone = new Map<string, number>();
    for (const e of events) {
      if (e.type === "model.response_completed" && typeof e.summary.workerId === "string") {
        const wid = e.summary.workerId;
        workerDone.set(wid, (workerDone.get(wid) ?? 0) + 1);
      }
    }
    return {
      layout: "fan",
      nodes: [
        { id: "input", label: "任务包", sub: "子 agent 上下文隔离", cls: "io" },
        { id: "coord", label: `协调器（${ma.topology}）`, count: count("agent.delegated"), cls: "policy" },
        ...ma.workers.map((w, i) => ({
          id: `worker${i}`,
          label: `worker ${w.id}`,
          sub: w.goal.slice(0, 24),
          count: workerDone.get(w.id) ?? 0,
          cls: "agent" as NodeCls,
          breakpoint: "before_model",
          agentId: w.id,
        })),
        {
          id: "merge",
          label: ma.topology === "blackboard" ? "黑板合并（冲突保留两版本）" : "确定性合并",
          count: count("agent.result_received"),
          cls: "ctx",
        },
        { id: "output", label: "输出", cls: "io" },
      ],
      edges: [
        { id: "E:input:coord", from: "input", to: "coord", kind: "main" },
        ...ma.workers.map((_, i) => ({ id: `E:coord:worker${i}`, from: "coord", to: `worker${i}`, kind: "fan" as const })),
        ...ma.workers.map((_, i) => ({ id: `E:worker${i}:merge`, from: `worker${i}`, to: "merge", kind: "merge" as const })),
        { id: "E:merge:output", from: "merge", to: "output", kind: "main" },
      ],
    };
  }

  if (profile === "recursion" && rt.recursion) {
    return {
      layout: "linear",
      nodes: [
        {
          id: "input",
          label: `长输入（${rt.recursion.partition_chars ?? 1200} 字符分区）`,
          sub: "外部化：blob 存储，事件只引用",
          cls: "io",
        },
        {
          id: "tree",
          label: `递归树（深度 ≤ ${rt.recursion.max_depth}，硬上限 8）`,
          sub: rt.recursion.question.slice(0, 24),
          count: count("recursion.node_completed"),
          cls: "agent",
          breakpoint: "before_model",
        },
        { id: "output", label: "合并输出", sub: "缺失分区如实声明", cls: "io" },
      ],
      edges: [
        { id: "E:input:tree", from: "input", to: "tree", kind: "main" },
        { id: "E:tree:output", from: "tree", to: "output", kind: "main" },
      ],
    };
  }

  if (profile === "graph") {
    const def = rt.graph;
    if (def && def.nodes.length > 0) {
      // 状态图课程：渲染 graph.json 的真实节点/边（分层 DAG，谓词边虚线）
      const completedByNode = new Map<string, number>();
      for (const e of events) {
        if (e.type === "graph.node_completed") {
          const nid = String(e.summary.nodeId ?? "");
          if (nid) completedByNode.set(nid, (completedByNode.get(nid) ?? 0) + 1);
        }
      }
      const kindCls: Record<string, NodeCls> = { model: "model", tool: "tool", transform: "ctx", gate: "policy" };
      return {
        layout: "grid",
        nodes: def.nodes.map((n) => ({
          id: `gn:${n.id}`,
          label: n.id,
          sub: n.kind === "model" || n.kind === "tool" ? String(n.handlerId ?? "").slice(0, 22) : n.kind,
          count: completedByNode.get(n.id) ?? 0,
          cls: kindCls[n.kind] ?? "ctx",
          breakpoint: `node:${n.id}`,
        })),
        edges: def.edges.map((e, i) => ({
          id: `E:gn:${e.from}:${e.to}:${i}`,
          from: `gn:${e.from}`,
          to: `gn:${e.to}`,
          kind: e.predicateId ? "branch" : "main",
          label: e.predicateId,
        })),
      };
    }
    return {
      layout: "linear",
      nodes: [
        { id: "input", label: "输入", cls: "io" },
        { id: "graph", label: "状态图执行器", sub: "注册谓词分支 · 访问上限", count: count("graph.node_completed"), cls: "policy" },
        { id: "output", label: "输出", cls: "io" },
      ],
      edges: [
        { id: "E:input:graph", from: "input", to: "graph", kind: "main" },
        { id: "E:graph:output", from: "graph", to: "output", kind: "main" },
      ],
    };
  }

  if (profile === "rsi") {
    // L45：DGM 教学骨架 —— 归档（记忆）× 变异（生成器）× 冻结集评估（评估器）× 晋级门
    const evalCount = count("candidate.evaluated");
    const gateCount = count("candidate.promoted") + count("candidate.rejected");
    return {
      layout: "loop",
      nodes: [
        { id: "input", label: "改进目标 + 冻结验证集", sub: "验证集平台持有，候选不可见", cls: "io" },
        { id: "archive", label: "变体归档", sub: "被拒变体保留（垫脚石）", count: count("rsi.generation_completed"), cls: "agent" },
        { id: "mutate", label: "变异提案", sub: `模型改写 system prompt（代数 ≤ ${rt.rsi?.max_generations ?? 3}，硬上限 3）`, count: count("rsi.generation_started"), cls: "model", breakpoint: "before_model" },
        { id: "evaluate", label: "冻结集评估", sub: "同一把尺子 · 确定性判分", count: evalCount, cls: "tool", breakpoint: "before_model" },
        { id: "gate", label: "晋级门", sub: "严格改进才替换最优", count: gateCount, cls: "policy" },
        { id: "output", label: "报告 + 诚实边界", sub: "权重级 RSI 不可执行（对照 L40）", cls: "io" },
      ],
      edges: [
        { id: "E:input:archive", from: "input", to: "archive", kind: "main" },
        { id: "E:archive:mutate", from: "archive", to: "mutate", kind: "main", label: "父代 = 当前最优" },
        { id: "E:mutate:evaluate", from: "mutate", to: "evaluate", kind: "main" },
        { id: "E:evaluate:gate", from: "evaluate", to: "gate", kind: "main" },
        { id: "E:gate:archive", from: "gate", to: "archive", kind: "loop", label: "入档（晋级/保留）" },
        { id: "E:gate:output", from: "gate", to: "output", kind: "main", label: "代数上限" },
      ],
    };
  }

  // single_call 及未知 profile 的兜底
  return {
    layout: "linear",
    nodes: [
      { id: "input", label: "用户输入", cls: "io" },
      { id: "model", label: "模型调用", count: modelCalls, cls: "model", breakpoint: "before_model" },
      { id: "output", label: "输出", cls: "io" },
    ],
    edges: [
      { id: "E:input:model", from: "input", to: "model", kind: "main" },
      { id: "E:model:output", from: "model", to: "output", kind: "main" },
    ],
  };
}

// ───────────────────────── 布局 ─────────────────────────

interface Box {
  node: GNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

const VIEW_W = 500;
const NODE_X = 64;
const NODE_W = 330;
const GAP = 34;

function nodeHeight(n: GNode): number {
  return n.sub ? 58 : 44;
}

function layout(graph: Graph): { boxes: Map<string, Box>; height: number } {
  if (graph.layout === "grid") return layoutGrid(graph);
  const boxes = new Map<string, Box>();
  let y = 14;
  for (const n of graph.nodes) {
    if (n.id === "merge" && graph.layout === "fan") y += 6;
    boxes.set(n.id, { node: n, x: NODE_X, y, w: NODE_W, h: nodeHeight(n) });
    y += nodeHeight(n) + (graph.layout === "fan" && n.id.startsWith("worker") ? 16 : GAP);
  }
  return { boxes, height: y - GAP + 12 };
}

/** 状态图布局：按最长路径分层，同层横排 */
function layoutGrid(graph: Graph): { boxes: Map<string, Box>; height: number } {
  const boxes = new Map<string, Box>();
  const ids = graph.nodes.map((n) => n.id);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) incoming.get(e.to)?.push(e.from);
  const layerOf = new Map<string, number>();
  const layer = (id: string, seen: Set<string>): number => {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (seen.has(id)) return 0; // 环：按访问上限语义放在当前层
    seen.add(id);
    const preds = incoming.get(id) ?? [];
    const l = preds.length === 0 ? 0 : Math.max(...preds.map((p) => layer(p, seen))) + 1;
    layerOf.set(id, l);
    return l;
  };
  for (const id of ids) layer(id, new Set());
  const rows = new Map<number, GNode[]>();
  for (const n of graph.nodes) {
    const l = layerOf.get(n.id) ?? 0;
    rows.set(l, [...(rows.get(l) ?? []), n]);
  }
  const rowKeys = [...rows.keys()].sort((a, b) => a - b);
  let y = 14;
  const maxRow = Math.max(...[...rows.values()].map((r) => r.length));
  for (const key of rowKeys) {
    const row = rows.get(key)!;
    const gapX = 14;
    const w = Math.min(220, Math.floor((VIEW_W - 2 * 16 - gapX * (row.length - 1)) / row.length));
    const totalW = row.length * w + gapX * (row.length - 1);
    const x0 = (VIEW_W - totalW) / 2;
    row.forEach((n, i) => {
      boxes.set(n.id, { node: n, x: Math.round(x0 + i * (w + gapX)), y, w, h: nodeHeight(n) });
    });
    y += Math.max(...row.map(nodeHeight)) + GAP + (maxRow > 2 ? 8 : 0);
  }
  return { boxes, height: y - GAP + 12 };
}

function fanK(edge: GEdge, graph: Graph): number {
  const siblings = graph.edges.filter((e) => e.kind === edge.kind && e.from === edge.from);
  const i = siblings.findIndex((e) => e.id === edge.id);
  return (i - (siblings.length - 1) / 2) * 120;
}

function edgePath(edge: GEdge, graph: Graph, boxes: Map<string, Box>): string {
  const a = boxes.get(edge.from)!;
  const b = boxes.get(edge.to)!;
  const cx = a.x + a.w / 2;
  if (edge.kind === "loop") {
    const xR = VIEW_W - 14;
    const ay = a.y + a.h / 2;
    const by = b.y + b.h / 2;
    return `M ${a.x + a.w} ${ay} L ${xR - 6} ${ay} Q ${xR} ${ay} ${xR} ${ay - 6} L ${xR} ${by + 6} Q ${xR} ${by} ${xR - 6} ${by} L ${a.x + a.w + 3} ${by}`;
  }
  if (edge.kind === "fan" || edge.kind === "merge") {
    const k = fanK(edge, graph);
    const sy = edge.kind === "fan" ? a.y + a.h : a.y;
    const ey = edge.kind === "fan" ? b.y : b.y + b.h;
    return `M ${cx} ${sy} C ${cx + k} ${sy + 22}, ${cx + k} ${ey - 22}, ${cx} ${ey}`;
  }
  if (edge.kind === "branch" && graph.layout === "grid") {
    const ax = a.x + a.w / 2;
    const bx = b.x + b.w / 2;
    const sy = a.y + a.h;
    const ey = b.y;
    const mx = (ax + bx) / 2;
    return `M ${ax} ${sy} C ${ax} ${sy + 26}, ${bx} ${ey - 26}, ${bx} ${ey}`;
  }
  if (edge.kind === "branch") {
    return `M ${cx + 52} ${a.y + a.h} L ${b.x + b.w / 2 + 52} ${b.y}`;
  }
  return `M ${cx} ${a.y + a.h} L ${cx} ${b.y}`;
}

// ───────────────────────── 事件 → 图元素映射 ─────────────────────────

interface Touch {
  edgeId?: string;
  nodeId?: string;
  cls: NodeCls;
}

function nodeByCls(graph: Graph, cls: NodeCls): GNode | undefined {
  return graph.nodes.find((n) => n.cls === cls && n.id !== "coord");
}

function edgeInto(graph: Graph, nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  return graph.edges.find((e) => e.to === nodeId && e.kind !== "loop" && e.kind !== "merge")?.id;
}

/** 一个真实事件对应图中的一次触达：信息包沿边移动 + 节点点亮 */
export function eventTouch(graph: Graph, e: TraceEvent): Touch[] {
  const io = graph.nodes.find((n) => n.id === "input");
  const out = [...graph.nodes].reverse().find((n) => n.cls === "io");
  const ctx = nodeByCls(graph, "ctx");
  const model = nodeByCls(graph, "model");
  const tool = nodeByCls(graph, "tool");
  const policy = nodeByCls(graph, "policy");
  const wid = typeof e.summary.workerId === "string" ? e.summary.workerId : undefined;
  const graphNode = (id: string | undefined): string | undefined =>
    id != null && graph.nodes.some((n) => n.id === `gn:${id}`) ? `gn:${id}` : undefined;
  switch (e.type) {
    case "input.accepted":
      return [{ edgeId: edgeInto(graph, io?.id), nodeId: io?.id, cls: "io" }];
    case "context.compiled":
      if (wid != null) return touchWorker(graph, wid, []);
      return [{ edgeId: edgeInto(graph, ctx?.id), nodeId: ctx?.id, cls: "ctx" }];
    case "model.request_prepared":
    case "model.request_dispatched":
    case "model.delta_batch":
      if (wid != null) return touchWorker(graph, wid, []);
      return [{ edgeId: edgeInto(graph, model?.id), nodeId: model?.id, cls: "model" }];
    case "model.response_completed": {
      if (wid != null) return touchWorker(graph, wid, []);
      const toTool = graph.edges.find((ed) => ed.from === model?.id && ed.to === tool?.id)?.id;
      return [{ edgeId: toTool, nodeId: toTool ? tool?.id : out?.id, cls: toTool ? "tool" : "io" }];
    }
    case "tool.proposed":
    case "mcp.protocol_event":
    case "mcp.server_connected":
      return [{ edgeId: edgeInto(graph, tool?.id), nodeId: tool?.id, cls: "tool" }];
    case "tool.call_completed":
      return [{ edgeId: edgeInto(graph, policy?.id), nodeId: policy?.id ?? tool?.id, cls: policy ? "policy" : "tool" }];
    case "tool.denied":
    case "approval.requested":
    case "approval.granted":
    case "approval.rejected":
      return [{ nodeId: tool?.id, cls: "tool" }];
    case "policy.stop_decision": {
      if (String(e.summary.decision) === "continue") {
        const loop = graph.edges.find((ed) => ed.kind === "loop");
        return loop ? [{ edgeId: loop.id, nodeId: loop.to, cls: "ctx" }] : [];
      }
      const last = graph.edges.find((ed) => ed.to === out?.id && ed.kind === "main");
      return last ? [{ edgeId: last.id, nodeId: out?.id, cls: "io" }] : [];
    }
    case "agent.delegated": {
      const fallback = graph.edges
        .filter((ed) => ed.kind === "fan")
        .map((ed) => ({ edgeId: ed.id, nodeId: ed.to, cls: "agent" as NodeCls }));
      return touchWorker(graph, wid, fallback);
    }
    case "agent.result_received": {
      const fallback = graph.edges
        .filter((ed) => ed.kind === "merge")
        .map((ed) => ({ edgeId: ed.id, nodeId: ed.to, cls: "ctx" as NodeCls }));
      return touchWorkerMerge(graph, wid, fallback);
    }
    case "agent.handed_off": {
      const to = String(e.summary.to ?? "");
      const fromId = String(e.summary.from ?? "");
      if (to === "(final)") {
        const last = graph.edges.find((ed) => ed.to === out?.id && ed.kind === "main");
        return last ? [{ edgeId: last.id, nodeId: out?.id, cls: "io" }] : [];
      }
      const merged: Touch[] = [];
      const fromNode = graph.nodes.find((n) => n.agentId === fromId);
      const toNode = graph.nodes.find((n) => n.agentId === to);
      if (fromNode && toNode) {
        const hop = graph.edges.find((ed) => ed.kind === "merge" && ed.from === fromNode.id);
        const fan = graph.edges.find((ed) => ed.kind === "fan" && ed.to === toNode.id);
        if (hop) merged.push({ edgeId: hop.id, nodeId: fromNode.id, cls: "agent" });
        if (fan) merged.push({ edgeId: fan.id, nodeId: toNode.id, cls: "agent" });
      }
      return merged;
    }
    case "a2a.agent_connected":
      return graph.edges
        .filter((ed) => ed.kind === "fan")
        .slice(0, 1)
        .map((ed) => ({ edgeId: ed.id, nodeId: ed.to, cls: "agent" as NodeCls }));
    case "skill.loaded":
      return [{ nodeId: ctx?.id, cls: "ctx" }];
    case "recursion.node_started":
    case "recursion.node_completed":
      return [{ nodeId: "tree", cls: "agent" }];
    case "graph.node_started":
    case "graph.node_completed": {
      const nid = graphNode(String(e.summary.nodeId ?? ""));
      if (nid) return [{ nodeId: nid, cls: "policy" }];
      return [{ nodeId: "graph", cls: "policy" }];
    }
    case "reflection.recorded":
      return [{ nodeId: "reflect", cls: "special" }];
    case "rsi.generation_started":
      return touchById(graph, "mutate", "model");
    case "candidate.evaluated":
      return touchById(graph, "evaluate", "tool");
    case "candidate.promoted":
    case "candidate.rejected":
      return touchById(graph, "gate", "policy");
    case "rsi.generation_completed":
      return touchById(graph, "archive", "agent");
    case "run.completed":
      return [{ nodeId: out?.id, cls: "io" }];
    default:
      return [];
  }
}

/** 按 id 触达节点（节点不存在则无触达；rsi/演进事件在非 rsi 课程中安全返回空） */
function touchById(graph: Graph, id: string, cls: NodeCls): Touch[] {
  const node = graph.nodes.find((n) => n.id === id);
  return node ? [{ edgeId: edgeInto(graph, id), nodeId: id, cls }] : [];
}

/** 按 worker id 触达其节点与入边（多 agent：委派/流式/结果精确路由到具体子 agent） */
function touchWorker(graph: Graph, workerId: string | undefined, fallback: Touch[]): Touch[] {
  if (workerId == null) return fallback;
  const node = graph.nodes.find((n) => n.agentId === workerId);
  if (!node) return fallback;
  const edge = graph.edges.find((e) => e.kind === "fan" && e.to === node.id);
  return [{ edgeId: edge?.id, nodeId: node.id, cls: "agent" }];
}

/** 按 worker id 触达其归并边（result_received → 具体 worker 的贡献路径） */
function touchWorkerMerge(graph: Graph, workerId: string | undefined, fallback: Touch[]): Touch[] {
  if (workerId == null) return fallback;
  const node = graph.nodes.find((n) => n.agentId === workerId);
  if (!node) return fallback;
  const edge = graph.edges.find((e) => e.kind === "merge" && e.from === node.id);
  return [{ edgeId: edge?.id, nodeId: edge ? edge.to : node.id, cls: "ctx" }];
}

/** 最近被触达的节点（架构图脉冲高亮用） */
export function lastTouchedNode(graph: Graph, events: TraceEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    const t = eventTouch(graph, ev).at(-1);
    if (t?.nodeId) return t.nodeId;
  }
  return undefined;
}

// ───────────────────────── 渲染 ─────────────────────────

const CLS_LEGEND: Array<[NodeCls, string]> = [
  ["io", "输入 / 输出"],
  ["ctx", "上下文 / 合并"],
  ["model", "模型"],
  ["tool", "工具"],
  ["policy", "策略 / 控制"],
  ["agent", "子 agent / 递归"],
  ["special", "反思 / 特殊"],
];

/** 断点目标的中文说明（节点悬停提示 / 状态行共用） */
export function breakpointLabel(target: string): string {
  if (target.startsWith("node:")) return `图节点 ${target.slice(5)} 开始前`;
  switch (target) {
    case "before_model":
      return "每次模型调用前";
    case "before_tool":
      return "每次工具执行前";
    case "after_tool":
      return "每次工具执行后";
    case "turn_end":
      return "每轮结束（检查点提交前）";
    default:
      return target;
  }
}

export function GraphDiagram(props: {
  graph: Graph;
  running: boolean;
  pulseNodeId?: string;
  packets?: Array<{ seq: number; edgeId: string; cls: NodeCls }>;
  /** 已设置的断点目标集合 */
  breakpoints?: string[];
  /** 点击可断节点时回调（提供即开启断点交互） */
  onToggleBreakpoint?: (target: string) => void;
  /** 当前命中驻留的断点目标 */
  pausedTarget?: string;
}) {
  const { graph, running, pulseNodeId, packets, breakpoints, onToggleBreakpoint, pausedTarget } = props;
  const { boxes, height } = layout(graph);
  const flowing = running; // 边线流动只在真实运行中；信息包按事件一次性播放后淡出
  const bpSet = new Set(breakpoints ?? []);
  // 脉冲节点的入边高亮（真实活动的路径）
  const liveEdgeIds = new Set<string>(
    pulseNodeId != null ? graph.edges.filter((e) => e.to === pulseNodeId).map((e) => e.id) : [],
  );
  const pausedNode = pausedTarget != null ? graph.nodes.find((n) => n.breakpoint === pausedTarget) : undefined;

  return (
    <svg
      className="dg"
      viewBox={`0 0 ${VIEW_W} ${height}`}
      width="100%"
      role="img"
      aria-label="执行架构框图"
    >
      <defs>
        <marker id="dg-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z"  />
        </marker>
        <marker id="dg-arrow-accent" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z"  />
        </marker>
      </defs>

      {/* 边在下层 */}
      {graph.edges.map((edge) => {
        const boxFrom = boxes.get(edge.from)!;
        const midY =
          edge.kind === "loop"
            ? (boxFrom.y + boxFrom.h / 2 + boxes.get(edge.to)!.y + boxes.get(edge.to)!.h / 2) / 2
            : edge.kind === "fan" || edge.kind === "merge"
              ? (boxFrom.y + boxFrom.h + boxes.get(edge.to)!.y) / 2
              : (boxFrom.y + boxFrom.h + boxes.get(edge.to)!.y) / 2;
        const live = liveEdgeIds.has(edge.id);
        return (
          <g key={edge.id}>
            <path
              id={edge.id}
              d={edgePath(edge, graph, boxes)}
              className={`dg-edge dg-edge-${edge.kind} ${flowing ? "dg-flow" : ""} ${live ? "dg-edge-live" : ""}`}
              markerEnd={flowing || live ? "url(#dg-arrow-accent)" : "url(#dg-arrow)"}
            />
            {edge.label && (
              <text
                className="dg-elabel"
                x={edge.kind === "loop" ? VIEW_W - 22 : boxFrom.x + boxFrom.w / 2 + 9}
                y={midY + 4}
                textAnchor={edge.kind === "loop" ? "end" : "start"}
              >
                {edge.label}
              </text>
            )}
          </g>
        );
      })}

      {/* 信息包（信息流图）：CSS motion path 沿边移动，插入即播放，到达后淡出 */}
      {packets?.map((p) => {
        const d = pathD(graph, boxes, p.edgeId);
        return (
          <circle
            key={p.seq}
            r="4.2"
            className={`dg-packet pk-${p.cls}`}
            style={d ? { offsetPath: `path("${d}")`, animationDelay: `${(p.seq % 8) * 0.06}s` } : undefined}
          />
        );
      })}

      {/* 节点在上层 */}
      {[...boxes.values()].map((box) => {
        const { node, x, y, w, h } = box;
        const lit = node.count == null || node.count > 0;
        const hasBp = node.breakpoint != null && bpSet.has(node.breakpoint);
        const pausedHere = pausedNode?.id === node.id;
        const clickable = node.breakpoint != null && onToggleBreakpoint != null;
        return (
          <g
            key={node.id}
            className={[
              "dg-node",
              pulseNodeId === node.id ? "dg-pulse" : "",
              hasBp ? "dg-has-bp" : "",
              pausedHere ? "dg-paused-bp" : "",
              clickable ? "dg-clickable" : "",
            ].join(" ")}
            onClick={clickable ? () => onToggleBreakpoint!(node.breakpoint!) : undefined}
          >
            {clickable && (
              <title>
                {hasBp ? "取消断点" : "设置断点"}：{breakpointLabel(node.breakpoint!)}暂停（可反复命中）
              </title>
            )}
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={10}
              className={`dg-rect dg-c-${node.cls} ${lit ? "dg-lit" : "dg-dim"}`}
              strokeDasharray={node.dashed ? "5 4" : undefined}
            />
            <rect x={x} y={y + 9} width={3.5} height={h - 18} rx={1.75} className={`dg-bar dg-b-${node.cls}`} />
            <text x={x + 15} y={y + (node.sub ? 23 : 27)} className="dg-label">
              {node.label}
            </text>
            {node.sub && w > 150 && (
              <text x={x + 15} y={y + 43} className="dg-sub">
                {node.sub}
              </text>
            )}
            {node.count != null && node.count > 0 && (
              <g key={node.count} transform={`translate(${x + w - 22}, ${y + 17})`} className="dg-count">
                <circle r="11" />
                <text textAnchor="middle" dy="3.5">
                  {node.count > 99 ? "99+" : node.count}
                </text>
              </g>
            )}
            {/* 断点标记：节点顶边中央的红色圆点（命中时脉冲） */}
            {node.breakpoint != null && (hasBp || clickable) && (
              <g
                className={`dg-bp ${hasBp ? "on" : ""} ${pausedHere ? "hit" : ""}`}
                transform={`translate(${x + w / 2}, ${y})`}
              >
                <circle r="7.5" />
                {hasBp && <rect x="-3.2" y="-3.5" width="2.4" height="7" rx="1" />}
                {hasBp && <rect x="0.8" y="-3.5" width="2.4" height="7" rx="1" />}
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function pathD(graph: Graph, boxes: Map<string, Box>, edgeId: string): string | undefined {
  const edge = graph.edges.find((e) => e.id === edgeId);
  return edge ? edgePath(edge, graph, boxes) : undefined;
}

export function DiagramLegend(): ReactElement {
  return (
    <div className="dg-legend">
      {CLS_LEGEND.map(([cls, label]) => (
        <span key={cls} className="dg-legend-item">
          <i className={`dg-dot dg-b-${cls}`} />
          {label}
        </span>
      ))}
      <span className="dg-legend-item">
        <i className="dg-dot dg-bp-dot" />
        断点（点击节点设置）
      </span>
    </div>
  );
}

/** 信息流图的信息包序列（最近 60 个有触达的事件） */
export function packetsFromEvents(graph: Graph, events: TraceEvent[]): Array<{ seq: number; edgeId: string; cls: NodeCls }> {
  const out: Array<{ seq: number; edgeId: string; cls: NodeCls }> = [];
  for (const e of events.slice(-60)) {
    for (const t of eventTouch(graph, e)) {
      if (t.edgeId) out.push({ seq: e.seq, edgeId: t.edgeId, cls: t.cls });
    }
  }
  return out.slice(-30);
}
