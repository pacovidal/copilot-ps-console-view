// PowerShell console visualizer — page-side logic.
// `window.copilot` is provided by /__bridge.js.

const consoleEl = document.getElementById("console");
const statusEl = document.getElementById("status");
const clearBtn = document.getElementById("clear");

const seenIds = new Set();
let lastSeenId = 0;
let empty = true;
let refilling = false;

// View options (formerly checkboxes; now toggles in the right-click menu).
const opts = {
    autoscroll: true,
    wrap: false,
    expandNew: false,
};
// Apply non-default initial state to the DOM on load.
consoleEl.classList.toggle("wrap", opts.wrap);

function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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
}

function clearEmpty() {
    if (empty) {
        consoleEl.innerHTML = "";
        empty = false;
    }
}

function makeHeader(initialChildren = []) {
    const header = el("div", { cls: "header-line" });
    const chevron = el("span", { cls: "chevron", text: "▸" });
    header.appendChild(chevron);
    for (const child of initialChildren) header.appendChild(child);
    header.addEventListener("click", () => {
        header.parentElement.classList.toggle("collapsed");
    });
    return header;
}

function renderCall(ev) {
    const wrap = el("div", { cls: "entry call" });
    const headerChildren = [el("span", { cls: "tool", text: ev.toolName })];
    if (ev.args?.description) {
        headerChildren.push(el("span", { cls: "desc", text: ev.args.description }));
    }
    headerChildren.push(el("span", { cls: "ts", text: fmtTime(ev.timestamp) }));
    wrap.appendChild(makeHeader(headerChildren));

    const a = ev.args || {};
    const meta = [];
    if (a.shellId) meta.push(`shell=${a.shellId}`);
    if (a.mode) meta.push(`mode=${a.mode}`);
    if (a.detach) meta.push("detached");
    if (a.initial_wait != null) meta.push(`wait=${a.initial_wait}s`);
    if (a.delay != null) meta.push(`delay=${a.delay}s`);
    if (meta.length) wrap.appendChild(el("div", { cls: "meta", text: meta.join("  ·  ") }));

    let body = "";
    if (ev.toolName === "powershell") body = a.command ?? "";
    else if (ev.toolName === "write_powershell") body = a.input ?? "";
    else if (ev.toolName === "read_powershell") body = "(read buffered output)";
    else if (ev.toolName === "stop_powershell") body = "(stop session)";
    else if (ev.toolName === "list_powershell") body = "(list sessions)";
    else body = JSON.stringify(a, null, 2);

    const cmd = el("div", { cls: "cmd" });
    const prompt = el("span", { cls: "prompt", text: "PS> " });
    cmd.appendChild(prompt);
    cmd.appendChild(document.createTextNode(body));
    wrap.appendChild(cmd);

    return wrap;
}

function renderResult(ev) {
    const status = ev.status || "success";
    const wrap = el("div", { cls: `entry result ${status}` });
    wrap.appendChild(makeHeader([
        el("span", { cls: "status-tag", text: status }),
        el("span", { cls: "tool", text: `← ${ev.toolName}` }),
        el("span", { cls: "ts", text: fmtTime(ev.timestamp) }),
    ]));

    const body = el("div", { cls: "body", text: ev.output || "(no output)" });
    wrap.appendChild(body);
    return wrap;
}

function appendOne(ev) {
    if (!ev || seenIds.has(ev.id)) return;
    seenIds.add(ev.id);
    if (ev.id > lastSeenId) lastSeenId = ev.id;
    clearEmpty();

    const node = ev.kind === "result" ? renderResult(ev) : renderCall(ev);
    if (!opts.expandNew) node.classList.add("collapsed");
    consoleEl.appendChild(node);

    if (opts.autoscroll) {
        consoleEl.scrollTop = consoleEl.scrollHeight;
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

window.psConsole = { append };

// Right-click context menu. Two groups separated by a divider:
//   1. Per-entry actions (collapse all / expand all)
//   2. Sticky toggles (auto-scroll, wrap, expand-new), formerly header checkboxes.
const contextMenu = document.createElement("div");
contextMenu.id = "context-menu";
contextMenu.hidden = true;
document.body.appendChild(contextMenu);

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
        btn.textContent = (opts2.checked ? "✓ " : "  ") + label;
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
}

function setAllCollapsed(collapsed) {
    for (const entry of consoleEl.querySelectorAll(".entry")) {
        entry.classList.toggle("collapsed", collapsed);
    }
}

function hideContextMenu() {
    contextMenu.hidden = true;
}

consoleEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    renderContextMenu();
    contextMenu.hidden = false;
    // Position; clamp inside the viewport.
    const { innerWidth: w, innerHeight: h } = window;
    const { offsetWidth: mw, offsetHeight: mh } = contextMenu;
    contextMenu.style.left = `${Math.min(e.clientX, w - mw - 4)}px`;
    contextMenu.style.top = `${Math.min(e.clientY, h - mh - 4)}px`;
});

contextMenu.addEventListener("click", (e) => {
    const action = e.target?.dataset?.action;
    if (!action) return;
    if (action === "collapse-all") setAllCollapsed(true);
    else if (action === "expand-all") setAllCollapsed(false);
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

window.addEventListener("click", hideContextMenu);
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
