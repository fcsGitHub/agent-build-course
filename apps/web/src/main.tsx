import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/** 主题引导：渲染前落到 <html data-theme>，避免闪烁。用户选择持久化，缺省跟随系统。 */
export function initTheme(): "light" | "dark" {
  const saved = localStorage.getItem("agentglass:theme");
  const theme =
    saved === "light" || saved === "dark"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  return theme;
}

initTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
