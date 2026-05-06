// PowerShell console visualizer extension.
// Captures all PowerShell-related tool calls invoked by Copilot and streams
// them, with their results, into a console-like webview window.
import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { CopilotWebview } from "./lib/copilot-webview.js";

const PS_TOOLS = new Set([
    "powershell",
    "write_powershell",
    "read_powershell",
    "stop_powershell",
    "list_powershell",
]);

// Theme directories. Built-in themes ship with the extension; user themes live
// in a separate directory the extension's installer preserves across upgrades.
// The env var override exists for users who want their themes in a dotfiles
// repo or shared location.
const themesBuiltinDir = join(import.meta.dirname, "content", "themes");
const themesUserDir = process.env.COPILOT_PS_CONSOLE_THEMES_DIR
    || join(import.meta.dirname, "themes");
// State file: { name: "<theme-name>", mode: "light" | "dark" | "system" }.
// Lives inside the user themes dir so the installer's preserve-themes step
// rescues it on upgrade. `name` is read on page load to restore the user's
// last theme choice (the webview's per-window WEBVIEW2_USER_DATA_FOLDER is
// wiped on close, so localStorage is not durable). `mode` is used to set the
// *native* window theme (titlebar, native chrome) on the next window open.
const themeStateFile = join(themesUserDir, ".state.json");

function readThemeState() {
    try { return JSON.parse(readFileSync(themeStateFile, "utf8")); }
    catch { return {}; }
}

function writeThemeState(state) {
    try {
        mkdirSync(themesUserDir, { recursive: true });
        writeFileSync(themeStateFile, JSON.stringify(state, null, 2));
    } catch {
        // Best-effort. If the dir is read-only the user gets the page-side
        // theme; only the next-open native chrome won't follow.
    }
}

// Scan built-in then user themes; user files of the same name override builtins.
// Re-scans on every call — drop a .css file in themesUserDir, reopen the picker
// menu, and it appears. Returns: [{name, source: "builtin"|"user", css}]
function listThemesImpl() {
    const map = new Map();
    const scan = (dir, source) => {
        let entries;
        try { entries = readdirSync(dir); }
        catch { return; }
        for (const name of entries) {
            if (!name.toLowerCase().endsWith(".css")) continue;
            const abs = join(dir, name);
            try {
                if (!statSync(abs).isFile()) continue;
                const css = readFileSync(abs, "utf8");
                const key = name.slice(0, -4);
                map.set(key, { name: key, source, css });
            } catch {
                // Skip files we can't read.
            }
        }
    };
    scan(themesBuiltinDir, "builtin");
    scan(themesUserDir, "user");
    return [...map.values()];
}

// In-memory ring buffer of recent events so the page can replay history when
// it (re)connects, and so events that arrive before the window opens are not
// lost. Each event is a JSON-serializable object.
const MAX_HISTORY = 500;
const history = [];
let nextId = 1;
// Map toolCallId -> event id, so post events can reference their pre event.
const callIdToEventId = new Map();

// --- Session info (footer + window title) ---------------------------------
// Snapshot of the bits of session metadata the page cares about. The extension
// SDK doesn't expose `summary` directly on the Session instance — it only gives
// us `sessionId` and `_workspacePath`. The host CLI persists workspace metadata
// (including the AI-generated summary, e.g. "Get Latest Versions") to
// `<workspacePath>/workspace.yaml`. We read that file directly. Polled cheaply
// on every tool call and prompt; pushed to the page only when it changes.
let lastSessionInfo = null;

function readWorkspaceSummary(workspacePath) {
    if (!workspacePath || typeof workspacePath !== "string") return null;
    try {
        const yaml = readFileSync(join(workspacePath, "workspace.yaml"), "utf8");
        // Tiny inline parse — we only need the top-level `summary:` line. Avoid
        // pulling in a YAML dependency for one field. Matches: `summary: <text>`
        // (unquoted scalar) since that's what the host writes.
        const m = yaml.match(/^summary:\s*(.*)$/m);
        if (!m) return null;
        let val = m[1].trim();
        // Strip surrounding quotes if the host happened to quote it.
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        return val || null;
    } catch {
        return null;
    }
}

function snapshotSessionInfo() {
    if (typeof session === "undefined" || !session) return null;
    return {
        sessionId: session.sessionId,
        summary: readWorkspaceSummary(session._workspacePath),
    };
}

function pollSessionInfo() {
    const info = snapshotSessionInfo();
    if (!info) return;
    if (lastSessionInfo
        && lastSessionInfo.sessionId === info.sessionId
        && lastSessionInfo.summary === info.summary) {
        return;
    }
    lastSessionInfo = info;
    webview
        .eval(`window.psConsole && window.psConsole.setSessionInfo(${JSON.stringify(info)})`)
        .catch(() => {});
}

function pushEvent(ev) {
    ev.id = nextId++;
    ev.timestamp = Date.now();
    history.push(ev);
    if (history.length > MAX_HISTORY) history.shift();
    // Best-effort push to the page; ignore if window isn't open.
    webview
        .eval(`window.psConsole && window.psConsole.append(${JSON.stringify(ev)})`)
        .catch(() => {});
    return ev;
}

