import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { getSidebarRegistry } from "./app/sidebar-registry.js";
import { CompositorLifecycle } from "./app/lifecycle.js";
import { loadSettingsSync } from "./app/settings-store.js";
import { showCompositorSettings } from "./app/settings-ui.js";
import type { TuiInternals } from "./pi/internals.js";

const WIDGET_KEY = "pi-fixed-editor-compositor-probe";

// Publish the versioned sidebar API when the extension loads.
void getSidebarRegistry();

export default function fixedEditorCompositor(pi: ExtensionAPI): void {
    const lifecycle = new CompositorLifecycle();

    // Cache the TUI reference so we can install the compositor synchronously
    // on session_start for /resume /reload /fork — before Pi's first render
    // paints native elements without the compositor intercepting them.
    let cachedTui: TuiInternals | null = null;

    pi.registerCommand("compositor", {
        description: "Open compositor settings",
        handler: async (_args, ctx) =>
            showCompositorSettings(ctx, lifecycle.sidebar, lifecycle.requestRender),
    });

    pi.on("session_start", (event, ctx) => {
        if (ctx.mode !== "tui") return;

        const settings = loadSettingsSync();
        lifecycle.sidebar.enabled = settings.enableSidebar;
        lifecycle.sidebar.visible =
            lifecycle.sidebar.enabled &&
            event.reason !== "new" &&
            ctx.sessionManager.getBranch().some((entry) => entry.type === "message");

        // Session switch: install compositor NOW using cached TUI, before
        // Pi processes any renders for the new session.  The widget callback
        // below will fire later and become a no-op (setup returns early).
        if (cachedTui && event.reason !== "new") {
            lifecycle.setup(ctx, cachedTui);
        }

        ctx.ui.setWidget(
            WIDGET_KEY,
            (tui: TUI) => {
                const tuiInternals = tui as unknown as TuiInternals;
                if (!cachedTui) cachedTui = tuiInternals;
                lifecycle.setup(ctx, tuiInternals);
                return { render: () => [], invalidate: () => {} };
            },
            { placement: "aboveEditor" },
        );
    });

    pi.on("agent_start", () => lifecycle.setSidebarVisible(true));

    pi.on("session_shutdown", (event, ctx) => {
        if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
        lifecycle.teardown(event.reason === "quit", event.reason);
    });
}
