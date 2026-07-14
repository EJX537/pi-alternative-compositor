export const SIDEBAR_API_SYMBOL = Symbol.for(
    "pi-fixed-editor-compositor.sidebar.v1",
);

export interface SidebarPanel {
    /** Globally unique, conventionally `extension-name/panel-name`. */
    id: string;
    /** Lower values appear first; ties are ordered by id. */
    order?: number;
    /** Display-only lines. The compositor owns width, focus, and input. */
    render(width: number, rows: number): readonly string[];
    /** Hide this panel without affecting the sidebar's reserved layout. */
    visible?: () => boolean;
}

export interface SidebarRegistry {
    readonly version: 1;
    register(panel: SidebarPanel): () => void;
    requestRender(): void;
}

interface SidebarRegistryState extends SidebarRegistry {
    panels: Map<string, SidebarPanel>;
    onRequestRender: (() => void) | null;
}

type SidebarGlobal = typeof globalThis & {
    [SIDEBAR_API_SYMBOL]?: SidebarRegistryState;
};

function validatePanel(panel: SidebarPanel): void {
    if (!panel.id.trim()) throw new Error("Sidebar panel id must not be empty");
}

export function getSidebarRegistry(): SidebarRegistry {
    const global = globalThis as SidebarGlobal;
    const existing = global[SIDEBAR_API_SYMBOL];
    if (existing) return existing;

    const state: SidebarRegistryState = {
        version: 1,
        panels: new Map(),
        onRequestRender: null,
        register(panel) {
            validatePanel(panel);
            if (state.panels.has(panel.id)) {
                throw new Error(`Sidebar panel already registered: ${panel.id}`);
            }
            state.panels.set(panel.id, panel);
            state.requestRender();

            let disposed = false;
            return () => {
                if (disposed) return;
                disposed = true;
                if (state.panels.get(panel.id) !== panel) return;
                state.panels.delete(panel.id);
                state.requestRender();
            };
        },
        requestRender() {
            state.onRequestRender?.();
        },
    };
    global[SIDEBAR_API_SYMBOL] = state;
    return state;
}

function getState(): SidebarRegistryState {
    return getSidebarRegistry() as SidebarRegistryState;
}

/** Internal compositor hook: attach repainting for the current TUI session. */
export function setSidebarRequestRender(
    onRequestRender: (() => void) | null,
): void {
    const state = getState();
    state.onRequestRender = onRequestRender;
}

/** Render registered panels in deterministic order without trusting them. */
export function renderSidebarPanels(width: number, rows: number): string[] {
    const panels = [...getState().panels.values()].toSorted(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
    );
    const lines: string[] = [];
    for (const panel of panels) {
        if (panel.visible?.() === false) continue;
        try {
            lines.push(...panel.render(width, Math.max(0, rows - lines.length)));
        } catch {
            // An optional extension panel must not break terminal rendering.
        }
        if (lines.length >= rows) break;
    }
    return lines.slice(0, rows);
}

/** Remove session-scoped panels and their repaint hook on teardown. */
export function resetSidebarRegistry(): void {
    const state = getState();
    state.panels.clear();
    state.onRequestRender = null;
}
