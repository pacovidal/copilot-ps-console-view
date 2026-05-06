// PowerShell console visualizer extension.
// Captures all PowerShell-related tool calls invoked by Copilot and streams
// them, with their results, into a console-like webview window.
import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { CopilotWebview } from "./lib/copilot-webview.js";

const PS_TOOLS = new Set([
    "powershell",
    "write_powershell",
    "read_powershell",
    "stop_powershell",
    "list_powershell",
]);

// In-memory ring buffer of recent events so the page can replay history when
// it (re)connects, and so events that arrive before the window opens are not
// lost. Each event is a JSON-serializable object.
const MAX_HISTORY = 500;
const history = [];
let nextId = 1;
// Map toolCallId -> event id, so post events can reference their pre event.
const callIdToEventId = new Map();

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
    callbacks: {
        // Page asks for the full backlog when it (re)connects.
        getHistory: () => history,
        // Optional: page can ask the extension to forget history.
        clearHistory: () => {
            history.length = 0;
            return true;
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
        onSessionEnd: webview.close,
    },
});

// Announce that the extension has finished loading. Doing this after
// joinSession() resolves means the message fires once at extension
// load-time, not on every onSessionStart hook invocation.
try {
    await session.log("copilot-ps-console-view loaded. Use /ps-console-view to open the PowerShell console window.");
} catch {
    // Logging is best-effort; never block extension load.
}