function summarizeArgs(toolName, args) {
    if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { return { raw: args }; }
    }
    if (!args || typeof args !== "object") return { raw: args };
    switch (toolName) {
        case "powershell":
            return {
                command: args.command,
                description: args.description,
                mode: args.mode,
                shellId: args.shellId,
                detach: args.detach,
                initial_wait: args.initial_wait,
            };
        case "write_powershell":
            return { shellId: args.shellId, input: args.input, delay: args.delay };
        case "read_powershell":
            return { shellId: args.shellId, delay: args.delay };
        case "stop_powershell":
            return { shellId: args.shellId };
        default:
            return args;
    }
}

function extractResultText(toolResult) {
    if (toolResult == null) return "";
    if (typeof toolResult === "string") return toolResult;
    if (typeof toolResult === "object") {
        if (typeof toolResult.textResultForLlm === "string") return toolResult.textResultForLlm;
        try {
            return JSON.stringify(toolResult, null, 2);
        } catch {
            return String(toolResult);
        }
    }
    return String(toolResult);
}

function resultStatus(toolResult) {
    if (toolResult && typeof toolResult === "object" && typeof toolResult.resultType === "string") {
        return toolResult.resultType;
    }
    return "success";
}

const webview = new CopilotWebview({
    extensionName: "ps_console_view",
    contentDir: join(import.meta.dirname, "content"),
    title: "Copilot PowerShell Console",
    width: 1100,
    height: 700,
    iconPath: join(import.meta.dirname, "content", "terminal-copilot.rgba"),
    theme: readThemeState().mode || "system",
    callbacks: {
        // Page asks for the full backlog when it (re)connects.
        getHistory: () => history,
        // Optional: page can ask the extension to forget history.
        clearHistory: () => {
            history.length = 0;
            return true;
        },
        // Returns built-in + user themes. Re-scans on every call.
        listThemes: () => listThemesImpl(),
        // Returns the persisted theme name (or null if none). Page calls this
        // on startup before falling back to prefers-color-scheme.
        getInitialTheme: () => readThemeState().name || null,
        // Returns {sessionId, summary}. Page calls this on first connect to
        // populate the footer and window title; subsequent updates arrive via
        // window.psConsole.setSessionInfo pushed by pollSessionInfo().
        getSessionInfo: () => snapshotSessionInfo(),
        // Page calls this whenever the user picks a theme. We persist {name,
        // mode}: name so the choice survives across window reopens (the
        // webview's localStorage is per-window-instance, not durable); mode
        // so the next-open native chrome (Win11 titlebar) follows. Also
        // updates the in-memory webview.theme so a subsequent show() from
        // the same session uses the right native theme. Native chrome
        // cannot be changed for an already-open window.
        setThemeChoice: (choice) => {
            const c = choice && typeof choice === "object" ? choice : {};
            const name = typeof c.name === "string" ? c.name : null;
            const mode = c.mode === "light" || c.mode === "dark" ? c.mode : "system";
            writeThemeState({ name, mode });
            webview.setTheme(mode);
            return { name, mode };
        },
        log: (msg, opts) => session.log(msg, opts),
    },
});

const session = await joinSession({
    tools: webview.tools,
    commands: [
        {
            name: "ps-console-view",
            description: "Open the PowerShell console visualizer window.",
            handler: async () => {
                await webview.show();
            },
        },
    ],
    hooks: {
        onPreToolUse: async (input, invocation) => {
            // Poll on every tool call regardless of which tool — the AI may
            // regenerate the session summary after any turn, not just PS ones.
            pollSessionInfo();
            if (!PS_TOOLS.has(input.toolName)) return;
            const ev = pushEvent({
                kind: "call",
                toolName: input.toolName,
                toolCallId: invocation?.toolCallId,
                args: summarizeArgs(input.toolName, input.toolArgs),
            });
            if (invocation?.toolCallId) callIdToEventId.set(invocation.toolCallId, ev.id);
        },
        onPostToolUse: async (input, invocation) => {
            pollSessionInfo();
            if (!PS_TOOLS.has(input.toolName)) return;
            const callEventId = invocation?.toolCallId
                ? callIdToEventId.get(invocation.toolCallId)
                : undefined;
            if (invocation?.toolCallId) callIdToEventId.delete(invocation.toolCallId);
            pushEvent({
                kind: "result",
                toolName: input.toolName,
                toolCallId: invocation?.toolCallId,
                forCallId: callEventId,
                status: resultStatus(input.toolResult),
                output: extractResultText(input.toolResult),
            });
        },
        // Best moment to refresh the title — Copilot often updates the session
        // summary right after a user message arrives.
        userPromptSubmitted: async () => { pollSessionInfo(); },
        onSessionEnd: webview.close,
    },
});

// Initial snapshot now that `session` exists, so getSessionInfo() returns
// real data the moment the page connects (no need to wait for a tool call).
pollSessionInfo();

// Announce that the extension has finished loading. Doing this after
// joinSession() resolves means the message fires once at extension
// load-time, not on every onSessionStart hook invocation.
try {
    await session.log("copilot-ps-console-view loaded. Use /ps-console-view to open the PowerShell console window.");
} catch {
    // Logging is best-effort; never block extension load.
}
