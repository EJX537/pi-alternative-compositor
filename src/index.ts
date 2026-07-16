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

    pi.registerCommand("compositor", {
        description: "Open compositor settings",
        handler: async (_args, ctx) =>
            showCompositorSettings(ctx, lifecycle.sidebar, lifecycle.requestRender),
    });

    pi.on("session_start", (event, ctx) => {
        if (ctx.mode !== "tui") return;

        // Load settings synchronously before registering the widget.  The
        // compositor must be installed on the very next Pi render so it can
        // take over the screen; an async settings load here would leave a
        // window where the sidebar could flash on /resume before settings
        // resolved.
        const settings = loadSettingsSync();
        lifecycle.sidebar.enabled = settings.enableSidebar;
        lifecycle.sidebar.visible =
            lifecycle.sidebar.enabled &&
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

        // Note: pi-coding-agent renders one default-pi frame before
        // session_start fires (see interactive-mode.js ui.start() before
        // rebindCurrentSession()). That one-frame flash can only be fixed
        // upstream; the compositor's install sequence clears the screen as
        // soon as it is loaded.
    });

    pi.on("agent_start", () => lifecycle.setSidebarVisible(true));

    pi.on("session_shutdown", (event, ctx) => {
        if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
        lifecycle.teardown(event.reason === "quit", event.reason);
    });
}
