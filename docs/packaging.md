# Grok Desktop 打包与 agent-bin

目标：安装包可自带 agent；开发时使用项目内 `agent-bin/`，**不必每次从本机复制**（更新 agent 时再覆盖或 `npm run sync:agent`）。

## 目录

| 路径 | 用途 |
|------|------|
| `agent-bin/grok.exe`（或 `grok`） | 开发与打包的权威二进制 |
| `agent-bin/VERSION.txt` | `sync:agent` 写入：version / source / synced_at / sha256 |
| 安装后 `resources/agent/` | 用户机器上的内置 agent + VERSION.txt |
| `~/.grok-desktop` | 用户数据（登录/会话），**不打包** |

## 解析顺序

与 `src/host/resolve-grok.ts` 一致：

1. 设置 / `GROK_DESKTOP_AGENT`（override）
2. **agent-bin**（开发）或 **resources/agent**（安装包，bundled）
3. PATH / `~/.grok/bin` / `~/.grok-desktop/bin`

## 准备二进制

```bash
# 可选：从本机 CLI 同步一次到 agent-bin（并写 VERSION.txt）
npm run sync:agent

# 或指定路径
npm run sync:agent -- --from /path/to/grok

# 或设置 GROK_AGENT_SOURCE 后 npm run sync:agent
```

二进制与 `VERSION.txt` **默认不入库**（gitignore）；发版机本地保留即可。

## 开发 / 打包

```bash
# 确认 agent-bin 下已有二进制
npm run check:agent
npm start

npm run dist:win   # Windows；extraResources → resources/agent
npm run dist:mac   # macOS DMG（本机 arch；agent-bin/grok 须同架构）
npm run dist:mac:dir
```

`pack` / `dist` / `dist:win` / `dist:mac` 在缺少有效二进制时会 **失败退出**，避免空 agent 安装包。

校验：设置 → 关于 → 来源应为 `bundled（agent-bin / 安装包）`；若有 `VERSION.txt` 会显示记录版本、同步时间、sha256 前缀。

## 发版建议

1. 固定 agent 来源后执行 `npm run sync:agent`
2. 记录 Desktop `package.json` version 与关于页中的 agent version / sha256
3. Release 说明中同时写清两者与目标平台（如 `mac-arm64` / `win-x64`）
4. **agent 二进制必须与安装包目标 OS/CPU 一致**（勿把 Windows `grok.exe` 打进 macOS 包）
5. macOS 本地包默认 **不签名**（`identity: null`）；分发前需自行签名与公证

## 相关代码

- `src/host/agent-bin.ts` — 路径候选
- `src/host/resolve-grok.ts` — 解析顺序与 VERSION 元数据
- `scripts/sync-agent-bin.mjs` — 同步 + VERSION.txt
- `scripts/check-agent-bin.mjs` — 打包前检查
- `package.json` → `build.extraResources`
