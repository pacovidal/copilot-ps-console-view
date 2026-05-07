// PowerShell console visualizer — page-side logic.
// `window.copilot` is provided by /__bridge.js.

const consoleEl = document.getElementById("console");
const statusEl = document.getElementById("status");
const clearBtn = document.getElementById("clear");
const activeStyleEl = document.getElementById("active-theme");
const sessionInfoEl = document.getElementById("session-info");

const seenIds = new Set();
let lastSeenId = 0;
let empty = true;
let refilling = false;

// Title used when the session has no summary yet (e.g. brand-new session
// before Copilot has named it). Kept in sync with index.html's <title>.
const DEFAULT_TITLE = "Copilot PowerShell Console";

// View options (formerly checkboxes; now toggles in the right-click menu).
const opts = {
    autoscroll: true,
    wrap: false,
    expandNew: false,
    showListPowershell: false,
};
// Apply non-default initial state to the DOM on load.
consoleEl.classList.toggle("wrap", opts.wrap);
consoleEl.classList.toggle("hide-list", !opts.showListPowershell);

// --- Theme machinery -------------------------------------------------------
// A theme is a plain CSS file containing one :root {} rule that defines all
// colour variables (and optionally other properties — themes are full CSS).
// The active theme's CSS is always injected into <style id="active-theme">,
// even for default-dark. The static <link> for default-dark in index.html
// is a first-paint fallback only — it would otherwise prevent users from
// overriding default-dark with their own themes/default-dark.css.
const BUILTIN_ORDER = ["default-dark", "default-light", "solarized-dark", "solarized-light", "campbell", "one-half-dark", "tango-dark"];
let themesCache = null;
let activeThemeName = null;

