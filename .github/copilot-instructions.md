# copilot-ps-console-view

A GitHub Copilot CLI extension (Windows-only in practice) that opens a native
desktop webview showing every PowerShell command Copilot runs in a session,
plus its output, console-style.

## Architecture

Three processes cooperate at runtime:

1. **Copilot CLI host** loads `extension.mjs`. That bootstrapper runs
   `npm install` if `package-lock.json` is stale, then dynamically imports
   `main.mjs` (deps can't be statically imported on a fresh checkout).
2. **Extension process** (`main.mjs`) calls `joinSession()` from
   `@github/copilot-sdk/extension`, registers the `/ps-console-view` slash
   command, registers `onPreToolUse` / `onPostToolUse` hooks that filter for
   the `PS_TOOLS` set, and pushes `{kind:"call"|"result", ...}` events into a
   ring buffer (`MAX_HISTORY = 500`). Each event is mirrored to the page via
   `webview.eval("window.psConsole.append(...)")` — best-effort, ignored if
   the window isn't open yet.
3. **Webview child process** (`lib/webview-child.mjs`) is spawned by the
   `CopilotWebview` helper. It uses `@webviewjs/webview` (WebView2 on
   Windows) and **blocks its event loop in `app.run()`** — that's why it
   has to be a separate Node process. All communication happens over a
   WebSocket served by the parent on a random localhost port.

The page ↔ extension bridge is `lib/copilot-webview.js`:

- The parent runs an `http.createServer` + `ws.WebSocketServer` on
  `127.0.0.1:<random>`. It serves `contentDir` statically and injects
  `/__bridge.js` on demand. `index.html` must `<script src="/__bridge.js">`
  before its own scripts.
- `BRIDGE_JS` exposes `window.copilot` as a Proxy: any property access becomes
  an RPC call, dispatched server-side to the matching key in the `callbacks`
  object passed to `new CopilotWebview({ callbacks })`. Page-side calls look
  like `await window.copilot.getHistory()`.
- The reverse direction is `webview.eval(code)` from extension → page; the
  bridge `eval`s the code in the page and returns the JSON-serializable result.
- `CopilotWebview` exposes three tools to the agent, prefixed by
  `extensionName`: `<prefix>_show`, `<prefix>_eval`, `<prefix>_close`. Spread
  `webview.tools` into `joinSession({ tools })`.

`lib/` is intentionally generic / reusable. Treat `copilot-webview.js` as a
vendored library — feature work for *this* extension belongs in `main.mjs`
and `content/`.

## Conventions

- **ES modules everywhere.** `package.json` has `"type": "module"`; use
  `.mjs` for entry points, `.js` for library files imported via ESM.
- **Node 20+** (per README). Uses top-level `await`, `import.meta.dirname`.
- **Event shape** for the ring buffer (`main.mjs` → page): every event has
  `{id, timestamp, kind, toolName, toolCallId}`. `kind:"call"` adds `args`
  (already summarized per-tool by `summarizeArgs`); `kind:"result"` adds
  `forCallId` (linking back to the call's `id`), `status`, `output`.
  `extractResultText` understands the SDK's `{textResultForLlm, resultType}`
  shape.
- **Page-side replay protocol.** The page calls `window.copilot.getHistory()`
  on (re)connect to drain backlog, then relies on pushed `append(ev)` calls.
  `seenIds`/`lastSeenId` in `content/main.js` deduplicate.
- **Per-window WebView2 user-data dir.** On Windows, `showWebview` sets
  `WEBVIEW2_USER_DATA_FOLDER` to `%TEMP%\copilot-webview-<id>` and cleans it
  up after the child exits (with retries — WebView2 holds locks briefly).
  Don't rely on the default WebView2 folder.
- **Window icon.** The webview titlebar/window icon comes from a pre-baked
  `.rgba` blob, not a PNG, so the child process has no PNG-decoder dep.
  Format (produced by `scripts\bake-icon.mjs`): `[uint32 LE width][uint32 LE
  height][raw RGBA8 pixels]`. To replace the icon: drop a new PNG into
  `content\`, then `npm install --no-save pngjs && node scripts\bake-icon.mjs
  content\new.png content\new.rgba`, and update the `iconPath` passed to
  `CopilotWebview` in `main.mjs`. `pngjs` is a devDependency only.
  *Caveat:* on Windows the **taskbar** icon stays as `node.exe`'s logo —
  it's keyed off the process AppUserModelID, not the window icon, and
  setting an AUMID would require a `shell32` FFI dep we deliberately avoid.

- **Hot-reload during development.** Editing files under `content/` does NOT
  require restarting the CLI. Trigger `ps_console_view_show` with
  `reload: true` (or call `webview.show({ reload: true })`) to refresh the
  page. Editing `main.mjs` or `lib/` requires a full extension reload
  (`/reload-extensions` or restart the CLI).
- **Adding a new captured tool** = add its name to `PS_TOOLS` in `main.mjs`,
  extend the `summarizeArgs` switch with a sensible projection, and (if the
  page should render it specially) update `renderCall` in `content/main.js`.

## Install / dev workflow (Windows PowerShell)

```powershell
npm install
# Symlink the working tree into a discovery location so edits are live:
New-Item -ItemType Junction `
  -Path "C:\path\to\project\.github\extensions\copilot-ps-console-view" `
  -Target "D:\DEV_TESTS\copilot-ps-console-view"
# Then `/reload-extensions` inside Copilot CLI.
```

End-user install/uninstall is via `scripts\install.ps1` /
`scripts\uninstall.ps1` (see README for parameters: `-Scope Project|Global`,
`-ProjectPath`, `-Ref`, `-RepoUrl`, `-Force`).

There are no tests, lint, or build steps in this repo.
