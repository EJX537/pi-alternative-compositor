# pi-alternative-compositor

> **⚠️ EXPERIMENTAL — AI-generated, hooks pi's private internals.** This extension replaces pi's entire TUI rendering pipeline by monkey-patching `tui.render`, `tui.doRender`, `terminal.write`, `terminal.rows`/`columns`, and `compositeLineAt`. It **may** break on pi upgrades. Not intended for casual use — clone it, read it, understand it.

A scrollable chat viewport compositor for [pi coding agent](https://pi.dev) that keeps the editor fixed at the bottom while the chat history scrolls independently, with click-to-collapse and an extensible sidebar.

## Why this exists

Pi's default TUI renders all children in one linear scroll — the editor, widgets, and footer move with the chat log. This compositor splits the screen into two regions:

- **Scrollable root** — chat messages, status indicators, and tool outputs
- **Fixed cluster** — the input editor, above/below widgets, and footer, always pinned to the bottom

Additionally, it provides cell-level collapse/expand for Tool and Thinking blocks that survives streaming and component rebuilds, and a sidebar panel system for extensions.

## Installation (git only)

```bash
git clone https://github.com/ejx537/pi-alternative-compositor
pi -e /path/to/pi-alternative-compositor/src/index.ts
```

No `pi install` path — this extension does too much low-level patching for someone to use without reading the source.

## Architecture for agents

Three subsystems, layered:

### 1. Terminal split compositor (`src/terminal/`)
Replaces the rendering pipeline. Owns:
- **`RenderEngine`** — `renderFrame()` (entry point from patched `tui.doRender`), A/B frame diffing (writes only screen rows that changed), full paint for first frame / resize / untracked writes, scroll region management
- **`ChildRenderCache`** — per-root-child hash-signature caching to avoid re-rendering unchanged components on every frame. Signatures include recursive child hashes so collapsing a nested tool invalidates the parent.
- **`TerminalSplitCompositor`** — lifecycle (`install`/`dispose`), input routing (mouse/keyboard/scroll), `terminal.write` interception
- **Render pipeline**: `requestRender` → `doRender` (patched) → `renderFrame` → `refreshRootWindow` (render root children via cache) → compose full screen frame (root + cluster + sidebar) → A/B diff against previous frame → write only changed rows; large diffs and dirty frames (passthrough writes, overlay transitions, resize) fall back to a synchronized full paint

### 2. Collapse controller (`src/collapse/`)
Per-cell collapse/expand that survives streaming:
- `CollapseController` patches `setExpanded()` / `setHideThinkingBlock()` on each collapsible component
- Overrides keyed by `toolCallId` / `message.id` — stable across component rebuilds
- When pi's global collapse key fires, the patch checks for a per-cell override first; if one exists, pi's call is ignored

### 3. Sidebar (`src/app/`)
Native pi TUI component tree rendered in reserved right-side columns:
- `sidebarRoot` (Container) → built-in `Text` header + extension container
- Extensions add/remove Components via `Symbol.for("pi-fixed-editor-compositor.sidebar.v2")` registry
- No custom render dispatch — uses standard `Container.render()`

## Key constraints for agent developers

- **Cluster cache is generation-based.** `getCluster()` checks `clusterGeneration` before returning cached editor/wiget/footer content. The generation is bumped by `handleInput()`, `paintFullFrame()`, and now `requestRender()`. If you update cluster children without calling `requestRender()`, the cluster stays stale.
- **Root cache is hash-based.** `ChildRenderCache` hashes each root child's identity + content + collapse state + recursive child hashes. If your component lives outside `tui.children[0..clusterStartIndex)`, it's not in the root cache — it's in the cluster.
- **`hideRenderable()` patches `render` to `[]`.** All cluster children have their `render()` replaced. The cluster callback uses `renderHidden()` to call the original. If you replace a cluster child's `render` after the compositor hides it, the change is invisible — `renderHidden()` uses the captured original.
- **The compositor owns the full alternate screen.** It writes `\x1b[?1049h` on install, `\x1b[?1049l` on dispose. Mouse reporting, keyboard modes, bracketed paste, and scroll regions are managed by `TerminalModeManager`. Any raw terminal write risks being overwritten by the next `renderFrame()`.

## Settings

Open **`/compositor`** in pi to toggle the sidebar. Persists in `settings.json` under `compositor.enableSidebar`.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
