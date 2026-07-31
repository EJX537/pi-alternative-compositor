# Agent Guide: pi-alternative-compositor

This document is for pi agents tasked with debugging, extending, or maintaining the compositor. It explains the architecture, the patching model, the cache hierarchy, and how the pieces interact at runtime.

**Do not use this extension without reading at least the README and this guide.** It monkey-patches pi's private internals and will break on upgrades.

---

## Table of Contents

1. [Architecture overview](#architecture-overview)
2. [Patching model](#patching-model)
3. [Render pipeline](#render-pipeline)
4. [Cache hierarchy](#cache-hierarchy)
5. [Cluster rendering](#cluster-rendering)
6. [Collapse system](#collapse-system)
7. [Sidebar extension API](#sidebar-extension-api)
8. [Input routing](#input-routing)
9. [Debugging](#debugging)
10. [Common failure modes](#common-failure-modes)

---

## Architecture overview

```
                    ┌──────────────────────────────────────┐
                    │          pi's TUI instance            │
                    │  (tui.children[], tui.doRender, etc.) │
                    └──────────┬───────────────────────────┘
                               │ patched
                    ┌──────────▼───────────────────────────┐
                    │   TerminalSplitCompositor             │
                    │   ┌────────────────────────────────┐  │
                    │   │ RenderEngine                   │  │
                    │   │  - renderFrame() ← entry point │  │
                    │   │  - refreshRootWindow()         │  │
                    │   │  - composeFrame() + diffRows() │  │
                    │   │  - paintFullFrame()            │  │
                    │   │  - repaintScrollableViewport() │  │
                    │   └────────────────────────────────┘  │
                    │   ┌────────────────────────────────┐  │
                    │   │ ChildRenderCache               │  │
                    │   │  - hash-signature per root     │  │
                    │   │    child                       │  │
                    │   └────────────────────────────────┘  │
                    │   ┌────────────────────────────────┐  │
                    │   │ CollapseController             │  │
                    │   │  - per-cell override patches   │  │
                    │   └────────────────────────────────┘  │
                    │   ┌────────────────────────────────┐  │
                    │   │ SelectionManager               │  │
                    │   │ MouseHandler                   │  │
                    │   │ TerminalModeManager            │  │
                    │   └────────────────────────────────┘  │
                    └──────────────────────────────────────┘
```

The compositor sits between pi's event loop and the terminal. It intercepts:

- **`tui.doRender`** → routes to `renderFrame()` or falls through to `originalDoRender()` for overlays
- **`tui.render`** → routes to `renderScrollableRoot()` which produces only the scrollable chat area
- **`tui.requestRender`** → invalidates cluster cache before scheduling (patched in `controller.ts`)
- **`tui.addInputListener`** → wraps to inject our own input handler (mouse, scroll, collapse clicks)
- **`tui.compositeLineAt`** → normalizes overlay composition line for sidebar-aware compositing
- **`terminal.write`** → passes through data, overlaid with cluster+sidebar repaint on overlay transitions
- **`terminal.rows`** → returns scrollable row count (raw rows minus cluster lines) instead of full terminal height
- **`terminal.columns`** → returns main content width (full width minus sidebar width)

---

## Patching model

All patches are applied in `install()` and restored in `dispose()`. The compositor does NOT modify pi's source files — it replaces methods on the live TUI and Terminal instances.

### Patch: `tui.doRender`

```typescript
this.tui.doRender = () => {
    this.renderPassActive = true;
    this.renderEngine.setRenderPassActive(true);
    try {
        const hasOverlay = this.renderEngine.hasVisibleOverlay();
        if (hasOverlay) {
            lastDoRenderHadOverlay = true;
            this.originalDoRender?.();   // Pi's native render — compositor hands off
        } else if (lastDoRenderHadOverlay) {
            // Overlay→non-overlay transition: one Pi render pass to restore
            // state, then next frames go through compositor again.
            lastDoRenderHadOverlay = false;
            this.renderEngine.overlayTransitionRepaintPending = true;
            this.originalDoRender?.();
        } else {
            lastDoRenderHadOverlay = false;
            this.renderEngine.renderFrame();  // compositor owns the frame
        }
    } finally {
        this.renderPassActive = false;
        this.renderEngine.setRenderPassActive(false);
    }
};
```

**Key insight**: Overlays (settings dialogs, select lists) still use pi's native renderer. Only the non-overlay TUI is compositor-owned. This means overlay transitions always flicker the cluster — the compositor paints it back on the next frame.

### Patch: `terminal.rows` / `terminal.columns`

```typescript
Object.defineProperty(this.terminal, "rows", {
    get: () => this.renderEngine.getScrollableRows(),
});
Object.defineProperty(this.terminal, "columns", {
    get: () => this.renderEngine.getMainWidth(),
});
```

Pi reads `terminal.rows` to know how many lines it can fill. The compositor lies: it reports `rawRows - clusterLines.length` so pi thinks the terminal is shorter than it really is. Pi fills only the scrollable area; the compositor paints the cluster below it.

### Patch: `terminal.write`

```typescript
this.terminal.write = (data: string) => this.write(data);
```

Every byte pi writes goes through the compositor. Most writes pass through directly (`this.originalWrite(data)`). During overlay transitions, the interceptor adds cluster+sidebar repaint to prevent flicker.

### Patch: `tui.requestRender`

```typescript
const originalRequestRender = this.tui.requestRender.bind(this.tui);
this.tui.requestRender = (force?: boolean) => {
    this.renderEngine.invalidateClusterCache();
    originalRequestRender(force);
};
```

Invalidates the cluster generation cache before scheduling a render. Without this, cluster-area animations (extension spinners in above/below widgets) would read stale cached cluster data for the `scrollableRows` calculation.

### Patch: `hideRenderable` (cluster children)

```typescript
hideRenderable(target) {
    if (this.patchedRenders.some(p => p.target === target)) return;
    const originalRender = target.render.bind(target);
    this.patchedRenders.push({ target, originalRender });
    target.render = () => [];
}

renderHidden(target, width) {
    const patch = this.patchedRenders.find(p => p.target === target);
    const render = patch?.originalRender ?? target.render.bind(target);
    return render(width);
}
```

All cluster children (editor, above/below widgets, footer) have their `render()` replaced with `() => []`. This prevents pi from rendering them in the scrollable root (via `tui.render()` which iterates all children). The compositor renders them explicitly via `renderHidden()` when building the fixed cluster.

**Important**: If an extension replaces a cluster child's `render()` after the compositor hides it, the change is invisible because `renderHidden()` uses the captured original. Add the component before the compositor installs, or call `hideRenderable()` yourself after replacing `render`.

---

## Render pipeline

### Entry point: `renderFrame()` → `refreshRootWindow()` → compose frame → A/B diff → paint

```
requestRender()
  └→ doRender() (patched)
       └→ renderFrame()
            ├─ 1. refreshRootWindow(width)
            │      ├─ getCluster(width, rows) → scrollableRows = rows - cluster.lines
            │      ├─ childRenderCache.render(rootChildren, width) → rootLines
            │      ├─ updateRootComponentLineRanges() → hit-testing data
            │      └─ updateVisibleRootWindow() → visibleRootLines
            │
            ├─ 2. composeFrame(width, rows, cluster, highlightedRootLines)
            │      → full-screen rows, sanitized + padded to terminal width
            │        (main columns + sidebar columns), sidebar rendered once
            │
            ├─ 3. forceFullPaint?  (no previous frame | screenFrameDirty |
            │      width/height changed)
            │      YES → synchronized full paint (scroll region + all rows +
            │             cluster + sidebar), then recordScreenFrame
            │
            ├─ 4. diffRows(prevFrame.rows, rows)
            │      ├─ 0 changed → reposition cluster cursor, nothing else
            │      ├─ < half the screen → write only changed rows
            │      │    (moveCursor(row,1) + composed row) + cursor paint
            │      └─ ≥ half the screen → synchronized full paint
            │
            └─ 5. originalWrite(buffer)
```

### A/B diff vs full paint

| Condition | Path | Writes |
|-----------|------|--------|
| First frame / resize / `screenFrameDirty` (passthrough write, overlay transition, intermediate frame) | Full paint | All scrollable rows + cluster + sidebar |
| Few changed rows (< half the screen) | A/B diff | Only rows whose composed content differs + cluster cursor |
| Many changed rows (≥ half the screen) | Full paint | All scrollable rows + cluster + sidebar |
| No changed rows | Cursor only | Cluster cursor positioning (+ mouse guard) |

Change detection is **exact**: the previous frame's composed rows are compared
string-for-string against the new frame, so a component whose signature
changed but whose output is byte-identical costs nothing, and in-place
content mutations that slip past the signature cache are still caught.  The
signature cache remains purely a render optimization (skip re-rendering
unchanged components); it no longer drives the paint decision.

The diff path avoids `beginSynchronizedOutput`/`endSynchronizedOutput` and
scroll-region setup — just `moveCursor` + row content.  This makes spinner
animations smooth (no ~500 bytes of escape overhead per 80ms tick).

`screenFrameDirty` is set whenever the compositor writes outside the frame
model (editor echo passthrough in `write()`, overlay transitions, `paintIntermediateFrame`).  The next `renderFrame()` then does a full paint instead of
risking a stale diff.

Scroll repaints (`repaintScrollableViewport`) update the A/B frame in place
via `recordPaintedRows()` so a subsequent diff does not see the whole
viewport as changed.

### The `refreshRootWindow()` → `getCluster()` subtlety

`refreshRootWindow()` calls `getCluster()` to determine `scrollableRows = rawRows - cluster.lines.length`. This call hits the generation-based cluster cache. If the cluster content has changed but the generation hasn't been bumped, `getCluster()` returns stale data — but `scrollableRows` is still correct because the cluster's `lines.length` rarely changes from content updates alone.

The actual cluster paint uses a second `getCluster()` call (after nulling `renderPassCluster`), which always produces fresh content.

---

## Cache hierarchy

### 1. ChildRenderCache (root children)

```
Key: root child object reference
Value: { lines: string[], signature: number }
Invalidation: signature mismatch (hash changes)
```

The `signature` is a recursive 32-bit djb2 hash of:
- Component type (`"tool"`, `"assistant"`, or `"unknown"`)
- Stable identity (toolCallId / message.id / WeakMap counter)
- Content fingerprint (`.text` or `.content` value)
- Collapse state (isCollapsed)
- Terminal width
- Recursive child signatures

**Animation support**: The `"unknown"` branch includes `String(component.text ?? component.content)` in the hash. When a Loader/Text component updates its text, the hash changes, the parent Container's hash changes (because it includes child hashes recursively), and the root cache misses → re-render.

### 2. Cluster cache (getCluster)

```
Key: renderPassCluster object (width + terminalRows + generation)
Invalidation: renderPassCluster set to null, or generation mismatch
```

The cluster generation (`clusterGeneration`) is bumped by:
- `handleInput()` (keyboard/mouse input)
- `paintFullFrame()` (explicit full repaint)
- `requestRender()` (our patch — any render request)

The cluster is always re-rendered on `renderFrame()` because `renderPassCluster` is set to `null` at the start of both the incremental and full paint paths.

### 3. Range mapper cache (descendant positions)

The `ComponentRangeMapper` caches rendered lines for every component it visits (root children AND their descendants). Used for hit-testing (mouse click → which component?). Cleared on width change, collapse toggle, or explicit `clear()` call.

### 4. pi-tui internal caches (Text, Container)

Pi's own components have internal caches (e.g., `Text.cachedLines`). These are cleared by `setText()`, `invalidate()`, or direct mutation detection (`cachedText !== text`). The compositor does NOT touch these — they work as pi designed them.

---

## Cluster rendering

The cluster is the fixed bottom area containing:
- Status lines (above editor)
- Above widgets
- Editor (input)
- Below widgets
- Footer

```
┌──────────────────────────────────────────────┐
│ Scrollable root (chat messages, status, etc) │  ← terminal.rows reports this height
├──────────────────────────────────────────────┤
│ Above widgets                                │  ← cluster starts here
│ [top padding = 1 blank line]                 │
│ Editor (input)                               │
│ [bottom padding = 1 blank line]              │
│ Below widgets                                │
│ Footer                                       │
└──────────────────────────────────────────────┘
```

### How cluster children are rendered

The `renderCluster` callback in `lifecycle.ts`:

```typescript
renderCluster: (width, terminalRows) => {
    // Slice dynamically at render time
    const clusterChildren = tui.children.slice(clusterStartIndex);
    
    // Find editor within the slice
    const editorSliceIndex = editorMatch.index - clusterStartIndex;
    const editorContainer = clusterChildren[editorSliceIndex];

    // Hide ALL cluster children from pi's root render
    for (const child of clusterChildren) {
        nextCompositor.hideRenderable(child);
    }

    // Build cluster content
    return renderFixedEditorCluster({
        width,
        terminalRows,
        aboveWidgetLines: aboveChildren.flatMap(child =>
            renderHidden(nextCompositor, child, width)
        ),
        editorLines: renderHidden(nextCompositor, editorContainer, width),
        belowWidgetLines: belowChildren.flatMap(child =>
            renderHidden(nextCompositor, child, width),
        ),
        topPaddingLines: 1,
        bottomPaddingLines: 1,
    });
};
```

`clusterStartIndex` is `Math.max(0, editorMatch.index - 1)`, placing one widget above the editor (typically the widget container). Children at or above this index are excluded from root rendering.

### Cluster space allocation

`renderFixedEditorCluster()` calculates available rows:

```
remaining = maxRows - editorLines - status - topPadding - bottomPadding
aboveWidgets = takeTail(aboveWidgetLines, remaining)  // drops from TOP if too many
remaining -= aboveWidgets.length
belowWidgets = takeTail(belowWidgetLines, remaining)
remaining -= belowWidgets.length
footer = takeTail(footerLines, remaining)
```

`takeTail` keeps only the last N lines. If there are too many above-widget lines, EARLY ones are dropped (most recently added widgets win). The cluster is compact — it never fills remaining space with padding.

### Cluster cursor

The editor may contain a `CURSOR_MARKER` (`\x1b_pi:c\x07`). `extractCursor()` finds it and returns cursor position. The cluster paint uses this for hardware cursor positioning.

---

## Collapse system

### How it works

1. On session start, `CollapseController` wires into pi's component tree via `setupExpansionInterceptor()`.
2. For each collapsible component (Tool, Assistant with ThinkingMarkdown), it calls `setupCellOverride()`.
3. `setupCellOverride()` patches `setExpanded()` (for Tools) or `setHideThinkingBlock()` (for Assistants) to check for an override before delegating to pi.
4. Overrides are stored in a `Map<string, boolean>` keyed by `toolCallId` or `message.id`.
5. When pi's global collapse keyboard shortcut fires, pi calls `setExpanded(false)` on ALL tool cells. With the patch, each cell checks its override: if an override exists, the pi call is ignored and our preference wins.
6. Toggle from mouse click works via `CollapseController.toggle(component, clickLine)` in `MouseHandler.handleRelease()`.

### Stability

Overrides survive streaming because they're keyed by stable IDs (`toolCallId` / `message.id`), not object references. When pi rebuilds a cell during streaming, the new component goes through `setupCellOverride()` and picks up any existing override from the map.

### Range mapping for collapse anchoring

When a cell is collapsed, the viewport anchors to keep the click position stable:
- If click was above viewport → snap collapsed header to viewport top
- If click was in viewport → pin click line to same screen row
- Formula: `scrollOffset = max(0, min(rootLines - scrollableRows - desiredStart, maxScrollOffset))`

---

## Sidebar extension API

### Symbol

```typescript
const SIDEBAR_SYMBOL = Symbol.for("pi-fixed-editor-compositor.sidebar.v2");
```

### Registry interface

```typescript
type SidebarRegistry = {
    readonly version: 2;
    add(component: Component, options?: {
        id?: string;
        order?: number;    // lower = first (default 0)
        visible?: () => boolean;
    }): () => void;
    requestRender(): void;
    invalidate(): void;
};
```

### How it renders

```
sidebarRoot (Container)
  ├── Text(built-in header)
  └── extensionContainer (Container — rebuilt on every add/remove)
        ├── CompA (order: 10)
        ├── CompB (order: 20)
        └── ...sorted by order, filtered by visible()
```

The compositor calls `sidebarRoot.render(sidebarWidth)` inside `buildSidebarPaint()`. This produces lines that are painted in the rightmost columns of the terminal, on every frame. The sidebar component is NOT cached — it's rendered fresh every frame.

Error isolation: individual component render errors are caught in `buildSidebarPaint()` with try/catch, returning `[]` on failure. A broken panel doesn't crash the sidebar.

---

## Input routing

### Mouse

1. SGR mouse packets arrive via stdin → `handleInput()` in controller
2. `parseSgrMousePackets()` decodes packets
3. Wheel events → `scrollBy()` → `repaintScrollableViewport()` (scroll region only, no cluster repaint)
4. Click on root → `MouseHandler.handleLeftPress()` → selection starts
5. Click on collapsible cell → `handleRelease()` → `CollapseController.toggle()` → `repaint({ refreshRoot: true })`
6. Click on cluster → handled by `SelectionManager.selectionLocationForPacket()` which identifies the area based on screen row

### Keyboard

1. Non-mouse data → `handleInput()` in controller
2. `invalidateClusterCache()` — ensures fresh editor content for scrollableRows
3. `isRootSubmitInput(data)` → Enter key → `jumpToRootBottom()` → resets scrollOffset to 0
4. `parseKeyboardScrollDelta(data)` → PageUp/PageDown → `scrollBy()`
5. Everything else passes through to pi's input listeners (editor handles it)

### Scroll coalescing

Wheel events and keyboard scrolls are coalesced by `ScrollCoalescer`:

```typescript
schedule(delta) → setTimeout(flush, 50ms)
flush() → scrollBy(totalDelta) → repaintScrollableViewport()
```

This prevents 50 separate repaints from a single physical scroll wheel turn.

---

## Debugging

### Environment variables

| Variable | Effect |
|----------|--------|
| `PI_COMPOSITOR_DEBUG=1` | Enables debug logging to stderr via `logDebug()` |
| `PI_COMPOSITOR_SYNC_SCROLL=1` | Re-enables DEC synchronized output during scroll repaints (disabled by default because Ghostty lags) |

### What to log

To trace the render pipeline, add logs in `renderFrame()`:

```typescript
logDebug("renderFrame: changed=", changed.size,
    "affected=", this.estimateAffectedLines(changed),
    "path=", changed.size > 0 ? "incremental" : "full");
```

To trace cluster caching:

```typescript
logDebug("getCluster: cacheHit=",
    this.renderPassCluster?.generation === this.clusterGeneration);
```

### Test files

| Test | What it covers |
|------|----------------|
| `tests/compositor.test.ts` | Installation, lifecycle, renders, overlays, settings |
| `tests/collapse-anchor.test.ts` | Viewport anchoring on collapse/expand |
| `tests/cluster.test.ts` | `renderFixedEditorCluster()` — layout, cursor, truncation |
| `tests/render.test.ts` | Render cache, signatures, hash consistency |
| `tests/escape.test.ts` | Escape sequence builders |
| `tests/input.test.ts` | Mouse packet parsing, keyboard scroll delta |
| `tests/text.test.ts` | ANSI stripping, column slicing |
| `tests/selection.test.ts` (probably) | Mouse selection |
| `tests/settings.test.ts` | Settings store, persist/load |

---

## Common failure modes

### 1. Spinner/animation frozen in cluster

**Symptom**: A Loader or animated component in above/below widgets or footer doesn't update.

**Causes**:
- No `requestRender()` call after updating text (extension bug — pi-tui's `setText()` does NOT call `requestRender()`; only `Loader.updateDisplay()` does)
- Cluster cache not invalidated (should be fixed by `requestRender` patch in controller.ts)
- Text component's internal cache not cleared (should auto-detect via `cachedText !== text`)

**Fix**: Ensure the extension calls `tui.requestRender()` after each text update. If the component is a Loader, this happens automatically. If it's a bare Text, the extension must call it.

### 2. Cluster appears below scrollable area

**Symptom**: The editor/input bar is pushed below the visible area or overlaps with chat content.

**Causes**:
- `clusterGeneration` not bumped after editor content change → `getCluster()` returns stale `lines.length` → `scrollableRows` is wrong
- `handleInput()` should bump the generation; if input bypasses `handleInput()`, the cache stays valid

**Fix**: Call `invalidateClusterCache()` before `requestRender()` when changing editor state without user input.

### 3. Sidebar overlaps content

**Symptom**: Right-side columns show garbage or chat text extends into sidebar area.

**Causes**:
- `sidebar.mainWidth` + `sidebar.sidebarWidth` exceeds `terminal.columns`
- `sanitizeLine()` in `incrementalRepaint()` or `paintFullFrame()` produces content longer than `mainWidth` without padding

**Fix**: `resolveSidebarLayout()` handles this by clamping sidebar width. Check that `sanitizeLine()` return includes `\x1b[0m` + padding.

### 4. Mouse clicks hit wrong component

**Symptom**: Clicking on one message collapses a different one.

**Causes**:
- Stale `rootComponentLineRanges` — the range mapper has cached positions from a previous render
- Component line count changed (streaming added/removed lines) without a re-render

**Fix**: `handleInput()` calls `forceRefreshRootState()` on first click after install, and `refreshRootComponentRanges()` on subsequent clicks. If the ranges are still stale, check that the component's `render()` is being called (pi may have cached it internally).

### 5. Duplicated cluster during overlay

**Symptom**: When an overlay (settings dialog) closes, the editor appears twice — once from pi's native render and once from the compositor.

**Cause**: The overlay transition path calls `originalDoRender()` which renders ALL children (including cluster children that were hidden by `hideRenderable()`). But `hideRenderable()` replaced their render with `() => []`, so pi renders them as empty. The compositor then paints the cluster on the next frame. If `hideRenderable()` wasn't called for a cluster child, pi renders it AND the compositor paints it.

**Fix**: Ensure `hideRenderable()` is called for ALL cluster children. The `renderCluster` callback iterates all children at `clusterStartIndex` and above, so newly added children are caught.

### 6. Scroll region mismatch flicker

**Symptom**: One frame shows the scrollable area too large or too small, causing a visible jump.

**Cause**: `scrollableRows` computed from stale cluster `lines.length` (cache hit when cluster content changed).

**Fix**: `handleInput()` bumps `clusterGeneration` before processing input. For non-input changes (streaming), the `invalidateClusterCache()` in `requestRender()` ensures the next frame uses fresh data.
