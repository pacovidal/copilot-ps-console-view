// Child process: opens the native window. The Node event loop is blocked
// by app.run() — all communication happens via the page's WebSocket.
import { Application } from "@webviewjs/webview";
import { readFileSync } from "node:fs";

const { CW_URL, CW_TITLE, CW_WIDTH, CW_HEIGHT, CW_ICON_PATH } = process.env;

const app = new Application();
const win = app.createBrowserWindow({ title: CW_TITLE, width: +CW_WIDTH, height: +CW_HEIGHT });

if (CW_ICON_PATH) {
    try {
        // .rgba blob format produced by scripts/bake-icon.mjs:
        //   bytes 0..3  : width  (uint32 LE)
        //   bytes 4..7  : height (uint32 LE)
        //   bytes 8..   : raw RGBA8 pixel data (width * height * 4 bytes)
        // Pre-baking avoids a runtime PNG-decoder dependency.
        //
        // NOTE: This sets the titlebar icon. The Windows taskbar icon is
        // keyed off the process's AppUserModelID, which without an explicit
        // call to shell32!SetCurrentProcessExplicitAppUserModelID falls back
        // to the host exe's icon (node.exe). Setting AUMID requires FFI into
        // shell32 — intentionally not done here to keep deps minimal.
        const buf = readFileSync(CW_ICON_PATH);
        const width = buf.readUInt32LE(0);
        const height = buf.readUInt32LE(4);
        const pixels = buf.subarray(8);
        const expected = width * height * 4;
        if (pixels.length !== expected) {
            throw new Error(`pixel byte count ${pixels.length} != width*height*4 (${expected}) for ${width}x${height}`);
        }
        win.setWindowIcon(Array.from(pixels), width, height);
    } catch (e) {
        process.stderr.write(`copilot-webview: failed to load window icon (${CW_ICON_PATH}): ${e?.message ?? e}\n`);
    }
}

win.createWebview({ url: CW_URL, enableDevtools: true });
app.run();
