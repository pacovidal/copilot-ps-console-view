# Themes

Themes control the colours (and, if you want, the fonts and other CSS) used
by the Copilot PowerShell Console window.

## Where themes live

| Directory                                     | Source     | Survives upgrade |
| --------------------------------------------- | ---------- | ---------------- |
| `<extension-install-dir>/content/themes/`     | built-in   | No (replaced)    |
| `<extension-install-dir>/themes/`             | user       | **Yes**          |
| `$env:COPILOT_PS_CONSOLE_THEMES_DIR`          | user (override of the above) | n/a |

The extension ships built-in themes under `content/themes/`. **Drop your own
`.css` files into the user themes directory** (default
`<extension-install-dir>/themes/`) and they are picked up automatically — no
restart needed; just open the right-click context menu, pick `Theme ▸`, and
your themes appear listed below the built-ins.

If a user theme has the same filename as a built-in (e.g. `solarized-dark.css`),
your version wins.

The extension's installer (`scripts\install.ps1`) preserves
`<extension-install-dir>/themes/` across upgrades, so your themes survive a
reinstall. The uninstaller deletes the whole tree (you'll be warned about
how many user themes are about to go).

To keep your themes in a dotfiles repo or shared folder, set
`COPILOT_PS_CONSOLE_THEMES_DIR` to point there before launching Copilot CLI.

## Authoring a theme

A theme is a single `.css` file with one rule defining the variables the
extension's stylesheet uses. The file's basename (without `.css`) becomes the
theme's display name.

Minimal example — `<extension-install-dir>/themes/midnight-purple.css`:

```css
:root {
    --bg:               #14111f;
    --bg-header:        #1d1830;
    --bg-button:        #2a2342;
    --bg-button-hover:  #3a3055;
    --bg-cmd:           #1a162a;
    --bg-result:        #161222;
    --bg-menu:          #2a2342;
    --bg-menu-hover:    #5d3aa6;
    --bg-status:        #5d3aa6;
    --bg-hover-row:     rgba(255, 255, 255, 0.04);

    --fg:               #d8d4ea;
    --fg-strong:        #ffffff;
    --fg-dim:           #6a5a8a;
    --fg-status:        #ffffff;
    --fg-cmd:           #d8d4ea;
    --fg-desc:          #b8b0d0;

    --accent-status:    #88c070;
    --accent-tool:      #d875c2;
    --accent-header:    #9b87d6;
    --accent-cmd:       #7b65c4;
    --accent-success:   #88c070;
    --accent-failure:   #e07a8c;
    --accent-warn:      #e0c878;

    --border:           #2a2342;
    --border-button:    #4a3f6a;
    --border-menu:      #4a3f6a;

    --shadow-menu:      0 4px 12px rgba(0, 0, 0, 0.5);
}
```

The fastest way to start is to copy one of the built-in themes (e.g.
`content/themes/solarized-dark.css`), rename it, and tweak the values.

Themes are full CSS files: you can append rules to override fonts, border
radii, padding, or anything else. Just keep the variable definitions on
`:root` so they apply globally.

## Variables

Every variable below should be set by your theme.

### Backgrounds

| Variable            | Used for                                                      |
| ------------------- | ------------------------------------------------------------- |
| `--bg`              | Page background, scrollbar track, status-tag foreground (small text on success/failure tags) |
| `--bg-header`       | Top header bar                                                |
| `--bg-button`       | "Clear" button background                                     |
| `--bg-button-hover` | "Clear" button hover                                          |
| `--bg-cmd`          | Command (`PS>`) block background                              |
| `--bg-result`       | Tool-result block background                                  |
| `--bg-menu`         | Right-click context menu background                           |
| `--bg-menu-hover`   | Hovered context-menu item background                          |
| `--bg-status`       | Footer status-bar background                                  |
| `--bg-hover-row`    | Subtle hover highlight on call/result header rows. For dark themes use `rgba(255,255,255,0.04)`; for light themes use `rgba(0,0,0,0.04)`. |

### Foregrounds

| Variable       | Used for                                              |
| -------------- | ----------------------------------------------------- |
| `--fg`         | Default text colour, context-menu items, result body  |
| `--fg-strong`  | Header title, button label                            |
| `--fg-dim`     | Timestamps, chevrons, "empty" placeholder, scrollbar thumb |
| `--fg-status`  | Footer status text, hovered context-menu text         |
| `--fg-cmd`     | Command block text                                    |
| `--fg-desc`    | Italic command description                            |

### Accents

| Variable           | Used for                                                  |
| ------------------ | --------------------------------------------------------- |
| `--accent-status`  | Live "dot" in the header (and its glow)                   |
| `--accent-header`  | Entry header line text                                    |
| `--accent-cmd`     | Command block left border + `PS>` prompt                  |
| `--accent-success` | Status circle (success/active/stopped/pending) + healthy result/output bar |
| `--accent-failure` | Status circle (failure/rejected/denied/unknown) + non-success result/output bar |
| `--accent-warn`    | Missing-shell chip on orphan continuation entries         |

### Borders & effects

| Variable           | Used for                                              |
| ------------------ | ----------------------------------------------------- |
| `--border`         | Header bottom border                                  |
| `--border-button`  | Button border, scrollbar thumb colour                 |
| `--border-menu`    | Context menu border + separator line                  |
| `--shadow-menu`    | Context menu drop shadow (full `box-shadow` value)    |

## How the extension picks a starting theme

On first launch (or if your saved choice has been cleared) the extension
honours `prefers-color-scheme`:

- OS prefers light → starts with `default-light`.
- Otherwise → starts with `default-dark`.

After that, your last selection is remembered in
`<extension-install-dir>\themes\.state.json` (preserved across upgrades along
with your user themes) and used on every subsequent launch.

## Native window chrome (Windows 11 titlebar)

The extension also tells the native runtime whether the active theme is
"light" or "dark" (sniffed from `--bg`'s luminance). On Windows 11 this
controls the titlebar colour. **The runtime cannot change the native chrome
of an already-open window**, so a theme switch only updates the titlebar on
the *next* window open. The page itself updates immediately.

If you don't care about this, ignore it — it's a minor cosmetic detail.
