// Child processes. No shell is ever involved: every call is an argv array.
import { spawn, spawnSync } from "node:child_process";
import { onInterrupt } from "./interrupt.mjs";
import { ToolError, signalExitCode } from "./result.mjs";

const TAIL_BYTES = 64 * 1024;

/** Short synchronous probe (version strings, listings). Never throws; returns what happened. */
export function runSync(argv, { timeoutMs = 30000, env, input } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: timeoutMs,
    env: env ?? process.env,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    signal: r.signal,
    timedOut: r.error?.code === "ETIMEDOUT",
    notFound: r.error?.code === "ENOENT",
    error: r.error ? String(r.error.message) : null,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * Long-running child (the render). Runs in its own process group so a timeout or an interrupt
 * takes down everything it launched (Chrome, ffmpeg), not just the direct child.
 * Resolves with {status, signal, stdout, stderr}; rejects with ToolError(timeout|interrupted).
 */
export function runChild(argv, { timeoutMs, env, cwd, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let stopReason = null;
    const append = (acc, chunk) => {
      acc += chunk;
      return acc.length > TAIL_BYTES ? acc.slice(-TAIL_BYTES) : acc;
    };
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout = append(stdout, c)));
    child.stderr.setEncoding("utf8").on("data", (c) => {
      stderr = append(stderr, c);
      onStderr?.(c);
    });

    const killGroup = (sig) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const stop = (reason) => {
      if (finished || stopReason) return;
      stopReason = reason;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    };

    const timer = timeoutMs > 0 ? setTimeout(() => stop({ kind: "timeout" }), timeoutMs) : null;
    const unsubscribe = onInterrupt((sig) => stop({ kind: "interrupted", signal: sig }));

    child.on("error", (err) => {
      cleanup();
      reject(
        err.code === "ENOENT"
          ? new ToolError("missing_tool", `cannot execute ${argv[0]}: not found`)
          : new ToolError("render", `cannot start ${argv[0]}: ${err.message}`),
      );
    });
    child.on("close", (status, signal) => {
      cleanup();
      if (stopReason?.kind === "timeout") {
        reject(new ToolError("timeout", `timed out after ${timeoutMs / 1000}s; the process group was killed`, {
          details: { stderr_tail: tail(stderr) },
        }));
      } else if (stopReason?.kind === "interrupted") {
        reject(new ToolError("interrupted", `interrupted by ${stopReason.signal}; the process group was killed`, {
          exitCode: signalExitCode(stopReason.signal),
        }));
      } else {
        resolve({ status, signal, stdout, stderr });
      }
    });

    function cleanup() {
      finished = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    }
  });
}

export function tail(text, lines = 40) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}
