# pi-fixed-editor-compositor

A Pi TUI extension that keeps the editor fixed at the bottom, adds scrollback
selection, and provides a responsive, reserved right sidebar.

The sidebar is hidden in a new/empty session. It becomes visible after the
first agent turn and remains visible for that session unless the terminal is
narrower than the `md` breakpoint (120 columns), at which point its columns are
returned to Pi.

## Settings

Use `/compositor` to open Pi's native settings overlay and change the sidebar
setting. Disabling it immediately returns all sidebar columns to Pi; enabling
it remains subject to the session-activity and responsive-breakpoint rules
above. The setting is persisted in Pi's global `settings.json` under:

```json
{
  "compositor": {
    "enableSidebar": false
  }
}
```

## Chat interactions

- Scroll with the configured keyboard shortcuts or mouse wheel.
- Drag with the left mouse button to select and copy text.
- **Left-click** a tool output to expand or collapse that tool only.
- **Left-click** an assistant message to show or hide that message's
  thinking blocks only.
- Hover over a collapsible tool or assistant message to see a background
  highlight across the whole line.

These collapse choices are local to the compositor and are reapplied when Pi
rebuilds chat components. They do not change Pi's global tool/thinking settings.
Pi's global shortcuts (e.g. Ctrl+O) continue to work as before.

## Performance

The compositor does not render the full Pi root on every frame. It keeps the
flattened root output but maps and decorates only the visible viewport plus a
small overscan, with per-component size caching. This avoids re-rendering every
message and tool on scroll and on collapse reconciliation.

## Contributing a sidebar panel from another extension

Pi has no public extension-to-extension UI registry. This extension publishes a
versioned, process-global display-only registry once all extension factories
have loaded. Register from `session_start` (not an extension factory), and
dispose during `session_shutdown`:

```ts
const sidebarSymbol = Symbol.for("pi-fixed-editor-compositor.sidebar.v1");

type SidebarRegistry = {
  register(panel: {
    id: string;
    order?: number;
    render(width: number, rows: number): readonly string[];
    visible?: () => boolean;
  }): () => void;
};

pi.on("session_start", () => {
  const sidebar = (
    globalThis as Record<symbol, SidebarRegistry | undefined>
  )[sidebarSymbol];

  const dispose = sidebar?.register({
    id: "my-extension/status", // globally unique
    order: 20,                  // lower panels render first
    render: (width) => [`Status: ready (${width} columns)`],
  });

  pi.on("session_shutdown", () => dispose?.());
});
```

Panels are ordered by `order`, then id. A panel cannot control the sidebar's
width, input, focus, or terminal state; it supplies only lines. Individual
panel render errors are isolated so they cannot break the compositor.
