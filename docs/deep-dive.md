# Deep Dive: Pi TUI vs. the Alternative Compositor

Comparison of the installed `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent`
(v0.80.6) interactive mode against this extension's `TerminalSplitCompositor`. Answers four
questions the maintainer asked, with feasibility, effort, and the shared enabler
that makes most of them tractable.

All Pi internals discussed here are verified against compiled dist source at:
- `pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/`
- `pi-coding-agent/dist/modes/interactive/`

> **Compatibility warning:** the extension declares Pi peer dependencies `>=0.78.0`.
> Its local development dependencies are currently v0.80.2, while the Pi runtime
> running this session is v0.80.6. The compositor and every proposed
> chat-component interaction depend on private internals, so re-verify them
> whenever Pi is upgraded.

## How the two compositors relate

### pi-tui's built-in compositor (`TUI.doRender()`)

- `Container.render(width)` concatenates children's `render()` into a flat
  `string[]`. No layout engine. Lines flow top-to-bottom in child order.
- `doRender()` builds the base frame, then `compositeOverlays()` splices each
  `overlayStack` entry in via `compositeLineAt(baseLine, overlayLine, startCol,
  overlayWidth, totalWidth)` at an absolute `(row, col)`. Overlays are the
  **only** absolute-positioning mechanism.
- Differential: line-by-line diff against `previousLines`. Full clear on width
  change, height change, or `firstChanged < previousViewportTop`. The viewport
  **always snaps to bottom**:
  `previousViewportTop = Math.max(prev, finalCursorRow - height + 1)`.
  The comment at `tui.js:182` confirms `previousViewportTop` exists only for
  "resize-aware cursor moves," not scroll preservation.
- Mouse reporting is never enabled (no `\x1b[?1000h` anywhere in
  `ProcessTerminal.start`). `StdinBuffer` only parses SGR mouse so stray
  sequences don't corrupt the buffer.

### This extension's alternative compositor

`TerminalSplitCompositor` (in `src/terminal/controller.ts`) replaces
`tui.render`, `tui.doRender`, `terminal.write`, `compositeLineAt`, and lies
about `rows`/`columns` via `Object.defineProperty`. It owns the alternate
screen, sets DEC scroll regions, enables SGR mouse reporting, and paints three
regions (root + fixed cluster + sidebar) itself. So it's a genuine re-compositor
— it doesn't use Pi's `compositeLineAt` path except as a passthrough for when
Pi's own overlays are visible (`renderOverlayFrame`).

Key structural consequence: when Pi's overlays are up (`hasVisibleOverlay()`),
this compositor yields and renders a full physical frame for Pi to overlay
onto. During normal operation, it bypasses Pi's differential pipeline entirely
and does its own `repaintScrollableViewport`.

---

## 1. Center editor on new session, then move to bottom — Feasible, medium–high effort

The cluster's vertical position is currently bottom-anchored by
`buildFixedClusterPaint` in `src/compositor/frame.ts`; `controller.ts` also
assumes the root occupies every row above that cluster. `ClusterPlacement` in
`src/compositor/contracts.ts` currently permits only `"bottom"`.

Centering is therefore not an isolated paint change: root slicing, DEC scroll
regions, ordinary writes, overlay frames, cursor placement, and cluster paint
must all consume one shared frame-layout calculation.

To center on a new session:

1. Track `editorPlacement: "center" | "bottom"` — init `"center"` on
   `session_start` when `event.reason === "new"`, flip to `"bottom"` on the
   first `agent_start` (the same hook that already toggles `sidebarVisible`).
2. Extend the frame-layout contract to describe the root region(s), cluster,
   and sidebar for both placements. A centered editor has root space above and
   below it; decide explicitly whether streamed output uses only the upper
   region or a split viewport.
3. Generalize `buildFixedClusterPaint` to accept the layout's cluster row; for
   a simple centered placement it is
   `Math.floor((rawRows - cluster.lines.length) / 2) + 1`.
4. Make `write()`, `repaintScrollableViewport()`, overlay rendering, and cursor
   paint use that same layout. The DEC scroll region must not include the
   cluster rows.

