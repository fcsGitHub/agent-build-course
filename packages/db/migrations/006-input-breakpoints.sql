-- 006：输入携带断点目标（JSON 数组）。提交输入时附带，运行创建事务内播种进 run_breakpoints。
-- 解决首运行竞态：UI 的 PUT /runs/:id/breakpoints 只在运行激活后发出，短运行可能已完成；
-- 同会话继承只覆盖非首个运行。随输入携带后，首个运行也能在创建时即携带断点。
ALTER TABLE input_submissions ADD COLUMN breakpoints TEXT NOT NULL DEFAULT '[]';
