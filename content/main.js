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
};
// Apply non-default initial state to the DOM on load.
consoleEl.classList.toggle("wrap", opts.wrap);

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
}

function clearEmpty() {
    if (empty) {
        consoleEl.innerHTML = "";
        empty = false;
    }
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
// `entryByCallId` maps call event id → the entry's DOM node, so a result
// event can locate the existing entry without scanning the DOM.
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

    if (ev.kind === "call") {
        clearEmpty();
        const node = renderPair(ev);
        if (!opts.expandNew) node.classList.add("collapsed");
        entryByCallId.set(ev.id, node);
        consoleEl.appendChild(node);
        if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
        return;
    }

    if (ev.kind === "result") {
        const existing = ev.forCallId != null ? entryByCallId.get(ev.forCallId) : null;
        if (existing) {
            // In-place upsert: no new DOM node, no scroll-to-bottom (the entry
            // is already in the user's view from when the call was rendered).
            upsertResult(ev);
            return;
        }
        // No matching call — render an orphan-result entry inline.
        clearEmpty();
        const node = upsertResult(ev);
        if (!opts.expandNew) node.classList.add("collapsed");
        consoleEl.appendChild(node);
        if (opts.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
        return;
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
