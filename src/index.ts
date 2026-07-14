import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { getSidebarRegistry } from "./app/sidebar-registry.js";
import { CompositorLifecycle } from "./app/lifecycle.js";
import { loadSettings } from "./app/settings-store.js";
import { showCompositorSettings } from "./app/settings-ui.js";
import type { TuiInternals } from "./pi/internals.js";

const WIDGET_KEY = "pi-fixed-editor-compositor-probe";

// Publish the versioned sidebar API when the extension loads.
void getSidebarRegistry();

export default function fixedEditorCompositor(pi: ExtensionAPI): void {
    const lifecycle = new CompositorLifecycle();

    pi.registerCommand("compositor", {
        description: "Open compositor settings",
        handler: async (_args, ctx) =>
            showCompositorSettings(ctx, lifecycle.sidebar, lifecycle.requestRender),
    });

    pi.on("session_start", async (event, ctx) => {
        if (ctx.mode !== "tui") return;

        lifecycle.sidebar.enabled = (await loadSettings()).enableSidebar;
        lifecycle.sidebar.visible =
            event.reason !== "new" &&
            ctx.sessionManager.getBranch().some((entry) => entry.type === "message");

        ctx.ui.setWidget(
            WIDGET_KEY,
            (tui: TUI) => {
                lifecycle.setup(ctx, tui as unknown as TuiInternals);
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
