/**
 * Cursor-style Changes panel: uncommitted file list + expandable diffs.
 */
import type { HostIpcMethod } from "../shared/host-api.js";
import { t as tr } from "../shared/i18n/index.js";
import { renderDiffBodyHtml } from "./diff-view.js";
import { sfIcon } from "./sf-icons.js";

type HostRes<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

type Inv = <T>(method: HostIpcMethod, params?: unknown) => Promise<HostRes<T>>;

export type ChangeFileRow = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};

const LARGE_LINE_THRESHOLD = 400;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function extLabel(p: string): string {
  const name = baseName(p);
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

function statusLabel(status: string): string {
  if (status === "?" || status === "A") return tr("side.changesNew");
  if (status === "D") return tr("side.changesDeleted");
  if (status === "R") return tr("side.changesRenamed");
  return tr("side.changesModified");
}

function statusClass(status: string): string {
  if (status === "?" || status === "A") return "is-new";
  if (status === "D") return "is-del";
  if (status === "R") return "is-ren";
  return "is-mod";
}

export interface ChangesPaneDeps {
  inv: Inv;
  getCwd: () => string | null;
  openFile?: (relPath: string, line?: number) => void;
}

export class ChangesPaneController {
  private root: HTMLElement | null = null;
  private deps: ChangesPaneDeps;
  private files: ChangeFileRow[] = [];
  private expanded = new Set<string>();
  private loadedDiff = new Map<string, string>();
  private loading = new Set<string>();

  constructor(deps: ChangesPaneDeps) {
    this.deps = deps;
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.innerHTML = `
      <div class="changes-pane">
        <div class="changes-summary" id="changes-summary"></div>
        <div class="changes-list" id="changes-list"></div>
        <div class="changes-empty hidden" id="changes-empty">${esc(tr("side.changesClean"))}</div>
      </div>
    `;
    document.getElementById("changes-refresh")?.addEventListener("click", () => {
      void this.refresh();
    });
  }

  setOnBack(_handler: () => void): void {
    /* back 由 side-chrome data-side-home 处理 */
  }

  async refresh(): Promise<void> {
    const cwd = this.deps.getCwd();
    const summaryEl = this.root?.querySelector("#changes-summary");
    const listEl = this.root?.querySelector("#changes-list");
    const emptyEl = this.root?.querySelector("#changes-empty");
    if (!summaryEl || !listEl || !emptyEl) return;

    if (!cwd) {
      this.files = [];
      summaryEl.textContent = "";
      listEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      emptyEl.textContent = tr("side.needProject");
      return;
    }

    const res = await this.deps.inv<{
      files: ChangeFileRow[];
      totalAdditions?: number;
      totalDeletions?: number;
    }>("changes.summary", { cwd });

    this.files = res.data?.files ?? [];
    const add = res.data?.totalAdditions ?? 0;
    const del = res.data?.totalDeletions ?? 0;

    if (!this.files.length) {
      summaryEl.textContent = "";
      listEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      emptyEl.textContent = tr("side.changesClean");
      return;
    }

    emptyEl.classList.add("hidden");
    const n = this.files.length;
    const parts: string[] = [
      tr("side.changesCount", { n: String(n) }),
    ];
    if (add > 0) parts.push(`+${add}`);
    if (del > 0) parts.push(`−${del}`);
    summaryEl.textContent = parts.join("  ");

    // drop expanded keys that disappeared
    for (const k of [...this.expanded]) {
      if (!this.files.some((f) => f.path === k)) {
        this.expanded.delete(k);
        this.loadedDiff.delete(k);
      }
    }

    listEl.innerHTML = this.files.map((f) => this.rowHtml(f)).join("");
    this.bindList(listEl as HTMLElement);

    // auto-expand small first file like Cursor
    const first = this.files[0];
    if (first && this.expanded.size === 0) {
      const lines = (first.additions ?? 0) + (first.deletions ?? 0);
      if (lines > 0 && lines <= LARGE_LINE_THRESHOLD) {
        this.expanded.add(first.path);
        await this.ensureDiff(first.path);
        listEl.innerHTML = this.files.map((f) => this.rowHtml(f)).join("");
        this.bindList(listEl as HTMLElement);
      }
    } else {
      // refresh open diffs
      for (const p of this.expanded) {
        if (!this.loadedDiff.has(p)) await this.ensureDiff(p);
      }
      listEl.innerHTML = this.files.map((f) => this.rowHtml(f)).join("");
      this.bindList(listEl as HTMLElement);
    }
  }

  private rowHtml(f: ChangeFileRow): string {
    const open = this.expanded.has(f.path);
    const add = f.additions ?? 0;
    const del = f.deletions ?? 0;
    const lines = add + del;
    const large = lines >= LARGE_LINE_THRESHOLD;
    const patch = this.loadedDiff.get(f.path);
    const loading = this.loading.has(f.path);

    let body = "";
    if (open) {
      if (loading) {
        body = `<div class="changes-diff-loading">${esc(tr("side.changesLoading"))}</div>`;
      } else if (large && !patch) {
        body =
          `<div class="changes-diff-collapsed">` +
          `<button type="button" class="changes-load-diff" data-load-diff="${esc(f.path)}">${esc(tr("side.changesLoadDiff"))}</button>` +
          `<span class="changes-diff-hint">${esc(tr("side.changesLargeHint"))}</span>` +
          `</div>`;
      } else if (patch) {
        body = `<div class="changes-diff-body diff-body">${renderDiffBodyHtml(patch, f.path)}</div>`;
      } else {
        body = `<div class="changes-diff-empty">${esc(tr("side.changesNoDiff"))}</div>`;
      }
    }

    const stats =
      (add > 0 ? `<span class="changes-stat-add">+${add}</span>` : "") +
      (del > 0 ? `<span class="changes-stat-del">−${del}</span>` : "");
    const lang = extLabel(f.path);

    return (
      `<article class="changes-file ${open ? "is-open" : ""} ${statusClass(f.status)}" data-path="${esc(f.path)}">` +
      `<header class="changes-file-head" data-toggle="${esc(f.path)}" role="button" tabindex="0" title="${esc(f.path)}">` +
      (lang ? `<span class="changes-file-lang">${esc(lang)}</span>` : "") +
      `<span class="changes-file-name">${esc(baseName(f.path))}</span>` +
      `<span class="changes-file-stats">${stats}</span>` +
      `<span class="changes-file-spacer"></span>` +
      `<span class="changes-file-badge">${esc(statusLabel(f.status))}</span>` +
      `<button type="button" class="changes-file-open" data-open-file="${esc(f.path)}" title="${esc(tr("side.openInEditor"))}">${sfIcon("doc", { size: 12 })}</button>` +
      `</header>` +
      (open ? `<div class="changes-file-body">${body}</div>` : "") +
      `</article>`
    );
  }

  private bindList(listEl: HTMLElement): void {
    listEl.onclick = (e) => {
      const t = e.target as HTMLElement;
      const load = t.closest("[data-load-diff]") as HTMLElement | null;
      if (load) {
        e.stopPropagation();
        void this.loadLargeDiff(load.dataset.loadDiff!);
        return;
      }
      const openBtn = t.closest("[data-open-file]") as HTMLElement | null;
      if (openBtn) {
        e.stopPropagation();
        this.deps.openFile?.(openBtn.dataset.openFile!);
        return;
      }
      const toggle = t.closest("[data-toggle]") as HTMLElement | null;
      if (toggle) {
        void this.toggle(toggle.dataset.toggle!);
      }
    };
  }

  private async toggle(filePath: string): Promise<void> {
    if (this.expanded.has(filePath)) {
      this.expanded.delete(filePath);
    } else {
      this.expanded.add(filePath);
      const f = this.files.find((x) => x.path === filePath);
      const lines = (f?.additions ?? 0) + (f?.deletions ?? 0);
      if (lines < LARGE_LINE_THRESHOLD) {
        await this.ensureDiff(filePath);
      }
    }
    const listEl = this.root?.querySelector("#changes-list");
    if (!listEl) return;
    listEl.innerHTML = this.files.map((f) => this.rowHtml(f)).join("");
    this.bindList(listEl as HTMLElement);
  }

  private async loadLargeDiff(filePath: string): Promise<void> {
    await this.ensureDiff(filePath);
    const listEl = this.root?.querySelector("#changes-list");
    if (!listEl) return;
    listEl.innerHTML = this.files.map((f) => this.rowHtml(f)).join("");
    this.bindList(listEl as HTMLElement);
  }

  private async ensureDiff(filePath: string): Promise<void> {
    if (this.loadedDiff.has(filePath) || this.loading.has(filePath)) return;
    const cwd = this.deps.getCwd();
    if (!cwd) return;
    this.loading.add(filePath);
    const listEl = this.root?.querySelector("#changes-list");
    if (listEl && this.expanded.has(filePath)) {
      listEl.innerHTML = this.files.map((f) => this.rowHtml(f)).join("");
      this.bindList(listEl as HTMLElement);
    }
    try {
      const res = await this.deps.inv<{
        path: string;
        patch: string;
        additions?: number;
        deletions?: number;
      }>("changes.diff", { cwd, path: filePath });
      const patch = res.data?.patch ?? "";
      this.loadedDiff.set(filePath, patch);
      // sync stats if host returned better numbers
      const row = this.files.find((f) => f.path === filePath);
      if (row && res.data) {
        if (res.data.additions != null) row.additions = res.data.additions;
        if (res.data.deletions != null) row.deletions = res.data.deletions;
      }
    } finally {
      this.loading.delete(filePath);
    }
  }
}