Input keeps working — the editor reads keys via `focusedComponent.handleInput`,
independent of screen position; the hardware cursor is placed via
`moveCursor(startRow + cluster.cursor.row, …)` which already uses the computed
startRow.

**Pitfall:** on the center→bottom transition, trigger a full repaint (your
`requestRepaint` already covers this) and reset the scroll region before the
next write so root content above the cluster isn't clipped to the old region.

---

## 2. Per-cell collapse of tool/thinking cells — Tool cells feasible (medium). Thinking cells: per-message easy, per-block fragile (high).

### Current global behavior

- `toggleToolOutputExpansion()` (interactive-mode.js:3064–3077) iterates
  `chatContainer.children` and calls `setExpanded(expanded)` on every
  expandable child. That's the **only** thing making it global — there's no
  architectural reason it has to be.
- `toggleThinkingBlockVisibility()` (interactive-mode.js:3079–3092) is worse:
  it flips a single `hideThinkingBlock` boolean, `chatContainer.clear()`s, and
  `rebuildChatFromMessages()` — a full rebuild. Inside
  `AssistantMessageComponent.updateContent` (assistant-message.js), each
  thinking block is rendered as a `Markdown` child in `contentContainer`
  gated by that single boolean. There is **no per-block state**.

### Tool cells

Each `ToolExecutionComponent` already has its own `expanded` boolean and a
public `setExpanded(expanded)` (tool-execution.js:161). Per-cell collapse is
just a matter of **which** cell you target:

