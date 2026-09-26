/**
 * 隔离客体宿主（T40）。fork guest 进程、按调用序号通信、硬超时杀死忙等进程。
 * 客体崩溃/超时 → 策略错误事件 → 终止运行（不是静默继续）。
 * 依据设计文档 v1.1 第 9.7 第四层/9.8 节。
 */
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildSync } from "esbuild";
import type { LessonExtensionHost } from "@agentglass/runtime-reference";

/**
 * guest shim 源码同目录；运行时编译为 CJS 一次性产物（不依赖 tsx 运行子进程）。
 */
let guestDistPath: string | null = null;
function getGuestDist(): string {
  if (guestDistPath) return guestDistPath;
  const here = dirname(fileURLToPath(import.meta.url));
  const distDir = join(here, ".dist");
  mkdirSync(distDir, { recursive: true });
  const distPath = join(distDir, "guest.cjs");
  const result = buildSync({
    entryPoints: [join(here, "guest.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: distPath,
    logLevel: "silent",
  });
  if (result.errors.length > 0) throw new Error(`GUEST_BUILD_FAILED: ${result.errors[0]!.text}`);
  // outfile 模式下 esbuild 已写盘
  guestDistPath = distPath;
  return distPath;
}

const GUEST_DIST = getGuestDist();

export interface GuestOptions {
  /** 单次调用超时 ms；超时即杀死进程 */
  callTimeoutMs?: number;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class GuestProcessHost implements LessonExtensionHost {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingEntry>();
  private killed = false;

  constructor(
    private readonly bundlePath: string,
    private readonly options: GuestOptions = {},
  ) {}

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode == null) return this.child;
    if (this.killed) throw new Error("GUEST_ALREADY_DISPOSED");
    const child = fork(GUEST_DIST, [this.bundlePath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        // 最小环境：无秘密、无平台凭据
        PATH: process.env.PATH ?? "",
      },
      serialization: "json",
      // 干净的 node 子进程：不继承父进程的 loader/调试参数（隔离边界）
      execArgv: [],
    });
    child.on("message", (raw: unknown) => {
      const msg = raw as { id: number; ok: boolean; value?: unknown; error?: string };
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(new Error(msg.error ?? "GUEST_ERROR"));
    });
    child.on("exit", () => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("GUEST_EXITED"));
      }
      this.pending.clear();
      this.child = null;
    });
    this.child = child;
    return child;
  }

  async call(invocation: { slot: string; arg: unknown }): Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
  }> {
    const child = this.ensureChild();
    const id = Math.floor(Math.random() * 1e9);
    const timeoutMs = this.options.callTimeoutMs ?? 2000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 忙等/死循环：杀死客体（外部 watchdog 原则）
        this.killChild();
        resolve({ ok: false, error: `GUEST_TIMEOUT: ${invocation.slot} 超过 ${timeoutMs}ms 被终止` });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve({ ok: true, value }),
        reject: (err: Error) => resolve({ ok: false, error: err.message }),
        timer,
      });
      child.send({ kind: "invoke", id, slot: invocation.slot, arg: invocation.arg });
    });
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null) {
      child.kill("SIGKILL");
    }
  }

  async dispose(): Promise<void> {
    this.killed = true;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null) {
      child.send({ kind: "dispose" });
      const force = setTimeout(() => child.kill("SIGKILL"), 500);
      child.once("exit", () => clearTimeout(force));
    }
  }
}

export function newGuestCallId(): string {
  return `g_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
