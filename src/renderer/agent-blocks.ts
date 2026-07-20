/**
 * Agent 工具时间线块：对齐 Codex 展开过程 —
 * 折叠一行摘要，展开可见命令/输出；与叙事 reason 交错。
 */
import { tr } from "../shared/i18n/index.js";
import { sfIcon } from "./sf-icons.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 从工具 raw 里尽量抠路径 / 摘要 / 命令输出 */
export function extractToolMeta(
  raw: unknown,
  name?: string,
): {
  paths: string[];
  summary: string;
  kind: "read" | "write" | "shell" | "search" | "other";
  command?: string;
  output?: string;
} {
  const paths: string[] = [];
  let summary = "";
  let command: string | undefined;
  let output: string | undefined;
  const kind = classifyTool(name || "");

  const walk = (v: unknown, depth = 0): void => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") {
      if (
        (/[/\\]/.test(v) || /^[A-Za-z]:\\/.test(v)) &&
        v.length < 400 &&
        !v.includes("\n") &&
        /\.[a-zA-Z0-9]{1,12}$/.test(v)
      ) {
        if (!paths.includes(v)) paths.push(v);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 20)) walk(x, depth + 1);
      return;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const key of [
        "path",
        "file",
        "filePath",
        "filename",
        "target",
        "uri",
      ]) {
        if (typeof o[key] === "string") walk(o[key], depth + 1);
      }
      if (typeof o.title === "string" && !summary) summary = o.title;
      if (typeof o.command === "string") {
        command = o.command;
        if (!summary) summary = o.command.slice(0, 160);
      }
      if (typeof o.cmd === "string" && !command) {
        command = o.cmd;
        if (!summary) summary = o.cmd.slice(0, 160);
      }
      if (typeof o.query === "string" && !summary) {
        summary = o.query.slice(0, 120);
      }
      for (const key of [
        "stdout",
        "stderr",
        "output",
        "content",
        "result",
        "text",
      ]) {
        const val = o[key];
        if (typeof val === "string" && val.trim() && !output) {
          output = val.length > 8000 ? `${val.slice(0, 8000)}\n…` : val;
        }
      }
      for (const [k, val] of Object.entries(o).slice(0, 30)) {
        if (
          [
            "path",
            "file",
            "filePath",
            "command",
            "cmd",
            "title",
            "query",
            "stdout",
            "stderr",
            "output",
            "content",
            "result",
            "text",
          ].includes(k)
        ) {
          continue;
        }
        walk(val, depth + 1);
      }
    }
  };
  walk(raw);
  return {
    paths: paths.slice(0, 5),
    summary,
    kind,
    command,
    output,
  };
}

function classifyTool(
  name: string,
): "read" | "write" | "shell" | "search" | "other" {
  const n = name.toLowerCase();
  if (/read|cat|open|view|get_file|read_file/.test(n)) return "read";
  if (/write|edit|patch|apply|create|update|str_replace|search_replace/.test(n))
    return "write";
  if (/shell|bash|cmd|terminal|exec|run|powershell/.test(n)) return "shell";
  if (/search|grep|glob|find|web_search/.test(n)) return "search";
  return "other";
}

function kindIcon(kind: string): string {
  switch (kind) {
    case "read":
      return sfIcon("doc", { size: 13, className: "sf-ico sf-ico--sm" });
    case "write":
      return sfIcon("compose", { size: 13, className: "sf-ico sf-ico--sm" });
    case "shell":
      return sfIcon("command", { size: 13, className: "sf-ico sf-ico--sm" });
    case "search":
      return sfIcon("search", { size: 13, className: "sf-ico sf-ico--sm" });
    default:
      return sfIcon("settings", { size: 13, className: "sf-ico sf-ico--sm" });
  }
}

function detailHtml(meta: ReturnType<typeof extractToolMeta>): string {
  const cmd = meta.command?.trim();
  const out = meta.output?.trim();
  if (!cmd && !out && !meta.paths.length) return "";
  const cmdBlock = cmd
    ? `<div class="tool-shell-head"><span class="tool-shell-label">Shell</span><code class="tool-shell-cmd">$ ${esc(cmd)}</code></div>`
    : "";
  const outBlock = out
    ? `<pre class="tool-shell-out">${esc(out)}</pre>`
    : "";
  const pathsHtml = meta.paths
    .map(
      (p) =>
        `<button type="button" class="tool-path-chip file-link" data-file-path="${esc(p)}" title="${esc(p)}">${esc(p.split(/[/\\]/).pop() || p)}</button>`,
    )
    .join("");
  const pathsBlock = pathsHtml
    ? `<div class="tool-paths">${pathsHtml}</div>`
    : "";
  return (
    `<div class="tool-detail" hidden>` +
    cmdBlock +
    outBlock +
    pathsBlock +
    `</div>`
  );
}