function parseColor(s) {
    s = s.trim();
    if (s.startsWith("#")) {
        const h = s.slice(1);
        if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
        if (h.length === 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
}

// Sniff a theme's light/dark mode from its --bg value (relative luminance).
// Used to set the native window chrome on next reopen — page CSS is unaffected.
function classifyMode(css) {
    const m = css && css.match(/--bg\s*:\s*([^;]+);/);
    if (!m) return "dark";
    const rgb = parseColor(m[1]);
    if (!rgb) return "dark";
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return lum > 0.5 ? "light" : "dark";
}

async function ensureThemes() {
    if (themesCache) return themesCache;
    return refreshThemes();
}

async function refreshThemes() {
    try { themesCache = await copilot.listThemes(); }
    catch { themesCache = []; }
    return themesCache;
}

function applyTheme(name, css) {
    // Always inject the picked theme's CSS — including built-ins. The static
    // <link rel="stylesheet" href="themes/default-dark.css"> in index.html is
    // a first-paint fallback only; it's NOT authoritative because a user who
    // drops their own themes/default-dark.css must be able to override it.
    activeStyleEl.textContent = css || "";
    activeThemeName = name;
    const mode = classifyMode(css);
    // Persist {name, mode} server-side. localStorage isn't durable here: the
    // webview uses a per-window WEBVIEW2_USER_DATA_FOLDER that's wiped on
    // close, so localStorage evaporates with each window. The extension
    // process owns persistence.
    copilot.setThemeChoice({ name, mode }).catch(() => {});
}

async function initTheme() {
    const themes = await ensureThemes();
    let persistedName = null;
    try { persistedName = await copilot.getInitialTheme(); } catch {}
    let pick = persistedName ? themes.find((t) => t.name === persistedName) : null;
    if (!pick) {
        // First run (or persisted theme has been deleted) — pick a default
        // matching the OS color scheme preference.
        const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
        const wanted = prefersLight ? "default-light" : "default-dark";
        pick = themes.find((t) => t.name === wanted) || themes.find((t) => t.name === "default-dark");
    }
    if (pick) applyTheme(pick.name, pick.css);
}

function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Format a duration in milliseconds as a compact human label.
//   < 1000ms → "Xms"
//   < 60s   → "Xs"
//   ≥ 60s   → "Xm Ys"
function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s}s`;
}

// Per-tool icon glyph + tooltip (the original tool name). Icons are basic
// Unicode geometric/punctuation glyphs that render reliably without depending
// on emoji fonts. Tooltip on hover surfaces the actual tool name so the
// mapping is discoverable.
const TOOL_ICONS = {
    powershell:       { icon: "▶", tip: "powershell" },
    write_powershell: { icon: "✎", tip: "write_powershell" },
    read_powershell:  { icon: "◉", tip: "read_powershell" },
    stop_powershell:  { icon: "⏹", tip: "stop_powershell" },
    list_powershell:  { icon: "☰", tip: "list_powershell" },
};

function el(tag, opts = {}) {
    const e = document.createElement(tag);
    if (opts.cls) e.className = opts.cls;
    if (opts.text != null) e.textContent = opts.text;
    return e;
}

function showEmpty() {
    consoleEl.innerHTML = "";
    const e = el("div", { cls: "empty", text: "Waiting for Copilot to run a PowerShell command…" });
    consoleEl.appendChild(e);
    empty = true;
    // Forget any in-progress upserts since the DOM was wiped.
    entryByCallId.clear();
    sessions.clear();
    stopDurationTicker();
}

function clearEmpty() {
    if (empty) {
        consoleEl.innerHTML = "";
        empty = false;
    }
}

// --- Sessions (Tier 3) -----------------------------------------------------
//
// An async powershell session (`powershell` call with `mode === "async"`)
// becomes a persistent entry whose Output area is a running TRANSCRIPT of
// every related interaction (initial start, write, read, stop). The
// originating `powershell --mode=async` call seeds a session keyed by
// `shellId`. Subsequent `write_powershell` / `read_powershell` /
// `stop_powershell` events with the same shellId update that session
// instead of producing top-level entries.
//
// Sync `powershell` calls are unchanged (paired entry).
// `list_powershell` renders as a small one-liner (toggleable).
// Continuations whose shellId we never observed render as compact orphan
// continuation entries.
const sessions = new Map(); // shellId -> sessionState
const MAX_TRANSCRIPT_LINES = 200;
const MAX_SESSIONS = 50;

// Drop the oldest stopped/terminal sessions and detach their DOM when we
// exceed MAX_SESSIONS. Active and pending sessions are never evicted.
function evictOldSessions() {
    if (sessions.size <= MAX_SESSIONS) return;
    const TERMINAL = new Set(["stopped", "failure", "denied", "rejected", "unknown"]);
    // Map iteration order is insertion order, so the oldest entries come first.
    for (const [shellId, sess] of sessions) {
        if (sessions.size <= MAX_SESSIONS) break;
        if (!TERMINAL.has(sess.status)) continue;
        if (sess.entryDOM && sess.entryDOM.parentNode) {
            sess.entryDOM.parentNode.removeChild(sess.entryDOM);
        }
        sessions.delete(shellId);
    }
}

let durationTicker = null;
function ensureDurationTicker() {
    if (durationTicker) return;
    durationTicker = setInterval(() => {
        let anyActive = false;
        for (const sess of sessions.values()) {
            if (sess.status !== "active") continue;
            anyActive = true;
            if (sess.durEl) sess.durEl.textContent = fmtDuration(Date.now() - sess.startTime);
        }
        if (!anyActive) {
            clearInterval(durationTicker);
            durationTicker = null;
        }
    }, 1000);
}
function stopDurationTicker() {
    if (durationTicker) { clearInterval(durationTicker); durationTicker = null; }
}

// Best-effort: extract shellId from a powershell --mode=async result's output
// when the agent didn't pass one explicitly. The CLI's output for an async
// start typically includes "shellId: <id>" on its own line.
function parseShellIdFromOutput(output) {
    if (typeof output !== "string") return null;
    const m = output.match(/shell\s*[Ii]d:?\s*([\w.-]+)/);
    return m ? m[1] : null;
}

function isAsyncStart(ev) {
    return ev && ev.kind === "call"
        && ev.toolName === "powershell"
        && (ev.args?.mode === "async" || ev.args?.detach === true);
}

function statusFromResult(ev) {
    return ev?.status || "success";
}

// Append one interaction sub-block to a session's transcript. Returns the
// DOM node so the caller can update it later (e.g. fill in a read's output
// when the result arrives, or set status on stop completion).
function appendInteraction(sess, kind, ev, extra = {}) {
    if (!sess.transcriptEl) return null;

    const block = el("div", { cls: `interaction interaction-${kind}` });
    const headLine = el("div", { cls: "interaction-head" });
    const markerInfo = INTERACTION_MARKERS[kind] || { icon: "•", label: kind };
    const marker = el("span", { cls: "interaction-marker", text: markerInfo.icon });
    headLine.appendChild(marker);
    headLine.appendChild(el("span", { cls: "interaction-label", text: markerInfo.label }));
    headLine.appendChild(el("span", { cls: "interaction-ts", text: fmtTime(ev.timestamp) }));
    const meta = metaTooltipFor(ev);
    if (meta) headLine.title = meta;
    if (extra.metaText) headLine.appendChild(el("span", { cls: "interaction-meta", text: extra.metaText }));
    block.appendChild(headLine);

    // Body (optional). Caller can pass `bodyText` for the initial display
    // and later mutate `block._bodyEl.textContent`.
    if (extra.bodyText != null || extra.placeholder) {
        const body = el("div", { cls: "interaction-body" });
        if (extra.bodyText != null) body.textContent = extra.bodyText;
        else { body.classList.add("interaction-pending"); body.textContent = extra.placeholder; }
        block.appendChild(body);
        block._bodyEl = body;
    }

    sess.transcriptEl.appendChild(block);
    sess.transcriptCount++;
    if (kind === "start" && !sess.startBlock) sess.startBlock = block;

    // Trim old interactions if we've exceeded the cap. Pin the truncation
    // marker AND the start block at the top so the user always sees how the
    // session began.
    if (sess.transcriptCount > MAX_TRANSCRIPT_LINES) {
        if (!sess.truncationMarker) {
            sess.truncationMarker = el("div", { cls: "interaction truncated", text: "… earlier interactions truncated …" });
            // Insert the marker AFTER the start block so the layout reads:
            // [Started …] / [… truncated …] / [oldest surviving interaction] …
            const after = sess.startBlock ? sess.startBlock.nextSibling : sess.transcriptEl.firstChild;
            sess.transcriptEl.insertBefore(sess.truncationMarker, after);
        }
        const kids = sess.transcriptEl.children;
        for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (child === sess.truncationMarker) continue;
            if (child === sess.startBlock) continue;
            sess.transcriptEl.removeChild(child);
            sess.transcriptCount--;
            break;
        }
    }
    return block;
}

const INTERACTION_MARKERS = {
    start: { icon: "▶", label: "Started" },
    write: { icon: "→", label: "Sent" },
    read:  { icon: "◉", label: "Read" },
    stop:  { icon: "⏹", label: "Stopped" },
};

// Status tags a session can take. Listed exhaustively so we can clear them
// all when transitioning between any two — failure-then-stop, etc.
const SESSION_STATUSES = [
    "pending", "active", "stopped",
    "failure", "denied", "rejected", "unknown",
];
// Statuses that end a session's lifetime — duration is frozen on entry.
const TERMINAL_STATUSES = new Set([
    "stopped", "failure", "denied", "rejected", "unknown",
]);

function setSessionStatus(sess, status, atTime) {
    if (!sess.entryDOM) return;
    for (const s of SESSION_STATUSES) sess.entryDOM.classList.remove(`status-${s}`);
    sess.entryDOM.classList.remove("pending");
    sess.entryDOM.classList.add(`status-${status}`);
    if (status === "pending") sess.entryDOM.classList.add("pending");
    if (sess.statusTagEl) sess.statusTagEl.textContent = status;
    sess.status = status;
    if (status === "active") ensureDurationTicker();
    if (TERMINAL_STATUSES.has(status) && sess.durEl && sess.endTime == null) {
        // Freeze the live duration on first transition into a terminal state.
        // For history replay, `atTime` is the event's timestamp so duration =
        // event - start (not now - start). Subsequent terminal transitions
        // (e.g. failed-start later stopped) keep the original end time.
        const endTime = atTime != null ? atTime : Date.now();
        sess.endTime = endTime;
        sess.durEl.textContent = fmtDuration(endTime - sess.startTime);
    }
}

function renderSessionEntry(sess) {
    const wrap = el("div", { cls: "entry session pending status-pending" });
    wrap.dataset.shellId = sess.shellId;
    sess.entryDOM = wrap;

    const header = el("div", { cls: "header-line" });
    header.appendChild(el("span", { cls: "chevron", text: "▸" }));
    const iconInfo = TOOL_ICONS["powershell"];
    const iconEl = el("span", { cls: "tool-icon", text: iconInfo.icon });
    iconEl.title = "powershell --mode=async (session)";
    header.appendChild(iconEl);

    const statusTag = el("span", { cls: "status-tag", text: "pending" });
    header.appendChild(statusTag);
    sess.statusTagEl = statusTag;

    if (sess.description) {
        header.appendChild(el("span", { cls: "desc", text: sess.description }));
    } else if (sess.initialCommand) {
        // Use the first non-empty line of the command as a fallback label.
        const firstLine = sess.initialCommand.split("\n").map(s => s.trim()).find(Boolean) || "(session)";
        header.appendChild(el("span", { cls: "desc", text: firstLine.slice(0, 80) }));
    }

    const shellChip = el("span", { cls: "shell-chip", text: `shell=${sess.shellId}` });
    header.appendChild(shellChip);

    header.appendChild(el("span", { cls: "ts", text: fmtTime(sess.startTime) }));
    const dur = el("span", { cls: "dur", text: "" });
    header.appendChild(dur);
    sess.durEl = dur;

    header.addEventListener("click", () => wrap.classList.toggle("collapsed"));
    wrap.appendChild(header);

    const transcriptSec = el("div", { cls: "section transcript-section" });
    transcriptSec.appendChild(el("div", { cls: "section-label", text: "Transcript" }));
    const transcriptEl = el("div", { cls: "transcript" });
    transcriptSec.appendChild(transcriptEl);
    wrap.appendChild(transcriptSec);
    sess.transcriptEl = transcriptEl;

    return wrap;
}

// Render a `list_powershell` event as a compact one-liner. The toggle
// `opts.showListPowershell` controls visibility (off ⇒ entry has display:none
// via the `.hide-list` body class; on ⇒ visible).
function renderListEntry(callEv, resultEv) {
    const wrap = el("div", { cls: "entry list-powershell" });
    wrap.dataset.callId = String(callEv.id);

    const header = el("div", { cls: "header-line" });
    const iconEl = el("span", { cls: "tool-icon", text: TOOL_ICONS.list_powershell.icon });
    iconEl.title = "list_powershell";
    header.appendChild(iconEl);

    // Try to extract the active session count from the result text. If we
    // don't have a result yet, leave it as a plain "Listed sessions" label.
    let label = "Listed sessions";
    if (resultEv && typeof resultEv.output === "string") {
        const lines = resultEv.output.split("\n").filter(Boolean);
        if (/^\s*<no active shell sessions>/i.test(resultEv.output)) {
            label = "Listed 0 active session(s)";
        } else {
            const activeCount = lines.filter((l) => /shellId\s*:/i.test(l)).length;
            label = `Listed ${activeCount} active session(s)`;
        }
    }
    header.appendChild(el("span", { cls: "desc", text: label }));
    header.appendChild(el("span", { cls: "ts", text: fmtTime((resultEv || callEv).timestamp) }));

    wrap.appendChild(header);
    return wrap;
}

// Render a continuation event (write/read/stop) whose session start is
// unknown. This is a small one-liner with a [shell=foo missing] chip.
function renderOrphanContinuation(ev) {
    const wrap = el("div", { cls: "entry orphan-continuation" });
    const header = el("div", { cls: "header-line" });
    const iconInfo = TOOL_ICONS[ev.toolName] || { icon: "•", tip: ev.toolName };
    const iconEl = el("span", { cls: "tool-icon", text: iconInfo.icon });
    iconEl.title = iconInfo.tip;
    header.appendChild(iconEl);
    const shellId = ev.args?.shellId || "?";
    header.appendChild(el("span", { cls: "shell-chip missing", text: `shell=${shellId} missing` }));
    header.appendChild(el("span", { cls: "ts", text: fmtTime(ev.timestamp) }));
    wrap.appendChild(header);
    return wrap;
}

// --- Paired entry rendering -----------------------------------------------
//
// Each call/result PAIR renders as a single DOM entry. The call event
// creates a "Pending" entry with empty Output; the matching result event
// (matched by `forCallId`) upserts the existing entry — flipping the status,
// filling in duration + output. Synthesized pairs (extension reload mid-loop;
// see issue #2) push call+result back-to-back so the entry visually appears
// already-resolved with no perceptible pending state.
//
// `entryByCallId` maps call event id → an upsert handler that knows what
// the result event should do (e.g. update a paired entry, complete a
// session start, fill in a read interaction, finalize a session stop).
const entryByCallId = new Map();

function inputBodyFor(ev) {
    const a = ev.args || {};
    if (ev.toolName === "powershell") return a.command ?? "";
    if (ev.toolName === "write_powershell") return a.input ?? "";
    if (ev.toolName === "read_powershell") return "(read buffered output)";
    if (ev.toolName === "stop_powershell") return "(stop session)";
    if (ev.toolName === "list_powershell") return "(list sessions)";
    return JSON.stringify(a, null, 2);
}

function metaTooltipFor(ev) {
    const a = ev.args || {};
    const meta = [];
    if (a.shellId) meta.push(`shell=${a.shellId}`);
    if (a.mode) meta.push(`mode=${a.mode}`);
    if (a.detach) meta.push("detached");
    if (a.initial_wait != null) meta.push(`wait=${a.initial_wait}s`);
    if (a.delay != null) meta.push(`delay=${a.delay}s`);
    return meta.length ? meta.join("  ·  ") : "";
}

// Renders the skeleton entry for a `call` event. Status starts as "pending";
// a later `upsertResult` call flips it.
function renderPair(ev) {
    const wrap = el("div", { cls: "entry pair pending" });
    if (ev.synthetic) wrap.classList.add("synthetic");
    wrap.dataset.callId = String(ev.id);

    const header = el("div", { cls: "header-line" });
    const chevron = el("span", { cls: "chevron", text: "▸" });
    header.appendChild(chevron);

    // Tool icon (clickable target shares the chevron's role; the icon's title
    // attribute lets users discover the underlying tool name).
    const iconInfo = TOOL_ICONS[ev.toolName] || { icon: "•", tip: ev.toolName };
    const iconEl = el("span", { cls: "tool-icon", text: iconInfo.icon });
    iconEl.title = iconInfo.tip;
    header.appendChild(iconEl);

    if (ev.synthetic) {
        const tag = el("span", { cls: "synthetic-tag", text: "◇" });
        tag.title = "Reconstructed: pre-hook was lost (likely an extension reload during the agent's tool-execution loop). The command did run; only the live 'running' state was missed.";
        header.appendChild(tag);
    }

    const statusTag = el("span", { cls: "status-tag", text: "pending" });
    header.appendChild(statusTag);

    if (ev.args?.description) {
        header.appendChild(el("span", { cls: "desc", text: ev.args.description }));
    }

    const ts = el("span", { cls: "ts", text: fmtTime(ev.timestamp) });
    header.appendChild(ts);

    const dur = el("span", { cls: "dur", text: "" });
    header.appendChild(dur);

    const metaTip = metaTooltipFor(ev);
    if (metaTip) header.title = metaTip;
    header.addEventListener("click", () => {
        wrap.classList.toggle("collapsed");
    });
    wrap.appendChild(header);

    // Body: two sections (Input / Output) stacked. Both shown when expanded;
    // hidden together when the entry is collapsed (existing rule).
    const inputSec = el("div", { cls: "section input-section" });
    inputSec.appendChild(el("div", { cls: "section-label", text: "Input" }));
    const inputBody = el("div", { cls: "section-body input-body" });
    const prompt = el("span", { cls: "prompt", text: "PS> " });
    inputBody.appendChild(prompt);
    inputBody.appendChild(document.createTextNode(inputBodyFor(ev)));
    inputSec.appendChild(inputBody);
    wrap.appendChild(inputSec);

    const outputSec = el("div", { cls: "section output-section" });
    outputSec.appendChild(el("div", { cls: "section-label", text: "Output" }));
    const outputBody = el("div", { cls: "section-body output-body output-pending", text: "waiting for result…" });
    outputSec.appendChild(outputBody);
    wrap.appendChild(outputSec);

    // Cache fields the upsert needs without re-querying the DOM.
    wrap._statusTag = statusTag;
    wrap._dur = dur;
    wrap._outputBody = outputBody;
    wrap._callTs = ev.timestamp;

    return wrap;
}

// Receives a `result` event and updates the existing pair entry (matched by
// `forCallId`). If the matching entry isn't found (e.g. Clear was clicked
// between the call and the result, or this page is replaying history that
// was partially evicted), we render the result as its own minimal entry.
function upsertResult(ev) {
    const callId = ev.forCallId;
    const wrap = callId != null ? entryByCallId.get(callId) : null;

    if (wrap) {
        const status = ev.status || "success";
        wrap.classList.remove("pending");
        wrap.classList.add(`status-${status}`);
        wrap._statusTag.textContent = status;
        wrap._dur.textContent = fmtDuration(ev.timestamp - wrap._callTs);
        const outputBody = wrap._outputBody;
        outputBody.classList.remove("output-pending");
        outputBody.textContent = ev.output || "(no output)";
        if (callId != null) entryByCallId.delete(callId);
        return wrap;
    }

    // Standalone result with no matching call — should be rare given the
    // synthesis-on-orphan path in main.mjs always creates a call first, but
    // defensively render a minimal single-section entry so nothing goes
    // missing.
    const status = ev.status || "success";
    const orphan = el("div", { cls: `entry pair status-${status} orphan-result` });
    const header = el("div", { cls: "header-line" });
    header.appendChild(el("span", { cls: "chevron", text: "▸" }));
    const iconInfo = TOOL_ICONS[ev.toolName] || { icon: "•", tip: ev.toolName };
    const iconEl = el("span", { cls: "tool-icon", text: iconInfo.icon });
    iconEl.title = iconInfo.tip;
    header.appendChild(iconEl);
    header.appendChild(el("span", { cls: "status-tag", text: status }));
    header.appendChild(el("span", { cls: "ts", text: fmtTime(ev.timestamp) }));
    header.addEventListener("click", () => orphan.classList.toggle("collapsed"));
    orphan.appendChild(header);
    const outputSec = el("div", { cls: "section output-section" });
    outputSec.appendChild(el("div", { cls: "section-label", text: "Output" }));
    outputSec.appendChild(el("div", { cls: "section-body output-body", text: ev.output || "(no output)" }));
    orphan.appendChild(outputSec);
    return orphan;
}

function appendOne(ev) {
    if (!ev || seenIds.has(ev.id)) return;
    seenIds.add(ev.id);
    if (ev.id > lastSeenId) lastSeenId = ev.id;

    if (ev.kind === "call") return handleCall(ev);
    if (ev.kind === "result") return handleResult(ev);
}

// --- Event router ----------------------------------------------------------
// Classifies each `call` event into one of:
//   - session-birth (powershell --mode=async): creates a session entry;
//     registers an upsert that will fill in the start interaction's output
//     and flip the session to ACTIVE when the result arrives.
//   - session-continuation (write/read/stop with known shellId): appends a
//     pending interaction to the existing session's transcript; registers
//     an upsert that completes that interaction when the result arrives.
//   - orphan-continuation (write/read/stop with unknown shellId): renders a
//     compact one-liner.
//   - list-powershell: renders a compact one-liner. If toggle is OFF, the
//     entry is hidden via a body class (it still exists in DOM so re-toggling
//     is instant).
//   - regular pair (default): the existing renderPair / upsertResult flow.
function handleCall(ev) {
    if (ev.toolName === "list_powershell") {
        clearEmpty();
        const node = renderListEntry(ev, null);
        consoleEl.appendChild(node);
        if (opts.autoscroll && opts.showListPowershell !== false) consoleEl.scrollTop = consoleEl.scrollHeight;
        // Result handler: replace label with one carrying the parsed count.
        entryByCallId.set(ev.id, (resultEv) => {
            const repl = renderListEntry(ev, resultEv);
            node.replaceWith(repl);
        });
        return;
    }

    if (isAsyncStart(ev)) {
        let shellId = ev.args?.shellId || null;
        // If shellId wasn't declared by the agent at call time, defer the
        // session creation until the result arrives (we'll parse it from
        // the output text).
        if (!shellId) {
            entryByCallId.set(ev.id, (resultEv) => {
                const inferred = parseShellIdFromOutput(resultEv.output);
                if (!inferred) {
                    // Couldn't recover a shellId — fall back to rendering as a
                    // regular paired entry so the call doesn't disappear.
                    clearEmpty();
                    const fallback = renderPair(ev);
                    if (!opts.expandNew) fallback.classList.add("collapsed");
                    consoleEl.appendChild(fallback);
                    upsertResultInDOM(fallback, resultEv);
                    return;
                }
                createSessionFromStart(ev, resultEv, inferred);
            });
            return;
        }
        // shellId known at call time → create session now and let the result
        // handler complete it.
        clearEmpty();
        const sess = ensureFreshSession(shellId, ev);
        const startBlock = appendInteraction(sess, "start", ev, {
            bodyText: ev.args?.command ?? "",
            placeholder: undefined,
        });
        if (!opts.expandNew) sess.entryDOM.classList.add("collapsed");
        consoleEl.appendChild(sess.entryDOM);
        if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
        entryByCallId.set(ev.id, (resultEv) => completeSessionStart(sess, startBlock, resultEv));
        return;
    }

    // Continuations: write/read/stop with shellId
    if (ev.toolName === "write_powershell" || ev.toolName === "read_powershell" || ev.toolName === "stop_powershell") {
        const shellId = ev.args?.shellId;
        const sess = shellId ? sessions.get(shellId) : null;
        if (!sess || TERMINAL_STATUSES.has(sess.status)) {
            // Orphan continuation (no known live session for this shellId).
            clearEmpty();
            const node = renderOrphanContinuation(ev);
            consoleEl.appendChild(node);
            if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
            // Defensive: a result may still arrive; ignore it (no upsert needed
            // for the orphan one-liner).
            return;
        }
        const interactionKind = ev.toolName.replace(/_powershell$/, "");
        const interactionBlock = handleSessionContinuationCall(sess, interactionKind, ev);
        if (interactionBlock) {
            entryByCallId.set(ev.id, (resultEv) => completeContinuation(sess, interactionKind, interactionBlock, resultEv));
        }
        return;
    }

    // Default: regular paired entry.
    clearEmpty();
    const node = renderPair(ev);
    if (!opts.expandNew) node.classList.add("collapsed");
    consoleEl.appendChild(node);
    if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
    entryByCallId.set(ev.id, (resultEv) => upsertResultInDOM(node, resultEv));
}

function handleResult(ev) {
    const callId = ev.forCallId;
    const handler = callId != null ? entryByCallId.get(callId) : null;
    if (handler) {
        try { handler(ev); } catch (e) { /* best-effort */ }
        entryByCallId.delete(callId);
        return;
    }
    // No matching call — fall back to a minimal orphan-result entry so the
    // result doesn't disappear silently.
    clearEmpty();
    const node = upsertResult(ev);
    if (!opts.expandNew) node.classList.add("collapsed");
    consoleEl.appendChild(node);
    if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function ensureFreshSession(shellId, ev) {
    const existing = sessions.get(shellId);
    // If a previous session with this shellId is still alive, keep it (rare —
    // would mean the agent re-issued an async start without stopping first).
    if (existing && !TERMINAL_STATUSES.has(existing.status)) return existing;
    // Re-use of a stopped/terminal shellId → create a fresh session, leave the
    // old entry in the timeline as historical. Re-keying on a Map preserves
    // insertion order for eviction, so re-insert.
    if (existing) sessions.delete(shellId);
    const sess = {
        shellId,
        startEventId: ev.id,
        startTime: ev.timestamp,
        endTime: null,
        status: "pending",
        initialCommand: ev.args?.command ?? "",
        description: ev.args?.description ?? "",
        transcriptCount: 0,
        truncationMarker: null,
        startBlock: null,
        transcriptEl: null,
        statusTagEl: null,
        durEl: null,
        entryDOM: null,
    };
    sessions.set(shellId, sess);
    sess.entryDOM = renderSessionEntry(sess);
    evictOldSessions();
    return sess;
}

function createSessionFromStart(callEv, resultEv, shellId) {
    clearEmpty();
    const sess = ensureFreshSession(shellId, callEv);
    const startBlock = appendInteraction(sess, "start", callEv, {
        bodyText: callEv.args?.command ?? "",
    });
    if (!opts.expandNew) sess.entryDOM.classList.add("collapsed");
    consoleEl.appendChild(sess.entryDOM);
    if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
    completeSessionStart(sess, startBlock, resultEv);
}

function completeSessionStart(sess, startBlock, resultEv) {
    const status = statusFromResult(resultEv);
    if (status === "success") {
        setSessionStatus(sess, "active");
    } else {
        setSessionStatus(sess, status, resultEv?.timestamp);
    }
    if (startBlock && resultEv?.output != null) {
        // Append output to the start block as a sub-body.
        const body = el("div", { cls: "interaction-body interaction-output" });
        body.textContent = resultEv.output;
        startBlock.appendChild(body);
        startBlock._outputEl = body;
    }
}

function handleSessionContinuationCall(sess, kind, ev) {
    if (kind === "write") {
        const block = appendInteraction(sess, "write", ev, {
            bodyText: ev.args?.input ?? "",
            metaText: ev.args?.delay != null ? `delay=${ev.args.delay}s` : null,
        });
        if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
        return block;
    }
    if (kind === "read") {
        const block = appendInteraction(sess, "read", ev, {
            placeholder: "(reading…)",
            metaText: ev.args?.delay != null ? `delay=${ev.args.delay}s` : null,
        });
        if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
        return block;
    }
    if (kind === "stop") {
        const block = appendInteraction(sess, "stop", ev, { placeholder: "(stopping…)" });
        if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
        return block;
    }
    return null;
}

function completeContinuation(sess, kind, block, resultEv) {
    if (!block) return;
    if (kind === "write") {
        // Write results are usually empty / housekeeping. We may attach a
        // small note if the tool returned text, but otherwise leave the
        // already-shown input in place.
        if (resultEv?.output && resultEv.output.trim()) {
            const out = el("div", { cls: "interaction-body interaction-output" });
            out.textContent = resultEv.output;
            block.appendChild(out);
        }
        return;
    }
    if (kind === "read") {
        if (block._bodyEl) {
            block._bodyEl.classList.remove("interaction-pending");
            block._bodyEl.textContent = resultEv.output || "(no output)";
        }
        return;
    }
    if (kind === "stop") {
        if (block._bodyEl) {
            block._bodyEl.classList.remove("interaction-pending");
            // Stop usually just yields a confirmation; show text if present,
            // otherwise hide the placeholder body entirely.
            if (resultEv?.output && resultEv.output.trim()) {
                block._bodyEl.textContent = resultEv.output;
            } else {
                block._bodyEl.remove();
                block._bodyEl = null;
            }
        }
        setSessionStatus(sess, "stopped", resultEv.timestamp);
        return;
    }
}

// In-place result upsert against an existing pair entry (used both for the
// regular paired flow's call→result transition AND for the deferred fallback
// when an async-start can't be classified as a session).
function upsertResultInDOM(wrap, ev) {
    const status = ev.status || "success";
    wrap.classList.remove("pending");
    wrap.classList.add(`status-${status}`);
    if (wrap._statusTag) wrap._statusTag.textContent = status;
    if (wrap._dur) wrap._dur.textContent = fmtDuration(ev.timestamp - wrap._callTs);
    if (wrap._outputBody) {
        wrap._outputBody.classList.remove("output-pending");
        wrap._outputBody.textContent = ev.output || "(no output)";
    }
}

async function refillFromHistory() {
    if (refilling) return;
    refilling = true;
    try {
        const hist = await copilot.getHistory();
        if (Array.isArray(hist)) {
            for (const e of hist) appendOne(e);
        }
    } catch {} finally {
        refilling = false;
    }
}

function append(ev) {
    if (!ev || seenIds.has(ev.id)) return;
    // If we appear to have missed earlier events, pull history first so the
    // page reflects the true order (call → result) instead of just the tail.
    if (ev.id > lastSeenId + 1) {
        refillFromHistory().then(() => appendOne(ev));
        return;
    }
    appendOne(ev);
}

window.psConsole = { append, setSessionInfo };

// --- Session info ----------------------------------------------------------
// Footer left side: "Session: 'Get Latest Versions'" (full GUID on hover).
// Window title:     "Get Latest Versions — Copilot PowerShell Console".
// Both updated whenever the extension polls and detects a summary change.
function setSessionInfo(info) {
    const summary = (info && typeof info.summary === "string" && info.summary) || null;
    const sessionId = (info && typeof info.sessionId === "string" && info.sessionId) || null;

    // Footer text — show the summary in quotes when present; otherwise show
    // the GUID itself so the session is still identifiable. Tooltip always
    // exposes the full GUID for unambiguous reference.
    let footerText;
    if (summary) {
        footerText = `Session: '${summary}'`;
    } else if (sessionId) {
        footerText = `Session: ${sessionId}`;
    } else {
        footerText = "";
    }
    sessionInfoEl.textContent = footerText;
    if (sessionId) {
        sessionInfoEl.title = sessionId;
    } else {
        sessionInfoEl.removeAttribute("title");
    }

    // Window title — WebView2/wry doesn't reflect document.title to the native
    // OS title bar automatically, so we also set it (best-effort, ignored if
    // ipc isn't bridged) via the IPC channel handled in lib/webview-child.mjs.
    const docTitle = summary ? `${summary} — ${DEFAULT_TITLE}` : DEFAULT_TITLE;
    document.title = docTitle;
    try {
        if (window.ipc && typeof window.ipc.postMessage === "function") {
            window.ipc.postMessage(JSON.stringify({ type: "setTitle", value: docTitle }));
        }
    } catch {}
}

async function loadSessionInfo() {
    try {
        const info = await copilot.getSessionInfo();
        if (info) setSessionInfo(info);
    } catch {
        // Best-effort; older extension versions may not expose this RPC.
    }
}

// Right-click context menu. Three groups separated by dividers:
//   1. Per-entry actions (collapse all / expand all)
//   2. Sticky toggles (auto-scroll, wrap, expand-new), formerly header checkboxes.
//   3. Theme submenu (built-in + user themes; user themes override builtins of
//      the same name). Lives in a sibling div positioned next to the trigger.
const contextMenu = document.createElement("div");
contextMenu.id = "context-menu";
contextMenu.hidden = true;
document.body.appendChild(contextMenu);

const themeSubmenu = document.createElement("div");
themeSubmenu.id = "theme-submenu";
themeSubmenu.classList.add("submenu");
themeSubmenu.hidden = true;
document.body.appendChild(themeSubmenu);

const TOGGLES = [
    { key: "autoscroll", label: "Auto-scroll", apply: () => {} },
    { key: "wrap",       label: "Wrap",        apply: () => consoleEl.classList.toggle("wrap", opts.wrap) },
    { key: "expandNew",  label: "Expand new entries", apply: () => {} },
    { key: "showListPowershell", label: "Show list_powershell entries", apply: () => consoleEl.classList.toggle("hide-list", !opts.showListPowershell) },
];

function renderContextMenu() {
    contextMenu.innerHTML = "";
    const add = (action, label, opts2 = {}) => {
        const btn = document.createElement("button");
        btn.dataset.action = action;
        if (opts2.html) {
            btn.innerHTML = (opts2.checked ? "✓ " : "  ") + label;
        } else {
            btn.textContent = (opts2.checked ? "✓ " : "  ") + label;
        }
        contextMenu.appendChild(btn);
    };
    add("collapse-all", "Collapse all");
    add("expand-all",   "Expand all");
    const sep = document.createElement("div");
    sep.className = "separator";
    contextMenu.appendChild(sep);
    for (const t of TOGGLES) {
        add(`toggle:${t.key}`, t.label, { checked: opts[t.key] });
    }
    const sep2 = document.createElement("div");
    sep2.className = "separator";
    contextMenu.appendChild(sep2);
    add("theme", `Theme<span class="submenu-arrow">▸</span>`, { html: true });
}

function renderThemeSubmenu(themes) {
    themeSubmenu.innerHTML = "";
    const builtinIndex = (name) => {
        const i = BUILTIN_ORDER.indexOf(name);
        return i === -1 ? 1e9 : i;
    };
    const builtins = themes
        .filter((t) => t.source === "builtin")
        .sort((a, b) => builtinIndex(a.name) - builtinIndex(b.name) || a.name.localeCompare(b.name));
    const userThemes = themes
        .filter((t) => t.source === "user")
        .sort((a, b) => a.name.localeCompare(b.name));

    const add = (theme) => {
        const btn = document.createElement("button");
        btn.dataset.theme = theme.name;
        const checked = theme.name === activeThemeName;
        btn.textContent = (checked ? "✓ " : "  ") + theme.name;
        themeSubmenu.appendChild(btn);
    };
    for (const t of builtins) add(t);
    if (userThemes.length) {
        const sep = document.createElement("div");
        sep.className = "separator";
        themeSubmenu.appendChild(sep);
        for (const t of userThemes) add(t);
    }
    if (!builtins.length && !userThemes.length) {
        const empty = document.createElement("div");
        empty.className = "separator";
        themeSubmenu.appendChild(empty);
        const note = document.createElement("button");
        note.disabled = true;
        note.textContent = "  (no themes found)";
        themeSubmenu.appendChild(note);
    }
}

function showThemeSubmenu(anchorRect) {
    themeSubmenu.hidden = false;
    const { innerWidth: w, innerHeight: h } = window;
    let left = anchorRect.right;
    let top = anchorRect.top;
    if (left + themeSubmenu.offsetWidth > w - 4) left = anchorRect.left - themeSubmenu.offsetWidth;
    if (top + themeSubmenu.offsetHeight > h - 4) top = h - themeSubmenu.offsetHeight - 4;
    if (top < 4) top = 4;
    themeSubmenu.style.left = `${Math.max(0, left)}px`;
    themeSubmenu.style.top = `${top}px`;
}

function setAllCollapsed(collapsed) {
    for (const entry of consoleEl.querySelectorAll(".entry")) {
        entry.classList.toggle("collapsed", collapsed);
    }
}

function hideContextMenu() {
    contextMenu.hidden = true;
    themeSubmenu.hidden = true;
}
function hideThemeSubmenu() { themeSubmenu.hidden = true; }

consoleEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    renderContextMenu();
    contextMenu.hidden = false;
    hideThemeSubmenu();
    // Position; clamp inside the viewport.
    const { innerWidth: w, innerHeight: h } = window;
    const { offsetWidth: mw, offsetHeight: mh } = contextMenu;
    contextMenu.style.left = `${Math.min(e.clientX, w - mw - 4)}px`;
    contextMenu.style.top = `${Math.min(e.clientY, h - mh - 4)}px`;
});

contextMenu.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button");
    const action = btn?.dataset?.action;
    if (!action) return;
    if (action === "collapse-all") setAllCollapsed(true);
    else if (action === "expand-all") setAllCollapsed(false);
    else if (action === "theme") {
        // Toggle the theme submenu without dismissing the parent menu. Always
        // re-fetch so newly-dropped user theme files appear immediately.
        if (themeSubmenu.hidden) {
            const themes = await refreshThemes();
            renderThemeSubmenu(themes);
            showThemeSubmenu(btn.getBoundingClientRect());
        } else {
            hideThemeSubmenu();
        }
        return;
    }
    else if (action.startsWith("toggle:")) {
        const key = action.slice("toggle:".length);
        const t = TOGGLES.find((x) => x.key === key);
        if (t) {
            opts[key] = !opts[key];
            t.apply();
        }
    }
    hideContextMenu();
});

themeSubmenu.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    const name = btn?.dataset?.theme;
    if (!name) return;
    const t = themesCache?.find((x) => x.name === name);
    if (t) applyTheme(t.name, t.css);
    hideContextMenu();
});

window.addEventListener("click", (e) => {
    if (contextMenu.contains(e.target) || themeSubmenu.contains(e.target)) return;
    hideContextMenu();
});
window.addEventListener("scroll", hideContextMenu, true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });

clearBtn.addEventListener("click", async () => {
    seenIds.clear();
    lastSeenId = 0;
    showEmpty();
    try {
        await copilot.clearHistory();
    } catch {}
});

async function loadHistory() {
    try {
        const hist = await copilot.getHistory();
        if (Array.isArray(hist) && hist.length) {
            for (const ev of hist) appendOne(ev);
            statusEl.textContent = `connected · ${hist.length} event(s) replayed`;
        } else {
            showEmpty();
            statusEl.textContent = "connected · idle";
        }
    } catch (e) {
        statusEl.textContent = `connection error: ${e?.message ?? e}`;
        showEmpty();
    }
}

showEmpty();
loadHistory();
loadSessionInfo();
initTheme();
