# Sidebar Extension API

> **⚠️ Unstable.** This API is incidental to the compositor's internal design and may change or be removed without notice.

Other pi extensions can contribute panels to the compositor's right sidebar via a versioned, process-global symbol.

## Symbol

```ts
const SIDEBAR_SYMBOL = Symbol.for("pi-fixed-editor-compositor.sidebar.v1");
```

## Interface

```ts
type SidebarRegistry = {
    register(panel: SidebarPanel): () => void;
};

type SidebarPanel = {
    /** Globally unique, conventionally `extension-name/panel-name`. */
    id: string;
    /** Lower values appear first; ties ordered by id. */
    order?: number;
    /** Display-only lines. Compositor owns width, focus, and input. */
    render(width: number, rows: number): readonly string[];
    /** Hide panel without affecting reserved layout. */
    visible?: () => boolean;
};
```

## Usage

Register from `session_start`, dispose on `session_shutdown`:

```ts
pi.on("session_start", () => {
    const sidebar = (
        globalThis as Record<symbol, SidebarRegistry | undefined>
    )[Symbol.for("pi-fixed-editor-compositor.sidebar.v1")];

    const dispose = sidebar?.register({
        id: "my-extension/panel",
        order: 20,
        render: (width) => [`Status: ready (${width} cols)`],
    });

    pi.on("session_shutdown", () => dispose?.());
});
```

## Contract

- Panels are ordered by `order`, then `id`.
- Panels supply read-only lines. They cannot control sidebar width, input, focus, or terminal state.
- Individual panel render errors are caught and isolated.
- The `visible` callback hides a panel without releasing its layout reservation.
