/**
 * 统一 diff 专用渲染（Codex 式绿/红行）
 * - ```diff / ```patch 代码块
 * - 解析 --- a/ +++ b/ @@ 定位文件与行号
 * - 行可点 → 侧栏打开
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type DiffLineKind =
  | "meta"
  | "hunk"
  | "add"
  | "del"
  | "ctx"
  | "header";

export type ParsedDiffLine = {
  kind: DiffLineKind;
  text: string;
  /** 新文件侧行号（+ / 上下文） */
  newLine?: number;
  /** 旧文件侧行号（- / 上下文） */
  oldLine?: number;
  filePath?: string;
};

/** 从 diff 头解析路径：+++ b/src/foo.ts / --- a/src/foo.ts */
export function parseDiffFilePath(line: string): string | null {
  const m =
    /^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line.trim()) ||
    /^diff --git a\/(.+?) b\//.exec(line.trim());
  if (!m) return null;
  let p = m[1].trim();
  if (p === "/dev/null") return null;
  // 去掉引号
  p = p.replace(/^"|"$/g, "");
  return p || null;
}

/** 解析 @@ -old,count +new,count @@ */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

export function parseUnifiedDiff(text: string): {
  lines: ParsedDiffLine[];
  files: string[];
} {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const lines: ParsedDiffLine[] = [];
  const files: string[] = [];
  let currentFile: string | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines) {
    if (line.startsWith("diff --git")) {
      const fp = parseDiffFilePath(line);
      if (fp) {
        currentFile = fp;
        if (!files.includes(fp)) files.push(fp);
      }
      lines.push({ kind: "header", text: line, filePath: currentFile });
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const fp = parseDiffFilePath(line);
      // 优先 +++ b/ 作为打开目标
      if (line.startsWith("+++ ") && fp) {
        currentFile = fp;
        if (!files.includes(fp)) files.push(fp);
      } else if (line.startsWith("--- ") && fp && !currentFile) {
        currentFile = fp;
        if (!files.includes(fp)) files.push(fp);
      }
      lines.push({ kind: "meta", text: line, filePath: currentFile });
      continue;
    }
    if (line.startsWith("@@")) {
      const h = parseHunkHeader(line);
      if (h) {
        oldLine = h.oldStart;
        newLine = h.newStart;
      }
      lines.push({
        kind: "hunk",
        text: line,
        filePath: currentFile,
        oldLine: h?.oldStart,
        newLine: h?.newStart,
      });
      continue;
    }
    if (line.startsWith("+")) {
      lines.push({
        kind: "add",
        text: line,
        newLine,
        filePath: currentFile,
      });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      lines.push({
        kind: "del",
        text: line,
        oldLine,
        filePath: currentFile,
      });
      oldLine += 1;
      continue;
    }
    // 上下文或其它
    const isCtx = line.startsWith(" ") || line === "";
    lines.push({
      kind: isCtx ? "ctx" : "meta",
      text: line,
      oldLine: isCtx ? oldLine : undefined,
      newLine: isCtx ? newLine : undefined,
      filePath: currentFile,
    });
    if (isCtx && line !== "") {
      oldLine += 1;
      newLine += 1;
    }
  }

  return { lines, files };
}

/** 仅渲染 diff 正文行（Changes 面板内嵌用） */
export function renderDiffBodyHtml(code: string, filePathHint?: string): string {
  const { lines } = parseUnifiedDiff(code);
  if (!lines.length) {
    return `<div class="diff-line diff-meta"><span class="diff-gutter"></span><span class="diff-text">(empty diff)</span></div>`;
  }
  return lines
    .map((ln) => {
      const cls = `diff-line diff-${ln.kind}`;
      const lineNo =
        ln.kind === "add" || ln.kind === "ctx"
          ? ln.newLine
          : ln.kind === "del"
            ? ln.oldLine
            : undefined;
      const path = ln.filePath || filePathHint;
      const pathAttr = path ? ` data-file-path="${esc(path)}"` : "";
      const lineAttr = lineNo != null ? ` data-line="${lineNo}"` : "";
      const clickable =
        path && (ln.kind === "add" || ln.kind === "del" || ln.kind === "ctx")
          ? " diff-clickable"
          : "";
      const gutter =
        lineNo != null
          ? `<span class="diff-gutter">${lineNo}</span>`
          : `<span class="diff-gutter"></span>`;
      return (
        `<div class="${cls}${clickable}"${pathAttr}${lineAttr} role="${clickable ? "button" : "presentation"}">` +
        gutter +
        `<span class="diff-text">${esc(ln.text)}</span>` +
        `</div>`
      );
    })
    .join("");
}

/** 渲染为可点击的 diff 视图 HTML */
export function renderDiffBlockHtml(code: string): string {
  const { lines, files } = parseUnifiedDiff(code);
  const title =
    files.length === 1
      ? files[0]
      : files.length > 1
        ? `${files.length} 个文件`
        : "diff";

  const fileChips = files
    .slice(0, 6)
    .map(
      (f) =>
        `<button type="button" class="diff-file-chip file-link" data-file-path="${esc(f)}" title="${esc(f)}">${esc(f.split(/[/\\]/).pop() || f)}</button>`,
    )
    .join("");

  const body = lines
    .map((ln) => {
      const cls = `diff-line diff-${ln.kind}`;
      const lineNo =
        ln.kind === "add" || ln.kind === "ctx"
          ? ln.newLine
          : ln.kind === "del"
            ? ln.oldLine
            : undefined;
      const pathAttr = ln.filePath
        ? ` data-file-path="${esc(ln.filePath)}"`
        : "";
      const lineAttr =
        lineNo != null ? ` data-line="${lineNo}"` : "";
      const clickable =
        ln.filePath && (ln.kind === "add" || ln.kind === "del" || ln.kind === "ctx")
          ? " diff-clickable"
          : "";
      const gutter =
        lineNo != null
          ? `<span class="diff-gutter">${lineNo}</span>`
          : `<span class="diff-gutter"></span>`;
      return (
        `<div class="${cls}${clickable}"${pathAttr}${lineAttr} role="${clickable ? "button" : "presentation"}">` +
        gutter +
        `<span class="diff-text">${esc(ln.text)}</span>` +
        `</div>`
      );
    })
    .join("");

  return (
    `<div class="diff-block code-block">` +
    `<div class="code-block-head diff-head">` +
    `<span class="code-lang">diff</span>` +
    `<span class="diff-title">${esc(title)}</span>` +
    `<span class="diff-files">${fileChips}</span>` +
    `<button type="button" class="code-copy" data-copy-code title="Copy diff">Copy</button>` +
    `</div>` +
    `<div class="diff-body" data-copy-source>${body}</div>` +
    // 隐藏原始文本供复制
    `<pre class="diff-raw-hidden"><code>${esc(code)}</code></pre>` +
    `</div>`
  );
}

export function isDiffLanguage(lang?: string): boolean {
  const l = (lang || "").trim().toLowerCase();
  return l === "diff" || l === "patch" || l === "udiff";
}
