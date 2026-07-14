# pi-alternative-compositor

> **⚠️ EXPERIMENTAL — heavily vibe coded.** This extension was AI-generated and hooks into pi's private internals. It may break on any pi upgrade. Use at your own risk.

A scrollable chat viewport compositor for [pi coding agent](https://pi.dev) that replaces the built-in TUI rendering pipeline. It keeps the editor fixed at the bottom, adds scrollback, mouse selection, and click-to-collapse interactions.

> **⚠️ Internal API dependency:** Patches pi's private internals (`tui.render`, `tui.doRender`, `terminal.write`, `compositeLineAt`, `terminal.rows`/`columns`). Only tested against pi v0.80.x. Expect breakage on upgrade.

## Features

- **👆 Click to collapse** — Per Tool/Thinking cell collapse and expand.
- **📌 Fixed editor** — The input editor stays at the bottom while the chat scrolls independently.
- **📋 Right sidebar** — Reserved space for sidebar (Showcase).

## Installation

```bash
pi install git:github.com/ejx537/pi-alternative-compositor
```

Or load directly:

```bash
git clone https://github.com/ejx537/pi-alternative-compositor
pi -e /path/to/pi-alternative-compositor/src/index.ts
```

## Usage

The compositor activates automatically on the next session start.

### Mouse

- **Click** a tool output or assistant message to toggle collapse.

## Settings

Open **`/compositor`** to toggle the sidebar. Setting persists in pi's global `settings.json` under `compositor.enableSidebar`.
## Development

```bash
npm install
npm test           
npm run test:watch
npm run typecheck
```

Tests cover rendering, input parsing, collapse, selection, mouse handling, escape sequences, and settings.

## License

MIT