- An extension can walk `chatContainer.children` (it's the third child of
  Pi's root `Container`, reachable via `tui.children`), filter for instances
  with `toolCallId` / `toolName`, and call `setExpanded(!cell.expanded)` on a
  specific one, then `tui.requestRender()`. Pi's global toggle never runs.
- Choosing *which* cell without a mouse requires a navigation model (a key
  that cycles through tool cells). With Q3's mouse, a click maps directly.

### Thinking cells

There's no component to call `setExpanded` on — thinking lives as anonymous
`Markdown` children inside each `AssistantMessageComponent.contentContainer`,
rebuilt on every `invalidate()` / `updateContent()`. To get per-**block**
collapse:

- Monkey-patch `AssistantMessageComponent.prototype.updateContent` to wrap
  each `thinking` block in a small collapsible component you control (re-built
  each call — fragile, and `updateContent` is called on every invalidate), or
- Replace `AssistantMessageComponent` wholesale by intercepting
  `addMessageToChat` — not exposed by the extension API; you'd be patching
  `InteractiveMode` internals.

Either approach will break on Pi upgrades.

**Lower-effort alternative:** `AssistantMessageComponent` already has a public
`setHideThinkingBlock(bool)` (assistant-message.js). Toggling that per
message instance gives per-**message** (not per-block) thinking collapse with
no patching — collapse one message's thinking without affecting others. If
per-message granularity is acceptable, take this path.

---

## 3. Mouse support — Already done for scroll/select/copy; extending to click actions is incremental

The compositor already enables SGR mouse reporting
(`enableMouseReporting()`), parses packets (`parseSgrMousePackets`), and
hit-tests clicks into `"root"` vs `"cluster"` areas via
`selectionLocationForPacket`. So the plumbing is proven. New interactions are
incremental:

- Add deferred click handling in `handleMousePacket`: record a candidate on
  `isLeftPress`, cancel it when drag movement occurs, and invoke the action on
  release only if it remained a click. The current press handler immediately
  starts text selection, so a press cannot safely be treated as a click yet.
  Map `packet.row` → `visibleRootStart + packet.row - 1` → a root-line index →
  its component, then call `setExpanded` (tool) or `setHideThinkingBlock`
  (thinking).
- The missing primitive is **line→component mapping**. Pi's root render is a
  flat concatenation; to get per-child ranges you need to render
  `chatContainer.children` individually and accumulate
  `child.render(width).length`. Include the root prefix before `chatContainer`,
  use stable component identities, and cache the result alongside
  `visibleRootLines`. Order O(children) per render — fine for chat scrollback
  sizes.

**Pitfalls:**

- SGR 1006 mouse gives you `(row, col)` in alternate-screen coordinates —
  exactly what your hit-test already uses. No coordinate conversion needed.
- Suppress the click→selection fallback when you consume a click as a toggle.
  Currently every left press starts a selection; distinguish click vs. drag by
  requiring drag movement (you already gate drag via `isLeftDrag`).
- Keep `pauseMouseReportingForContextMenu` so right-click still works on
  terminals that steal the right button.

---

## 4. Preserve relative line position when toggling collapse — Feasible, but coupled to Q2/Q3

Today the compositor does **not** preserve position on collapse. In
`refreshRootWindow`:

```ts
if (this.scrollOffset > 0 && this.lastRootLineCount > 0 &&
    lines.length > this.lastRootLineCount) {
    this.scrollOffset += lines.length - this.lastRootLineCount;
}
```

This only adjusts when content **grows**. When a collapse shrinks `rootLines`,
`maxScrollOffset` is recomputed and `scrollOffset` is clamped — but with no
notion of *where* the removed lines were, so a scrolled-up viewport jumps.

To keep a line at the same screen row you need to know which line disappeared
where. That requires per-child line accounting — the **same** line→component
map from Q3:

1. Before the collapse, record an anchor: the `chatContainer` child at the
   top of the viewport (`visibleRootStart`) and its line count.
2. After `refreshRootWindow` recomputes `rootLines`, re-render children
   individually to get the new cumulative offsets, find the same child, and
   set `scrollOffset` so that child's first line is still at the same screen
   row.
3. Compute the desired top-line index from the anchor's new absolute position,
   then derive the bottom-relative offset used by this compositor:
   `scrollOffset = newLineCount - viewportRows - desiredStart`, clamped to
   `[0, maxScrollOffset]`. Do not assume an offset direction: with the current
   `start = lineCount - rows - scrollOffset` formula, unchanged offset already
   preserves the screen position when removed lines were above the viewport.

This is independent of Pi's snap-to-bottom precisely because `doRender` is
bypassed — Pi's `previousViewportTop` logic never runs in this path. The one
wrinkle: `setToolsExpanded` / `rebuildChatFromMessages` trigger Pi's
`requestRender`, which the patched `doRender` routes into
`renderScrollableRoot` → `refreshRootWindow`. Anchor bookkeeping has to happen
across that boundary, so keep the anchor state on the compositor and snapshot
it at the start of each `renderScrollableRoot` when a toggle is pending.

**Heuristic fallback** if per-child mapping is too heavy: only preserve position
when the collapsed component is the one currently focused by the user's last
click (Q3 gives you that for free) — adjust `scrollOffset` by the component's
pre-collapse height delta. Cheaper, and usually what users mean by "keep my
place."

---

## Summary

| Want | Feasible? | Effort | Couples to |
|---|---|---|---|
| 1. Center editor on new session | Yes | Medium–high | Shared frame layout |
| 2. Per-cell tool collapse | Yes | Medium | Q3 (for click targeting) or a nav key |
| 2. Per-cell thinking collapse | Per-message: yes, use existing `setHideThinkingBlock`. Per-block: yes, but brittle prototype-patch | High (per-block) | — |
| 3. Mouse support | Already partly done; click-to-act is incremental | Medium | Line→component map |
| 4. Keep relative line position on collapse | Yes, and this architecture enables it where Pi can't | Medium | Same line→component map as Q3 |

### The shared enabler

The single piece of infrastructure that unlocks Q2 (tool), Q3 (click actions),
and Q4 (stability) is **maintaining a per-child line-offset map of
`chatContainer` during the render pass**:

```
childIndex → { component, startLine, lineCount }
```

Build it once per `refreshRootWindow` (include the root prefix, then iterate
`chatContainer.children`, render each, and accumulate offsets), cache it next
to `visibleRootLines`. With
that map:

- **Q3** maps mouse `(row, col)` → component in one lookup.
- **Q2 (tool)** calls `setExpanded` on the hit component.
- **Q2 (thinking, per-message)** calls `setHideThinkingBlock` on the hit
  `AssistantMessageComponent`.
- **Q4** snapshots the anchor component before collapse, recomputes offsets
  after, and adjusts `scrollOffset` by the delta.

Everything else falls out of it.