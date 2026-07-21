/**
 * 对话内文件路径可点击（对齐 Codex / Claude Desktop）
 * - 识别绝对/相对路径 + :line[:col]
 * - 渲染为 .file-link，点击走侧栏 openFile
 *
 * 规则从紧：只链「像源码/配置文件」的路径，避免把 /sessions/、phase 等
 * 文本误当成路径按钮，点开后侧栏空空。
 */

/** 匹配候选路径（含 Windows / Unix / 相对 + 可选行号）；最终以 isLinkableFilePath 过滤 */
const PATH_RE =
  /(?<![\w./\\@-])((?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/|\.\/|\.\.\/|~\/)[^\s`'"<>|*?\n]+?|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,16})(?::(\d{1,7}))?(?::(\d{1,7}))?(?![\w./\\-])/g;

/** 常见源码/配置扩展名（linkify 必须命中其一，或落在无扩展白名单） */
const EXT_HINT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|less|html|htm|vue|svelte|py|rs|go|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|hxx|cs|rb|php|sql|yml|yaml|toml|xml|sh|bash|zsh|ps1|bat|cmd|txt|log|env|gitignore|dockerignore|lock|gradle|proto|graphql|gql|svg|png|jpg|jpeg|gif|webp|ico|wasm|map|d\.ts)$/i;

/** 无扩展名但常被引用的文件名 */
const EXTLESS_NAMES = new Set(
  [
    "Makefile",
    "Dockerfile",
    "dockerfile",
    "LICENSE",
    "LICENCE",
    "COPYING",
    "README",
    "CHANGELOG",
    "CHANGES",
    "AUTHORS",
    "CONTRIBUTING",
    "Gemfile",
    "Rakefile",
    "Procfile",
    "Vagrantfile",
    "Jenkinsfile",
    "CMakeLists.txt",
  ].map((s) => s.toLowerCase()),
);

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

function baseNameOf(p: string): string {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/**
 * 是否值得做成可点击文件芯片。
 * 绝对路径也不再「放宽」：必须有扩展名或已知无扩展文件名。
 */
export function isLinkableFilePath(filePath: string): boolean {
  let p = filePath.trim();
  if (!p || p.length < 3) return false;
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ""));
    } catch {
      return false;
    }
  }
  // 去掉尾部标点与多余斜杠
  p = p.replace(/[.,;:)+\]}>]+$/g, "");
  if (/[\\/]$/.test(p)) return false; // 目录
  if (p.length < 3) return false;

  // URL / 伪路径：仅有一截且无扩展的 Unix 绝对路径（/sessions、/phase）
  const unixAbsOneSeg = /^\/[^/\\]+$/.test(p);
  if (unixAbsOneSeg && !EXT_HINT.test(p)) return false;

  const name = baseNameOf(p);
  if (!name || name === "." || name === "..") return false;
  if (EXTLESS_NAMES.has(name.toLowerCase())) return true;
  if (EXT_HINT.test(name) || EXT_HINT.test(p)) return true;

  // 其它短扩展（.vue 已在 EXT_HINT）— 允许 1–10 位字母数字扩展，排除纯数字（版本号）
  const extM = /\.([A-Za-z][A-Za-z0-9_-]{0,9})$/.exec(name);
  if (extM) return true;

  return false;
}

export function parseFileRef(
  match: string,
  line?: string,
  col?: string,
): ParsedFileRef | null {
  let p = match.trim();
  if (!p) return null;
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ""));
    } catch {
      return null;
    }
  }
  p = p.replace(/[.,;:)+\]}>]+$/g, "");
  if (p.length < 3) return null;
  // 勿把 /goal /plan 等斜杠命令当成文件
  if (isSlashCommandPath(p)) return null;
  // Upstream 路径收紧：严格挡住 /sessions、目录、纯前缀等伪路径，避免误链 FIL chip
  if (!isLinkableFilePath(p)) return null;

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

  if (
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.startsWith("/") ||
    filePath.startsWith("\\\\")
  ) {
    return filePath;
  }
  if (!cwd) return filePath;

  const sep = useWin ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  let rel = filePath;
  if (rel.startsWith("./") || rel.startsWith(".\\")) rel = rel.slice(2);
  const stack = base.split(/[\\/]/).filter(Boolean);
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

function linkHtml(ref: ParsedFileRef, resolved: string): string {
  const lineAttr = ref.line != null ? ` data-line="${ref.line}"` : "";
  const title = ref.line ? `${resolved}:${ref.line}` : resolved;
  const name = resolved.replace(/\\/g, "/").split("/").pop() || resolved;
  let label = (ref.display || name).replace(/\\/g, "/");
  if (/^file:\/\//i.test(label) || label.length > 64) {
    label = ref.line != null ? `${name}:${ref.line}` : name;
  }
  // Cursor 单层内联路径链：不再叠 FIL 徽章 chip，避免误链视觉过重
  return (
    `<a href="#" class="file-link" data-file-path="${escHtml(resolved)}"${lineAttr} title="${escHtml(title)}">` +
    `${escHtml(label)}</a>`
  );
}

/** 将仅含路径的 inline <code> 提升为 file-link，避免 code 背景叠在链接上 */
function promoteCodePaths(root: HTMLElement, cwd?: string | null): void {
  for (const code of Array.from(root.querySelectorAll("code"))) {
    if (code.closest("pre, a, button, .file-link, .code-block-head")) continue;
    const raw = (code.textContent ?? "").trim();
    if (raw.length < 3 || /\s/.test(raw)) continue;

    let ref: ParsedFileRef | null = null;
    PATH_RE.lastIndex = 0;
    const m = PATH_RE.exec(raw);
    if (m && m[0] === raw) {
      ref = parseFileRef(m[1]!, m[2], m[3]);
    } else if (EXT_HINT.test(raw)) {
      // 裸文件名 `anime.iife.min.js`：整段 code 升为路径链
      ref = parseFileRef(raw);
    }
    if (!ref) continue;
    ref.display = raw;
    const resolved = resolveAgainstCwd(ref.path, cwd);
    const wrap = document.createElement("span");
    wrap.innerHTML = linkHtml(ref, resolved);
    const link = wrap.firstChild;
    if (link) code.replaceWith(link);
  }
}

function shouldSkipLinkifyParent(parent: Element | null): boolean {
  if (!parent) return true;
  if (
    parent.closest(
      "a, button, .file-link, .code-block-head, pre, code, .hljs, script, style, textarea, kbd, samp",
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 在已渲染的助手气泡内把路径变成可点击链接。
 * 跳过 a/button/code/pre/已有 file-link。
 */
export function linkifyFilePaths(
  root: HTMLElement,
  cwd?: string | null,
): void {
  // 先处理整段路径的 inline code，再扫纯文本（避免 <code><a class=file-link>）
  promoteCodePaths(root, cwd);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      // 上游收紧：一并跳过 .hljs / script / style / textarea / kbd / samp
      if (shouldSkipLinkifyParent(parent)) return NodeFilter.FILTER_REJECT;
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
      if (
        !href ||
        href.startsWith("#") ||
        /^https?:/i.test(href) ||
        /^mailto:/i.test(href)
      ) {
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
      if (!isLinkableFilePath(p)) {
        // 伪路径：还原为普通文本样式，避免点进空侧栏
        a.classList.remove("md-path-link");
        a.removeAttribute("data-md-path");
        a.removeAttribute("href");
        a.classList.add("md-path-plain");
        return;
      }
      const resolved = resolveAgainstCwd(p, cwd);
      // Cursor 视觉：单层扁平内联链，不加 file-chip 徽章
      a.classList.add("file-link");
      a.classList.remove("md-path-link", "file-chip");
      a.dataset.filePath = resolved;
      if (line && Number.isFinite(line) && line > 0) {
        a.dataset.line = String(line);
      }
      a.href = "#";
      a.title = line ? `打开 ${resolved}:${line}` : `打开 ${resolved}`;
      // Markdown `[`path`](path)` → <a><code>path</code></a>：拆掉 code 壳，只留一层链接样式
      const onlyCode = a.childNodes.length === 1 && a.firstElementChild?.tagName === "CODE";
      if (onlyCode) {
        const text = a.textContent || resolved;
        a.textContent = text;
      }
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
