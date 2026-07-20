/**
 * Desktop-hosted terminals for ACP `terminal/*` and user-created PTY sessions.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { NormalizedEvent } from "../shared/events.js";

const require = createRequire(import.meta.url);

export type TerminalKind = "acp" | "user";

export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalInfo {
  terminalId: string;
  kind: TerminalKind;
  title: string;
  cwd: string;
  command?: string;
  threadId?: string;
  sessionId?: string;
  interactive: boolean;
  exited: boolean;
  exitStatus?: TerminalExitStatus;
  createdAt: string;
}

export interface CreateAcpTerminalParams {
  sessionId: string;
  threadId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Array<{ name: string; value: string }>;
  outputByteLimit?: number;
}

export interface CreateUserTerminalParams {
  cwd: string;
  cols?: number;
  rows?: number;
  title?: string;
}

type EmitFn = (event: NormalizedEvent) => void;

interface Session {
  info: TerminalInfo;
  output: string;
  truncated: boolean;
  byteLimit: number;
  exitWaiters: Array<(status: TerminalExitStatus) => void>;
  /** ACP: child_process; user: node-pty IPty-like */
  kill: () => void;
  write?: (data: string) => void;
  resize?: (cols: number, rows: number) => void;
  released: boolean;
}

type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: () => void;
    onData: (cb: (data: string) => void) => void;
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  };
};

function loadPty(): PtyModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node-pty") as PtyModule;
  } catch {
    return null;
  }
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

