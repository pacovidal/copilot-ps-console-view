// PowerShell console visualizer extension.
// Captures all PowerShell-related tool calls invoked by Copilot and streams
// them, with their results, into a console-like webview window.
import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { CopilotWebview } from "./lib/copilot-webview.js";

// --- Diagnostic debug log (opt-in) -----------------------------------------
// Disk logger gated by COPILOT_PS_CONSOLE_DEBUG=1. Records hook entries,
// reload/lifecycle signals, and tool-pairing decisions for diagnostics.
// Output: ~/.copilot/extensions/copilot-ps-console-view/_debug.log
//
// Format: one JSON object per line. ALL CALLS ARE BEST-EFFORT — if anything
// throws inside dlog, the regular extension code keeps running.
//
// Off by default in release builds. Set COPILOT_PS_CONSOLE_DEBUG=1 in the
// environment of your Copilot CLI shell before launching it to enable.
const DEBUG_ENABLED = process.env.COPILOT_PS_CONSOLE_DEBUG === "1";
const DEBUG_LOG_PATH = join(homedir(), ".copilot", "extensions", "copilot-ps-console-view", "_debug.log");
let _dlogStartLogged = false;
function dlog(event, payload) {
    if (!DEBUG_ENABLED) return;
    try {
        const line = JSON.stringify({
            t: new Date().toISOString(),
            pid: process.pid,
            event,
            payload: payload === undefined ? null : payload,
        });
        appendFileSync(DEBUG_LOG_PATH, line + "\n", { encoding: "utf8" });
        if (!_dlogStartLogged) {
            _dlogStartLogged = true;
            // Log a clear separator on first write so distinct extension
            // instances are easy to find when scrolling the file.
            appendFileSync(DEBUG_LOG_PATH, "----- new extension instance pid=" + process.pid + " -----\n", { encoding: "utf8" });
        }
    } catch {}
}
dlog("extension.module_top", { argv: process.argv, cwd: process.cwd(), parentPid: process.ppid });
process.on("exit", (code) => dlog("extension.exit", { code }));
process.on("SIGINT", () => dlog("extension.SIGINT"));
process.on("SIGTERM", () => dlog("extension.SIGTERM"));
process.on("disconnect", () => dlog("extension.disconnect"));
process.on("uncaughtException", (e) => dlog("extension.uncaughtException", { message: String(e?.message || e), stack: String(e?.stack || "") }));
process.on("unhandledRejection", (e) => dlog("extension.unhandledRejection", { message: String(e?.message || e) }));

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

// Tracking pending call events for pair-matching with their result events.
// The SDK hook signature gives us no toolCallId (`invocation` is `{sessionId}`
// only), so we can't pair by id directly. Instead we pair by the FINGERPRINT
// of (toolName, summarized args) — the args object is identical at pre and
// post time for the same tool call, so the fingerprint matches in nearly all
// real-world scenarios.
//
// Why fingerprint and not pure FIFO?
//   - When a tool result is non-success (failure / rejected / denied / timeout),
//     the SDK does NOT fire postToolUse. (Only the upstream CLI's
//     `postToolUseFailure` hook fires for failures, but the @github/copilot-sdk
//     does NOT expose it to extensions — its `_handleHooksInvoke` handler map
//     only includes preToolUse, postToolUse, userPromptSubmitted,
//     sessionStart, sessionEnd, errorOccurred.) A pure FIFO queue would leak
//     the pre's event id on every non-success result, then the next
//     *successful* result for the same toolName would dequeue that stale id
//     and pair itself with the wrong call. Fingerprint matching scopes the
//     leak to other calls with byte-identical args.
//
// Bounded growth: we don't get a postToolUse hook for non-success calls, so
// stale entries accumulate. They're pruned on every push using the natural
// boundary of the `history` ring buffer — once a call event has been evicted
// from `history`, its id can never be matched anyway, so we drop it from the
// pending map. This bounds the map at most ~MAX_HISTORY entries.
//
// Known residual edge case: two calls with byte-identical summarized args
// where their post hooks complete out of pre-hook order (e.g. two parallel
// `read_powershell` with the same shellId+delay where the second finishes
// first; or one of two identical calls fails so its post never fires while
// the other succeeds). The result is paired with the wrong same-fingerprint
// call. Always-mispairs cluster of 2 entries; doesn't poison anything else.
// Documented in README.
const pendingCallsByFingerprint = new Map();

