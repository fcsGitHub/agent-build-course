-- 005：运行断点（流程图节点断点）。
-- 断点由用户在 UI 上按运行设置；worker 在安全边界轮询本表决定是否驻留。
-- target 为边界名（before_model/before_tool/after_tool/turn_end）或 node:<graphNodeId>。
CREATE TABLE IF NOT EXISTS run_breakpoints (
  run_id TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, target)
);
