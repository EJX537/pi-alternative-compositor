# Sidebar Extension API

> **⚠️ Unstable.** This API is incidental to the compositor's internal design and may change or be removed without notice.

Other pi extensions can contribute panels to the compositor's right sidebar by adding pi TUI Components to the sidebar's Container.

## Symbol

```ts
const SIDEBAR_SYMBOL = Symbol.for("pi-fixed-editor-compositor.sidebar.v2");
```

## Interface

```ts
type SidebarRegistry = {
    readonly version: 2;

    /**
     * Add a pi TUI Component to the sidebar. It becomes a child of the
     * sidebar's Container and renders as a native pi element — no
     * wrapper, no custom render dispatch.
     */
    add(
        component: Component,
        options?: {
            id?: string;       // for dedup; auto-generated if omitted
            order?: number;    // lower values appear first (default 0)
            visible?: () => boolean;
        },
    ): () => void;

    /** Request a repaint of the sidebar. */
    requestRender(): void;

    /** Invalidate all registered Components (e.g. on theme change). */
    invalidate(): void;
};
```

## Usage

Register from `session_start`, dispose on `session_shutdown`:

```ts
import { Text } from "@earendil-works/pi-tui";

pi.on("session_start", () => {
    const registry = (
        globalThis as Record<symbol, SidebarRegistry | undefined>
    )[Symbol.for("pi-fixed-editor-compositor.sidebar.v2")];

    const dispose = registry?.add(
        new Text("Status: ready"),
        { id: "my-extension/panel", order: 20 },
    );

    pi.on("session_shutdown", () => dispose?.());
});
```

## How it works

The sidebar is a native pi TUI component tree:

```
sidebarRoot (Container)
  ├── Text("│ COMPOSITOR\n│\n│ Just to showcase…") — built-in header
  └── extensionContainer (Container from registry)
        ├── extension Component A
        ├── extension Component B
        └── …
```

- The compositor calls `sidebarRoot.render(sidebarWidth)` to get sidebar content lines. This is pi's standard `Container.render()` — it concatenates children's output.
- Extension Components are added/removed via `Container.addChild()` / `Container.removeChild()`. No wrapper, no custom render dispatch.
- The registry's `add()` stores metadata (`id`, `order`, `visible`) and rebuilds the Container's children in sorted order via `clear()` + `addChild()`.
- Visibility is checked before every `render()` call so `visible` callbacks stay current without manual refresh.
- Error isolation is handled by the compositor when painting the sidebar columns — individual Component render errors are caught there, not by wrapping Components.