function envFromPairs(
  pairs?: Array<{ name: string; value: string }>,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (pairs) {
    for (const { name, value } of pairs) {
      if (name) env[name] = value;
    }
  }
  return env;
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export class TerminalService {
  private sessions = new Map<string, Session>();
  private emit: EmitFn;

  constructor(opts: { onEvent: EmitFn }) {
    this.emit = opts.onEvent;
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()]
      .filter((s) => !s.released)
      .map((s) => ({ ...s.info }));
  }

  get(terminalId: string): TerminalInfo | null {
    const s = this.sessions.get(terminalId);
    if (!s || s.released) return null;
    return { ...s.info };
  }

  createAcp(params: CreateAcpTerminalParams): { terminalId: string } {
    const terminalId = `term_${randomUUID()}`;
    const cwd = params.cwd
      ? path.resolve(params.cwd)
      : process.cwd();
    const args = params.args ?? [];
    const byteLimit =
      typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
        ? params.outputByteLimit
        : 1_048_576;
    const title = [params.command, ...args].join(" ").slice(0, 80) || "Command";

    const info: TerminalInfo = {
      terminalId,
      kind: "acp",
      title,
      cwd,
      command: title,
      threadId: params.threadId,
      sessionId: params.sessionId,
      interactive: false,
      exited: false,
      createdAt: new Date().toISOString(),
    };

    const session: Session = {
      info,
      output: "",
      truncated: false,
      byteLimit,
      exitWaiters: [],
      released: false,
      kill: () => undefined,
    };

    const proc: ChildProcess = spawn(params.command, args, {
      cwd,
      env: envFromPairs(params.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    const append = (chunk: Buffer | string) => {
      this.appendOutput(session, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("error", (err) => {
      this.appendOutput(session, `\n[error] ${err.message}\n`);
      this.markExit(session, { exitCode: 1, signal: null });
    });
    proc.on("exit", (code, signal) => {
      this.markExit(session, {
        exitCode: code,
        signal: signal ?? null,
      });
    });

    session.kill = () => {
      if (!proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    };

    this.sessions.set(terminalId, session);
    this.emit({
      type: "terminal.opened",
      terminalId,
      kind: "acp",
      title,
      cwd,
      command: title,
      threadId: params.threadId,
      sessionId: params.sessionId,
      interactive: false,
    });
    return { terminalId };
  }

  createUser(params: CreateUserTerminalParams): TerminalInfo {
    const terminalId = `term_user_${randomUUID()}`;
    const cwd = path.resolve(params.cwd || os.homedir());
    const cols = params.cols && params.cols > 0 ? params.cols : 80;
    const rows = params.rows && params.rows > 0 ? params.rows : 24;
    const shell = defaultShell();
    const title = params.title?.trim() || "Terminal";

    const info: TerminalInfo = {
      terminalId,
      kind: "user",
      title,
      cwd,
      interactive: true,
      exited: false,
      createdAt: new Date().toISOString(),
    };

    const session: Session = {
      info,
      output: "",
      truncated: false,
      byteLimit: 2_000_000,
      exitWaiters: [],
      released: false,
      kill: () => undefined,
    };

    const pty = loadPty();
    if (pty) {
      // -il：交互 + login，加载 .zprofile/.zshrc，提示符/配色与系统终端一致
      const shellArgs =
        process.platform === "win32" ? [] : ["-il"];
      const p = pty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: envRecord({
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          TERM_PROGRAM: "GrokDesktop",
          TERM_PROGRAM_VERSION: "0.1.0",
          CLICOLOR: "1",
          CLICOLOR_FORCE: "1",
          FORCE_COLOR: "1",
        }),
      });
      p.onData((data) => this.appendOutput(session, data));
      p.onExit(({ exitCode, signal }) => {
        this.markExit(session, {
          exitCode: exitCode ?? 0,
          signal: signal != null ? String(signal) : null,
        });
      });
      session.write = (data) => {
        try {
          p.write(data);
        } catch {
          /* ignore */
        }
      };
      session.resize = (c, r) => {
        try {
          p.resize(Math.max(2, c), Math.max(1, r));
        } catch {
          /* ignore */
        }
      };
      session.kill = () => {
        try {
          p.kill();
        } catch {
          /* ignore */
        }
      };
    } else {
      // Fallback: non-PTY pipes (degraded interactive)
      const proc = spawn(shell, process.platform === "win32" ? [] : ["-i"], {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const append = (chunk: Buffer) =>
        this.appendOutput(session, chunk.toString("utf8"));
      proc.stdout.on("data", append);
      proc.stderr.on("data", append);
      proc.on("exit", (code, signal) => {
        this.markExit(session, { exitCode: code, signal: signal ?? null });
      });
      session.write = (data) => {
        try {
          proc.stdin.write(data);
        } catch {
          /* ignore */
        }
      };
      session.kill = () => {
        if (!proc.killed) proc.kill("SIGTERM");
      };
    }

    this.sessions.set(terminalId, session);
    this.emit({
      type: "terminal.opened",
      terminalId,
      kind: "user",
      title,
      cwd,
      interactive: true,
    });
    return { ...info };
  }

  getOutput(terminalId: string): {
    output: string;
    truncated: boolean;
    exitStatus: TerminalExitStatus | null;
  } {
    const s = this.requireLive(terminalId);
    return {
      output: s.output,
      truncated: s.truncated,
      exitStatus: s.info.exitStatus ?? null,
    };
  }

  async waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    const s = this.requireLive(terminalId);
    if (s.info.exitStatus) return s.info.exitStatus;
    return new Promise((resolve) => {
      s.exitWaiters.push(resolve);
    });
  }

  kill(terminalId: string): void {
    const s = this.requireLive(terminalId);
    s.kill();
  }

  release(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s || s.released) return;
    s.kill();
    s.released = true;
    this.emit({
      type: "terminal.closed",
      terminalId,
      kind: s.info.kind,
    });
    // Keep briefly for late wait_for_exit / output, then drop
    setTimeout(() => this.sessions.delete(terminalId), 30_000);
  }

  write(terminalId: string, data: string): void {
    const s = this.requireLive(terminalId);
    if (!s.info.interactive || !s.write) {
      throw new Error("Terminal is not interactive");
    }
    s.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const s = this.requireLive(terminalId);
    s.resize?.(cols, rows);
  }

  closeUser(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    this.release(terminalId);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.release(id);
    }
    this.sessions.clear();
  }

  private requireLive(terminalId: string): Session {
    const s = this.sessions.get(terminalId);
    if (!s || s.released) {
      throw new Error(`Unknown or released terminal: ${terminalId}`);
    }
    return s;
  }

  private appendOutput(session: Session, chunk: string): void {
    if (session.released || !chunk) return;
    session.output += chunk;
    const bytes = Buffer.byteLength(session.output, "utf8");
    if (bytes > session.byteLimit) {
      // Truncate from the beginning at a character boundary
      let drop = bytes - session.byteLimit;
      let i = 0;
      while (drop > 0 && i < session.output.length) {
        const cp = session.output.codePointAt(i) ?? 0;
        const size = Buffer.byteLength(String.fromCodePoint(cp), "utf8");
        drop -= size;
        i += cp > 0xffff ? 2 : 1;
      }
      session.output = session.output.slice(i);
      session.truncated = true;
    }
    this.emit({
      type: "terminal.output",
      terminalId: session.info.terminalId,
      kind: session.info.kind,
      data: chunk,
      truncated: session.truncated,
    });
  }

  private markExit(session: Session, status: TerminalExitStatus): void {
    if (session.info.exited) return;
    session.info.exited = true;
    session.info.exitStatus = status;
    const waiters = session.exitWaiters.splice(0);
    for (const w of waiters) w(status);
    this.emit({
      type: "terminal.exit",
      terminalId: session.info.terminalId,
      kind: session.info.kind,
      exitCode: status.exitCode,
      signal: status.signal,
    });
  }
}
