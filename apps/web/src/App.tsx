import { useState } from "react";
import { LearnPage } from "./features/LearnPage";
import { WorkbenchPage } from "./features/WorkbenchPage";
import { HistoryPage } from "./features/HistoryPage";
import { ReplayPage } from "./features/ReplayPage";
import { SettingsPage } from "./features/SettingsPage";

type Route =
  | { page: "learn" }
  | { page: "workbench"; lessonId: string }
  | { page: "history" }
  | { page: "replay"; runId?: string }
  | { page: "settings" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "learn" });
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );

  const toggleTheme = (): void => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("agentglass:theme", next);
    } catch {
      /* 持久化失败不影响本次会话 */
    }
    setTheme(next);
  };

  return (
    <div className="app">
      <nav className="top-nav">
        <span className="brand" onClick={() => setRoute({ page: "learn" })}>AgentGlass</span>
        {(
          [
            ["learn", "学习"],
            ["history", "历史"],
            ["settings", "设置"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={route.page === key || (key === "history" && route.page === "replay") ? "active" : ""}
            onClick={() => setRoute({ page: key } as Route)}
          >
            {label}
          </button>
        ))}
        <span className="spacer" />
        <span className="muted small">本地实验版 · 单用户模式</span>
        <button
          className="theme-toggle"
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={toggleTheme}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </nav>
      <main className="page">
        {route.page === "learn" && <LearnPage onOpenLesson={(lessonId) => setRoute({ page: "workbench", lessonId })} />}
        {route.page === "workbench" && (
          <WorkbenchPage lessonId={route.lessonId} onOpenHistory={() => setRoute({ page: "history" })} />
        )}
        {route.page === "history" && <HistoryPage onOpenReplay={(runId) => setRoute({ page: "replay", runId })} />}
        {route.page === "replay" && <ReplayPage runId={route.runId} onBack={() => setRoute({ page: "history" })} />}
        {route.page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
