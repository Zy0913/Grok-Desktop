import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  ChangeFileSummary,
  ChangeSummary,
  DiffResult,
  HunkTimelineEntry,
} from "../shared/types.js";
import { HostError } from "../shared/errors.js";

const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const UNTRACKED_MAX_LINES = 8000;

function git(
  cwd: string,
  args: string[],
  opts?: { maxBuffer?: number },
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function parsePorcelainPath(rest: string): string {
  let p = rest.trim();
  // rename: "old -> new" or quoted
  if (p.includes(" -> ")) {
    p = p.split(" -> ").pop()!.trim();
  }
  if (
    (p.startsWith('"') && p.endsWith('"')) ||
    (p.startsWith("'") && p.endsWith("'"))
  ) {
    p = p.slice(1, -1);
  }
  return p;
}

function collectNumstat(cwd: string): Map<string, { add: number; del: number }> {
  const map = new Map<string, { add: number; del: number }>();
  const absorb = (stdout: string) => {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const addRaw = parts[0]!;
      const delRaw = parts[1]!;
      const filePath = parts.slice(2).join("\t").trim();
      if (!filePath) continue;
      const add = addRaw === "-" ? 0 : Number(addRaw) || 0;
      const del = delRaw === "-" ? 0 : Number(delRaw) || 0;
      const prev = map.get(filePath) ?? { add: 0, del: 0 };
      map.set(filePath, { add: prev.add + add, del: prev.del + del });
    }
  };
  absorb(git(cwd, ["diff", "--numstat"]).stdout);
  absorb(git(cwd, ["diff", "--cached", "--numstat"]).stdout);
  return map;
}

function countFileLines(abs: string): number {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > DIFF_MAX_BYTES) return 0;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return 0;
    const text = buf.toString("utf8");
    if (!text) return 0;
    return text.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function countPatchStats(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

export function changesSummary(cwd: string): ChangeSummary {
  const stat = git(cwd, ["status", "--porcelain", "-uall"]);
  if (stat.status !== 0) {
    return {
      scope: "thread",
      cwd,
      files: [],
      rawStat: stat.stderr,
      totalAdditions: 0,
      totalDeletions: 0,
    };
  }
  const numstat = collectNumstat(cwd);
  const files: ChangeFileSummary[] = [];
  for (const line of (stat.stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const p = parsePorcelainPath(line.slice(3));
    if (!p) continue;
    let status: ChangeFileSummary["status"] = "M";
    if (code === "??") status = "?";
    else if (code.includes("A")) status = "A";
    else if (code.includes("D")) status = "D";
    else if (code.includes("R")) status = "R";
    const ns = numstat.get(p);
    let additions = ns?.add ?? 0;
    let deletions = ns?.del ?? 0;
    if (status === "?" || (status === "A" && additions === 0 && deletions === 0)) {
      additions = countFileLines(path.join(cwd, p));
      deletions = 0;
    }
    files.push({ path: p, status, additions, deletions });
  }
  const totalAdditions = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const totalDeletions = files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  return {
    scope: "thread",
    cwd,
    files,
    rawStat: stat.stdout || undefined,
    totalAdditions,
    totalDeletions,
  };
}

function buildUntrackedDiff(cwd: string, filePath: string): DiffResult {
  const abs = path.join(cwd, filePath);
  if (!fs.existsSync(abs)) {
    return { path: filePath, patch: "", isNew: true, additions: 0, deletions: 0 };
  }
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    return {
      path: filePath,
      patch: "",
      isNew: true,
      additions: 0,
      deletions: 0,
    };
  }
  if (st.size > DIFF_MAX_BYTES) {
    return {
      path: filePath,
      patch: "",
      isNew: true,
      truncated: true,
      additions: 0,
      deletions: 0,
    };
  }
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) {
    return {
      path: filePath,
      patch: `Binary file ${filePath} created\n`,
      isNew: true,
      truncated: true,
      additions: 0,
      deletions: 0,
    };
  }
  const text = buf.toString("utf8");
  const lines = text.length ? text.split(/\r?\n/) : [];
  const truncated = lines.length > UNTRACKED_MAX_LINES;
  const use = truncated ? lines.slice(0, UNTRACKED_MAX_LINES) : lines;
  const n = use.length;
  let patch =
    `diff --git a/${filePath} b/${filePath}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${filePath}\n` +
    `@@ -0,0 +1,${n} @@\n`;
  for (const line of use) patch += `+${line}\n`;
  if (truncated) {
    patch += `+… (${lines.length - UNTRACKED_MAX_LINES} more lines truncated)\n`;
  }
  return {
    path: filePath,
    patch,
    isNew: true,
    truncated,
    additions: lines.length,
    deletions: 0,
  };
}