export function buildToolCardHtml(opts: {
  name: string;
  toolCallId?: string;
  running: boolean;
  raw?: unknown;
}): string {
  const meta = extractToolMeta(opts.raw, opts.name);
  const id = opts.toolCallId || opts.name;
  const state = opts.running ? tr("common.running") : tr("common.done");
  const stateCls = opts.running ? "running" : "done";
  const title = meta.summary || opts.name;
  const spin = opts.running
    ? `<span class="tool-spin"></span>`
    : `<span class="tool-spin done">✓</span>`;
  const hasDetail = Boolean(
    meta.command || meta.output || meta.paths.length,
  );
  const caret = hasDetail
    ? `<span class="tool-caret" aria-hidden="true">▸</span>`
    : "";

  return (
    `<div class="line tool agent-tool ${stateCls}${hasDetail ? " has-detail" : ""}" data-tool-id="${esc(id)}" data-tool-kind="${meta.kind}">` +
    `<button type="button" class="tool-row" ${hasDetail ? "" : "disabled"}>` +
    spin +
    `<span class="tool-kind-ico">${kindIcon(meta.kind)}</span>` +
    `<span class="tool-name" title="${esc(title)}">${esc(title)}</span>` +
    `<span class="tool-state">${state}</span>` +
    caret +
    `</button>` +
    detailHtml(meta) +
    `</div>`
  );
}

/** 绑定过程块内工具行展开/收起（事件委托，只绑一次） */
export function bindToolCardToggle(root: HTMLElement): void {
  if (root.dataset.toolToggleBound === "1") return;
  root.dataset.toolToggleBound = "1";
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.closest(".tool-path-chip, .file-link, a")) return;
    const row = t.closest(".tool-row") as HTMLElement | null;
    if (!row || row.hasAttribute("disabled")) return;
    const card = row.closest(".line.tool.has-detail") as HTMLElement | null;
    if (!card) return;
    e.preventDefault();
    const open = card.classList.toggle("is-open");
    const detail = card.querySelector(".tool-detail") as HTMLElement | null;
    if (detail) detail.hidden = !open;
    const caret = card.querySelector(".tool-caret");
    if (caret) caret.textContent = open ? "▾" : "▸";
  });
}

export function updateToolCardDone(row: HTMLElement, raw?: unknown): void {
  row.classList.remove("running");
  row.classList.add("done");
  const spin = row.querySelector(".tool-spin");
  if (spin) {
    spin.classList.add("done");
    spin.textContent = "✓";
  }
  const st = row.querySelector(".tool-state");
  if (st) st.textContent = tr("tool.completed");

  if (raw == null) return;
  const name =
    row.querySelector(".tool-name")?.textContent?.trim() || "tool";
  const meta = extractToolMeta(raw, name);
  if (meta.summary) {
    const nameEl = row.querySelector(".tool-name");
    if (nameEl && nameEl.textContent === name) {
      nameEl.textContent = meta.summary;
      nameEl.setAttribute("title", meta.summary);
    }
  }
  let detail = row.querySelector(".tool-detail") as HTMLElement | null;
  const html = detailHtml(meta);
  if (html) {
    row.classList.add("has-detail");
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const next = wrap.firstElementChild as HTMLElement;
    if (detail) {
      const wasOpen = row.classList.contains("is-open");
      detail.replaceWith(next);
      detail = next;
      detail.hidden = !wasOpen;
    } else {
      row.appendChild(next);
      // 确保有可点的 caret
      const btn = row.querySelector(".tool-row");
      if (btn && !btn.querySelector(".tool-caret")) {
        btn.removeAttribute("disabled");
        const c = document.createElement("span");
        c.className = "tool-caret";
        c.setAttribute("aria-hidden", "true");
        c.textContent = "▸";
        btn.appendChild(c);
      }
    }
  }
}
