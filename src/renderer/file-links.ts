/**
 * 对话内文件路径可点击（对齐 Codex / Claude Desktop）
 * - 识别绝对/相对路径 + :line[:col]
 * - 渲染为 .file-link，点击走 Host openInEditor / openPath
 */

/** 匹配常见源码路径（含 Windows / Unix / 相对 + 可选行号） */
const PATH_RE =
  /(?<![\w./\\@-])((?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/|\.\/|\.\.\/|~\/)[^\s`'"<>|*?\n]+?|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,16})(?::(\d{1,7}))?(?::(\d{1,7}))?(?![\w./\\-])/g;

const EXT_HINT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|vue|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sql|yml|yaml|toml|xml|sh|bash|zsh|ps1|bat|cmd|txt|log|env|gitignore|dockerignore|lock|gradle|proto|graphql|gql|vue|svelte)$/i;

/**
 * `/goal`、`/plan`、`/status` 等 CLI slash：单段、无扩展名的「假绝对路径」。
 * 真文件至少还有一层目录（/Users/…/a.ts）或带扩展（/tmp/x.md）。
 */
export function isSlashCommandPath(p: string): boolean {
  const s = p.trim().replace(/[.,;:)+\]}>]+$/g, "");
  return /^\/[A-Za-z][\w-]*$/.test(s);
}

export type ParsedFileRef = {
  path: string;
  line?: number;
  col?: number;
  display: string;
};

export function parseFileRef(match: string, line?: string, col?: string): ParsedFileRef | null {
  let p = match.trim();
  if (!p) return null;
  // file:///C:/... or file:///Users/...
  if (p.startsWith("file://")) {
    p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ""));
    // Windows file:///C:/x → C:/x
    if (/^[A-Za-z]:\//.test(p) === false && /^[A-Za-z]\//.test(p)) {
      // rare
    }
  }
  // 去掉尾部标点
  p = p.replace(/[.,;:)+\]}>]+$/g, "");
  if (p.length < 3) return null;
  // 勿把 /goal /plan 等斜杠命令当成文件
  if (isSlashCommandPath(p)) return null;
  // 相对路径需要像文件；绝对路径放宽
  const isAbs =
    /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
  if (!isAbs && !EXT_HINT.test(p) && !p.includes("/") && !p.includes("\\")) {
    return null;
  }
  // 目录名误伤：无扩展且不像路径
  if (!isAbs && !EXT_HINT.test(p) && !/[\\/]/.test(p)) return null;

  const ln = line ? Number(line) : undefined;
  const cn = col ? Number(col) : undefined;
  return {
    path: p,
    line: Number.isFinite(ln) && (ln as number) > 0 ? ln : undefined,
    col: Number.isFinite(cn) && (cn as number) > 0 ? cn : undefined,
    display: match,
  };
}

/** 相对路径相对 cwd 解析（浏览器侧轻量实现） */
export function resolveAgainstCwd(filePath: string, cwd?: string | null): string {
  let p = filePath.replace(/\//g, "\\");
  const useWin = Boolean(cwd && /\\/.test(cwd)) || /^[A-Za-z]:\\/.test(p);
  if (!useWin) p = filePath.replace(/\\/g, "/");

  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\\\")) {
    return filePath;
  }
  if (!cwd) return filePath;

  const sep = useWin ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  let rel = filePath;
  if (rel.startsWith("./") || rel.startsWith(".\\")) rel = rel.slice(2);
  // .. 简单处理
  const stack = base.split(/[\\/]/).filter(Boolean);
  // keep drive on windows
  const drive = useWin && /^[A-Za-z]:$/.test(stack[0] ?? "") ? stack.shift()! : null;
  for (const part of rel.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  if (drive) return `${drive}${sep}${stack.join(sep)}`;
  if (!useWin) return `/${stack.join("/")}`;
  return stack.join(sep);
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extLabel(p: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(p);
  return (m?.[1] || "file").toUpperCase().slice(0, 3);
}

function linkHtml(ref: ParsedFileRef, resolved: string): string {
  const lineAttr = ref.line != null ? ` data-line="${ref.line}"` : "";
  const title = ref.line
    ? `${resolved}:${ref.line}`
    : resolved;
  const name = resolved.replace(/\\/g, "/").split("/").pop() || resolved;
  const lineSpan =
    ref.line != null
      ? `<span class="chip-line">:${ref.line}</span>`
      : "";
  // Codex 式 pill chip
  return (
    `<a href="#" class="file-link file-chip" data-file-path="${escHtml(resolved)}"${lineAttr} title="${escHtml(title)}">` +
    `<span class="chip-ico">${escHtml(extLabel(name))}</span>` +
    `<span class="chip-name">${escHtml(name)}</span>${lineSpan}</a>`
  );
}

/**
 * 在已渲染的助手气泡内把路径变成可点击链接。
 * 跳过 a/button/已有 file-link。
 */
export function linkifyFilePaths(
  root: HTMLElement,
  cwd?: string | null,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("a, button, .file-link, .code-block-head")) {
        return NodeFilter.FILTER_REJECT;
      }
      const t = node.textContent ?? "";
      if (t.length < 4) return NodeFilter.FILTER_REJECT;
      PATH_RE.lastIndex = 0;
      if (!PATH_RE.test(t)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const texts: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) texts.push(n as Text);

  for (const textNode of texts) {
    const raw = textNode.textContent ?? "";
    PATH_RE.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    const frag = document.createDocumentFragment();
    let any = false;
    while ((m = PATH_RE.exec(raw)) !== null) {
      const full = m[0];
      const pathPart = m[1];
      const line = m[2];
      const col = m[3];
      const ref = parseFileRef(pathPart, line, col);
      if (!ref) continue;
      // 还原 display 含 :line
      ref.display = full;
      const start = m.index;
      if (start > last) {
        frag.appendChild(document.createTextNode(raw.slice(last, start)));
      }
      const resolved = resolveAgainstCwd(ref.path, cwd);
      const span = document.createElement("span");
      span.innerHTML = linkHtml(ref, resolved);
      frag.appendChild(span.firstChild!);
      last = start + full.length;
      any = true;
    }
    if (!any) continue;
    if (last < raw.length) {
      frag.appendChild(document.createTextNode(raw.slice(last)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  // Markdown 中的 file:// 与相对/仓库路径链接 → file-link（侧栏打开）
  Array.from(
    root.querySelectorAll<HTMLAnchorElement>(
      "a[href^='file:'], a.md-path-link, a[data-md-path]",
    ),
  ).forEach((a) => {
    try {
      if (a.classList.contains("file-link")) return;
      if (a.classList.contains("md-external-link")) return;
      const href = (
        a.getAttribute("data-md-path") ||
        a.getAttribute("href") ||
        ""
      ).trim();
      if (!href || href.startsWith("#") || /^https?:/i.test(href) || /^mailto:/i.test(href)) {
        return;
      }
      let p = href;
      let line: number | undefined;
      if (p.startsWith("file:")) {
        p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ""));
      }
      // path:line 或 path:line:col（避开 Windows 盘符 C:）
      const lineM = /^(.+):(\d{1,7})(?::\d{1,7})?$/.exec(p);
      if (lineM && !/^[A-Za-z]:\\/.test(p) && !/^[A-Za-z]:\//.test(p)) {
        p = lineM[1]!;
        line = Number(lineM[2]);
      }
      if (isSlashCommandPath(p)) {
        // Markdown 误链的 slash 命令：还原为纯文本
        const text = a.textContent || p;
        a.replaceWith(document.createTextNode(text));
        return;
      }
      const resolved = resolveAgainstCwd(p, cwd);
      a.classList.add("file-link");
      a.classList.remove("md-path-link");
      a.dataset.filePath = resolved;
      if (line && Number.isFinite(line) && line > 0) {
        a.dataset.line = String(line);
      }
      a.href = "#";
      a.title = line ? `打开 ${resolved}:${line}` : `打开 ${resolved}`;
    } catch {
      /* ignore */
    }
  });
}

export type OpenFileHandler = (path: string, line?: number) => void | Promise<void>;

/**
 * 点击路径入口：
 * - a.file-link / button.file-link
 * - .diff-clickable / .diff-file-chip / .tool-path-chip（data-file-path）
 */
export function bindFileLinkDelegate(
  root: HTMLElement,
  open: OpenFileHandler,
): void {
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    // 复制按钮不抢
    if (t.closest("[data-copy-code]")) return;

    const el = t.closest(
      "a.file-link, button.file-link, .diff-clickable, .diff-file-chip, .tool-path-chip, [data-file-path].file-link",
    ) as HTMLElement | null;
    if (!el) return;

    const filePath = el.dataset.filePath ?? "";
    if (!filePath) return;
    e.preventDefault();
    e.stopPropagation();
    const lineAttr = el.dataset.line;
    const line = lineAttr ? Number(lineAttr) : undefined;
    void open(filePath, Number.isFinite(line) ? line : undefined);
  });
}
