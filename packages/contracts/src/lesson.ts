/**
 * 课程（实验包）合同。依据设计文档 v1.1 第 19.5 节 manifest。
 * 课程是声明性包；课程 linter 拒绝 auto_send / auto_followups 等配置。
 */

export interface LessonCapabilityRequirement {
  model?: string[];
  tools?: string[];
  sandbox?: string;
  embedding?: boolean;
}

export interface LessonLimitSpec {
  max_turns: number;
  max_model_calls: number;
  max_tool_calls: number;
  max_wall_time_ms: number;
  max_concurrency: number;
  max_depth: number;
  /** 可选：单次输入/输出 token 估算上限 */
  max_input_tokens?: number;
  max_output_tokens?: number;
}

export interface LessonObservationSpec {
  events: string[];
}

export interface CaseHintSpec {
  id: string;
  /** 提示正文；只能插入草稿，不能自动发送 */
  text: string;
  requires?: string[];
  observe?: string[];
}

export interface LessonEditPolicyFileSpec {
  policy: string;
  scope: "learner_private_variant";
  activation: "next_explicit_run";
  validation_required: boolean;
  allow_runtime_hot_patch: false;
}

export interface LessonManifest {
  schema_version: 1;
  id: string;
  revision: string;
  title: string;
  stage: string;
  summary: string;
  prerequisites: string[];
  runtime: {
    adapter: "reference";
    entrypoint: string;
    /** 循环模式：single_call（L00-L03）/ agent_loop（L04+）/ chain（固定工作流，L08） */
    profile: "single_call" | "agent_loop" | "chain" | "graph" | "multi_agent" | "recursion" | "rsi";
    extension_slots?: Record<string, string>;
    /** 固定工作流步骤（profile=chain 时必填） */
    chain_steps?: Array<{ instruction: string; allow_tools: boolean }>;
    /** 上下文压缩策略（L15） */
    compaction?: "none" | "tool_result_head";
    /** 状态图定义文件（profile=graph 时必填） */
    graph_file?: string;
    /** 本地 MCP 课程 server ID 列表（T21） */
    mcp_servers?: string[];
    /** 远程 A2A agent ID 列表（T28；映射为 a2a_<id> 受控工具） */
    a2a_agents?: string[];
    /** chain 步骤失败后自动注入失败反思（T30） */
    reflection_on_failure?: boolean;
    /** 多 Agent 拓扑（profile=multi_agent 时必填，T27） */
    multi_agent?: {
      topology: "parallel" | "handoff" | "blackboard";
      workers: Array<{ id: string; goal: string; tools: string[] }>;
      handoff_chain?: string[];
      force_conflict_key?: string;
    };
    /** 有界递归配置（profile=recursion 时必填，T29）：外部化长输入 + 深度上限 + 子调用预算 */
    recursion?: {
      /** 递归深度上限（服务端硬上限，超过显式拒绝） */
      max_depth: number;
      /** 长输入分区字符数（默认 1200） */
      partition_chars?: number;
      /** 每个叶子分区要回答的问题 */
      question: string;
    };
    /** 有界 RSI 配置（profile=rsi 时必填，L45）：提示级自改进循环（DGM 教学骨架） */
    rsi?: {
      /** 代数上限（服务端绝对上限 3） */
      max_generations: number;
      /** 冻结验证集资产键（JSON：tasks[{id,input,expect[]}]，平台持有，候选不可见/不可改） */
      frozen_tasks: string;
    };
  };
  learner_input: {
    mode: "user_authored";
    default_text: "";
    auto_send: false;
    auto_followups: false;
    case_hints: string;
    hint_action: "insert_into_draft";
    grade_only_matching_task_contract: boolean;
  };
  editing?: LessonEditPolicyFileSpec;
  requires: LessonCapabilityRequirement;
  assets: Record<string, string>;
  limits: LessonLimitSpec;
  observations: LessonObservationSpec;
  grader?: {
    entrypoint: string;
    kind: "deterministic" | "not_applicable";
  };
  source_policy?: {
    bind_to_build_manifest: boolean;
  };
  history_policy?: {
    allow_only_verified_real_runs: boolean;
  };
}

export interface CaseHintsFile {
  hints: CaseHintSpec[];
}

export interface LessonCatalogEntry {
  id: string;
  title: string;
  stage: string;
  summary: string;
  revision: string;
  prerequisites: string[];
  path: string;
}
