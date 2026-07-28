import { Container, type Component } from "@earendil-works/pi-tui";

export const SIDEBAR_API_SYMBOL = Symbol.for(
    "pi-fixed-editor-compositor.sidebar.v2",
);

export interface SidebarRegistry {
    readonly version: 2;
    /**
     * Add a pi TUI Component to the sidebar. It becomes a child of the
     * sidebar's Container and renders as a native pi element — no
     * wrapper, no custom render dispatch.
     *
     * Returns a dispose function.
     */
    add(
        component: Component,
        options?: {
            /** For dedup and cleanup. Auto-generated if omitted. */
            id?: string;
            /** Lower values appear first (default 0). */
            order?: number;
            /** Hide without affecting layout reservation. */
            visible?: () => boolean;
        },
    ): () => void;
    /** Request a repaint of the sidebar. */
    requestRender(): void;
    /** Invalidate all registered Components (e.g. on theme change). */
    invalidate(): void;
}

interface Entry {
    component: Component;
    order: number;
    visible: () => boolean;
}

interface SidebarRegistryState extends SidebarRegistry {
    entries: Map<string, Entry>;
    onRequestRender: (() => void) | null;
}

type SidebarGlobal = typeof globalThis & {
    [SIDEBAR_API_SYMBOL]?: SidebarRegistryState;
};

let nextId = 0;
function generateId(): string {
    return `__sidebar_${++nextId}`;
}

// ── Extension container ──────────────────────────────────────
// Singleton Container that holds extension-registered Components.
// On every render() it rebuilds its children to reflect current
// visibility and sort order — no stale state between frames.

const EXT_CONTAINER_KEY = "__pi_sidebar_ext_container";

function rebuildChildren(entries: Map<string, Entry>): void {
    const container = getExtensionContainer();
    container.clear();
    const sorted = [...entries.values()]
        .filter((e) => e.visible())
        .sort((a, b) => a.order - b.order || generateId().localeCompare(generateId()));
    for (const entry of sorted) {
        container.addChild(entry.component);
    }
}

function getExtensionContainer(): Container {
    const g = globalThis as unknown as Record<string, Container | undefined>;
    if (!g[EXT_CONTAINER_KEY]) {
        g[EXT_CONTAINER_KEY] = new (class extends Container {
            render(width: number): string[] {
                rebuildChildren(getState().entries);
                return super.render(width);
            }
        })();
    }
    return g[EXT_CONTAINER_KEY]!;
}

export { getExtensionContainer as getSidebarContainer };

function getState(): SidebarRegistryState {
    return getSidebarRegistry() as SidebarRegistryState;
}

// ── Registry ─────────────────────────────────────────────────

export function getSidebarRegistry(): SidebarRegistry {
    const global = globalThis as SidebarGlobal;
    const existing = global[SIDEBAR_API_SYMBOL];
    if (existing) return existing;

    const state: SidebarRegistryState = {
        version: 2,
        entries: new Map(),
        onRequestRender: null,
        add(component, options) {
            const id = options?.id ?? generateId();
            if (state.entries.has(id)) {
                throw new Error(`Sidebar component already registered: ${id}`);
            }
            const entry: Entry = {
                component,
                order: options?.order ?? 0,
                visible: options?.visible ?? (() => true),
            };
            state.entries.set(id, entry);
            rebuildChildren(state.entries);
            state.requestRender();

            let disposed = false;
            return () => {
                if (disposed) return;
                disposed = true;
                if (state.entries.get(id) !== entry) return;
                state.entries.delete(id);
                rebuildChildren(state.entries);
                state.requestRender();
            };
        },
        requestRender() {
            state.onRequestRender?.();
        },
        invalidate() {
            for (const entry of state.entries.values()) {
                try {
                    entry.component.invalidate();
                } catch {
                    // A broken Component must not break the compositor.
                }
            }
        },
    };
    global[SIDEBAR_API_SYMBOL] = state;
    return state;
}

/** Internal compositor hook: attach repainting for the current TUI session. */
export function setSidebarRequestRender(
    onRequestRender: (() => void) | null,
): void {
    const state = getState();
    state.onRequestRender = onRequestRender;
}

/** Remove session-scoped entries and their repaint hook on teardown. */
export function resetSidebarRegistry(): void {
    const state = getState();
    state.entries.clear();
    const c = (globalThis as unknown as Record<string, Container | undefined>)[EXT_CONTAINER_KEY];
    if (c) c.children = [];
    state.onRequestRender = null;
}