export function changesDiff(cwd: string, filePath: string): DiffResult {
  const rel = filePath.replace(/\\/g, "/");
  // untracked?
  const st = git(cwd, ["status", "--porcelain", "-uall", "--", rel]);
  const porcelain = (st.stdout ?? "").trim();
  if (porcelain.startsWith("??")) {
    return buildUntrackedDiff(cwd, rel);
  }

  let patch = git(cwd, ["diff", "--", rel]).stdout;
  if (!patch.trim()) {
    patch = git(cwd, ["diff", "--cached", "--", rel]).stdout;
  }
  if (!patch.trim()) {
    patch = git(cwd, ["diff", "HEAD", "--", rel]).stdout;
  }
  // 新文件仅在 index：仍可能为空 → 当未跟踪处理
  if (!patch.trim()) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) return buildUntrackedDiff(cwd, rel);
  }
  const stats = countPatchStats(patch);
  return {
    path: rel,
    patch,
    additions: stats.add,
    deletions: stats.del,
    isNew: porcelain.includes("A") || porcelain.startsWith("A"),
  };
}

export function changesTimeline(cwd: string): HunkTimelineEntry[] {
  const summary = changesSummary(cwd);
  return summary.files.slice(0, 50).map((f) => ({
    path: f.path,
    summary: `status ${f.status}`,
    turnHint: "git-status",
  }));
}

export function openInEditor(
  filePath: string,
  line?: number,
  editor?: string,
): void {
  const resolved = path.resolve(filePath);
  const cmd =
    editor?.trim() ||
    process.env.GROK_DESKTOP_EDITOR?.trim() ||
    "code";
  const base = path.basename(cmd).toLowerCase().replace(/\.cmd$/i, "").replace(/\.exe$/i, "");
  const isVscodeFamily = ["code", "cursor", "codium", "windsurf", "code-insiders"].includes(
    base,
  );
  try {
    if (isVscodeFamily) {
      spawn(cmd, line != null ? ["-g", `${resolved}:${line}`] : [resolved], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: process.platform === "win32",
      }).unref();
    } else {
      spawn(cmd, [resolved], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: true,
      }).unref();
    }
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `Failed to open editor: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 在资源管理器 / Finder 中打开路径（目录或文件所在位置） */
export async function openPath(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new HostError("IO_ERROR", `Path not found: ${resolved}`);
  }
  try {
    const { shell } = await import("electron");
    const err = await shell.openPath(resolved);
    if (err) {
      throw new HostError("IO_ERROR", err || `Failed to open path: ${resolved}`);
    }
    return;
  } catch (e) {
    if (e instanceof HostError) throw e;
  }
  const platform = process.platform;
  try {
    if (platform === "win32") {
      spawn("explorer.exe", [resolved], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (platform === "darwin") {
      spawn("open", [resolved], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("xdg-open", [resolved], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `Failed to open path: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 用系统默认浏览器 / 协议处理器打开 URL（http(s)/mailto 等） */
export async function openExternalUrl(url: string): Promise<void> {
  const u = url.trim();
  if (!u) {
    throw new HostError("INVALID_ARGUMENT", "Empty URL");
  }
  if (!/^(https?:|mailto:|vscode:|cursor:)/i.test(u)) {
    throw new HostError(
      "INVALID_ARGUMENT",
      `Blocked external URL scheme: ${u.slice(0, 32)}`,
    );
  }
  try {
    const { shell } = await import("electron");
    await shell.openExternal(u);
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `Failed to open external URL: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