function callFingerprint(toolName, summarizedArgs) {
    try {
        return toolName + ":" + JSON.stringify(summarizedArgs);
    } catch {
        return toolName + ":?";
    }
}

// Drop pending entries whose call event is no longer in `history`. Once an
// event has been ring-buffer-evicted, its id can never be referenced again
// (the page won't have it either), so any pending entry pointing at it is
// stale. Cheap O(N*M) walk where N=buckets and M=avg bucket size, both
// tiny in practice. Called from each pre-hook push.
function prunePendingCalls() {
    if (pendingCallsByFingerprint.size === 0) return;
    const oldestId = history.length ? history[0].id : nextId;
    for (const [fp, bucket] of pendingCallsByFingerprint) {
        let i = 0;
        while (i < bucket.length && bucket[i] < oldestId) i++;
        if (i > 0) bucket.splice(0, i);
        if (bucket.length === 0) pendingCallsByFingerprint.delete(fp);
    }
}

// --- Session info (footer + window title) ---------------------------------
// Snapshot of the bits of session metadata the page cares about. The extension
// SDK doesn't expose `summary` directly on the Session instance — it only gives
// us `sessionId` and `_workspacePath`. The host CLI persists workspace metadata
// (including the AI-generated summary, e.g. "Get Latest Versions") to
// `<workspacePath>/workspace.yaml`. We read that file directly. Polled cheaply
// on every tool call and prompt; pushed to the page only when it changes.
//
// Note: `session` itself is a `const` assigned later via `await joinSession()`.
// Touching it via `typeof` does NOT suppress the temporal dead zone for `let`/
// `const` bindings — it would still throw `ReferenceError`. We use a separate
// `sessionRef` mutable reference set right after joinSession resolves so this
// snapshot can be safely called by an RPC that fires before then.
let sessionRef = null;
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
        // YAML block scalar indicators (`|`, `>`, optionally with chomping
        // `-`/`+` or an explicit indentation digit) put the actual value on
        // subsequent indented lines. A real YAML parse would follow the
        // continuation; for our needs, treating those as "no usable summary"
        // and falling back to the GUID is good enough — the host writes plain
        // scalars in practice and this just guards against a future change.
        if (/^[|>][-+]?\d*$/.test(val)) return null;
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
    if (!sessionRef) return null;
    return {
        sessionId: sessionRef.sessionId,
        summary: readWorkspaceSummary(sessionRef._workspacePath),
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
    // The SDK normally provides resultType ("success" | "failure" | "rejected"
    // | "denied"). If it's missing we don't know what happened — never claim
    // success, since that would silently misreport failures as green.
    return "unknown";
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

dlog("joinSession.start");
const session = await joinSession({
    tools: webview.tools,
    commands: [
        {
            name: "ps-console-view",
            description: "Open the PowerShell console visualizer window.",
            handler: async () => {
                dlog("slash.ps-console-view");
                await webview.show();
            },
        },
    ],
    hooks: {
        onPreToolUse: async (input, invocation) => {
            // Poll on every tool call regardless of which tool — the AI may
            // regenerate the session summary after any turn, not just PS ones.
            pollSessionInfo();
            const isPs = PS_TOOLS.has(input.toolName);
            dlog("hook.preToolUse", {
                toolName: input.toolName,
                isPsTool: isPs,
                hasArgs: !!input.toolArgs,
                argsType: typeof input.toolArgs,
                inputKeys: Object.keys(input || {}),
                invocationType: typeof invocation,
                invocationKeys: invocation ? Object.keys(invocation) : null,
                argsPreview: typeof input.toolArgs === "object"
                    ? JSON.stringify(input.toolArgs).slice(0, 200)
                    : String(input.toolArgs).slice(0, 200),
            });
            if (!isPs) return;
            const args = summarizeArgs(input.toolName, input.toolArgs);
            const ev = pushEvent({
                kind: "call",
                toolName: input.toolName,
                args,
            });
            dlog("hook.preToolUse.pushed", { eventId: ev.id });
            // Track this call for fingerprint-based pairing with its result.
            const fp = callFingerprint(input.toolName, args);
            let bucket = pendingCallsByFingerprint.get(fp);
            if (!bucket) { bucket = []; pendingCallsByFingerprint.set(fp, bucket); }
            bucket.push(ev.id);
            // Drop entries whose call event has aged out of the history ring
            // (their id is below history's oldest id). Bounds memory growth
            // since non-success results never fire postToolUse to clear them.
            prunePendingCalls();
        },
        onPostToolUse: async (input, invocation) => {
            pollSessionInfo();
            const isPs = PS_TOOLS.has(input.toolName);
            dlog("hook.postToolUse", {
                toolName: input.toolName,
                isPsTool: isPs,
                hasResult: !!input.toolResult,
                resultType: input.toolResult?.resultType,
                inputKeys: Object.keys(input || {}),
                invocationType: typeof invocation,
                invocationKeys: invocation ? Object.keys(invocation) : null,
                outputPreview: typeof input.toolResult?.textResultForLlm === "string"
                    ? input.toolResult.textResultForLlm.slice(0, 200)
                    : null,
            });
            if (!isPs) return;
            const args = summarizeArgs(input.toolName, input.toolArgs);
            const fp = callFingerprint(input.toolName, args);
            const bucket = pendingCallsByFingerprint.get(fp);
            let callEventId = bucket && bucket.length ? bucket.shift() : undefined;
            if (bucket && bucket.length === 0) pendingCallsByFingerprint.delete(fp);
            // No matching pre? Synthesize one from the post's args so the UI
            // still shows a coherent call/result pair. This happens when an
            // extensions_reload during a runAgenticLoop kills us mid-loop;
            // the CLI host's hooks snapshot still references the dead old
            // extension, so pre never reaches the new instance. See
            // github.com/pacovidal/copilot-ps-console-view/issues/2.
            let synthetic = false;
            if (callEventId === undefined) {
                synthetic = true;
                const ev = pushEvent({
                    kind: "call",
                    toolName: input.toolName,
                    args,
                    synthetic: true,
                });
                callEventId = ev.id;
                dlog("hook.postToolUse.synthesized", { syntheticCallEventId: ev.id });
            }
            const ev = pushEvent({
                kind: "result",
                toolName: input.toolName,
                forCallId: callEventId,
                status: resultStatus(input.toolResult),
                output: extractResultText(input.toolResult),
            });
            dlog("hook.postToolUse.pushed", { eventId: ev.id, forCallId: callEventId, synthesizedCall: synthetic });
        },
        // Best moment to refresh the title — Copilot often updates the session
        // summary right after a user message arrives.
        userPromptSubmitted: async () => {
            dlog("hook.userPromptSubmitted");
            pollSessionInfo();
        },
        sessionStart: async () => { dlog("hook.sessionStart"); },
        onSessionEnd: () => {
            dlog("hook.onSessionEnd");
            webview.close();
        },
    },
});
dlog("joinSession.resolved", { sessionId: session?.sessionId, sessionKeys: Object.keys(session || {}) });

// Initial snapshot now that `session` exists, so getSessionInfo() returns
// real data the moment the page connects (no need to wait for a tool call).
sessionRef = session;
pollSessionInfo();

// Announce that the extension has finished loading. Doing this after
// joinSession() resolves means the message fires once at extension
// load-time, not on every onSessionStart hook invocation.
try {
    await session.log("copilot-ps-console-view loaded. Use /ps-console-view to open the PowerShell console window.");
} catch {
    // Logging is best-effort; never block extension load.
}
dlog("extension.ready");
