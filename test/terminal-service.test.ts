import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { TerminalService } from "../src/host/terminal-service.js";
import type { NormalizedEvent } from "../src/shared/events.js";

describe("TerminalService", () => {
  it("runs ACP command, streams output, wait/release", async () => {
    const events: NormalizedEvent[] = [];
    const svc = new TerminalService({ onEvent: (e) => events.push(e) });
    const { terminalId } = svc.createAcp({
      sessionId: "sess_test",
      threadId: "thread_test",
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello-acp')"],
      cwd: process.cwd(),
      outputByteLimit: 4096,
    });
    expect(terminalId).toMatch(/^term_/);
    const status = await svc.waitForExit(terminalId);
    expect(status.exitCode).toBe(0);
    const out = svc.getOutput(terminalId);
    expect(out.output).toContain("hello-acp");
    svc.release(terminalId);
    expect(events.some((e) => e.type === "terminal.opened")).toBe(true);
    expect(events.some((e) => e.type === "terminal.output")).toBe(true);
    expect(events.some((e) => e.type === "terminal.exit")).toBe(true);
    expect(events.some((e) => e.type === "terminal.closed")).toBe(true);
    svc.disposeAll();
  });

  it("truncates oversized ACP output from the start", async () => {
    const svc = new TerminalService({ onEvent: () => undefined });
    const { terminalId } = svc.createAcp({
      sessionId: "s",
      threadId: "t",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('A'.repeat(2000) + 'TAIL')",
      ],
      outputByteLimit: 100,
    });
    await svc.waitForExit(terminalId);
    const out = svc.getOutput(terminalId);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.output, "utf8")).toBeLessThanOrEqual(100);
    expect(out.output.endsWith("TAIL")).toBe(true);
    svc.disposeAll();
  });

  it("creates interactive user terminal when node-pty is available", async () => {
    const events: NormalizedEvent[] = [];
    const svc = new TerminalService({ onEvent: (e) => events.push(e) });
    const cwd = os.tmpdir();
    const info = svc.createUser({ cwd, cols: 40, rows: 12, title: "Test" });
    expect(info.kind).toBe("user");
    expect(info.interactive).toBe(true);
    expect(path.resolve(info.cwd)).toBe(path.resolve(cwd));
    // give PTY a moment to emit prompt
    await new Promise((r) => setTimeout(r, 150));
    svc.write(info.terminalId, "echo user-pty-ok\n");
    await new Promise((r) => setTimeout(r, 400));
    const snap = svc.getOutput(info.terminalId);
    expect(snap.output.length).toBeGreaterThan(0);
    svc.closeUser(info.terminalId);
    expect(events.some((e) => e.type === "terminal.opened")).toBe(true);
    svc.disposeAll();
  }, 10_000);
});
