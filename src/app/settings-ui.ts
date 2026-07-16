import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveSettings } from "./settings-store.js";
import type { SidebarState } from "./sidebar.js";

export async function showCompositorSettings(
    ctx: ExtensionCommandContext,
    sidebar: SidebarState,
    requestRender: () => void,
): Promise<void> {
    // Work on a local copy so visual changes (sidebar layout, mainWidth)
    // don't take effect during the dialog interaction.  Toggling mid-dialog
    // causes the cluster (input bar) to be cleared and redrawn at a
    // different width, which flickers for one frame between dialog
    // close and reopen.  Flush and schedule a render when "Done" is selected.
    let pendingEnabled = sidebar.enabled;

    while (true) {
        const choices = [
            `Toggle sidebar (currently ${pendingEnabled ? "on" : "off"})`,
            "Done",
        ];

        const choice = await ctx.ui.select("Compositor Settings", choices);
        if (!choice || choice === "Done") {
            // Flush pending changes to the live sidebar state.
            // Pi's overlay-removal render happened inside ctx.ui.select
            // (before we got here) and used the old sidebar.enabled, so
            // we must trigger a fresh compositor repaint now.
            if (pendingEnabled !== sidebar.enabled) {
                sidebar.enabled = pendingEnabled;
                requestRender();
                try {
                    await saveSettings({ enableSidebar: sidebar.enabled });
                } catch {
                    ctx.ui.notify("Could not save compositor settings.", "error");
                }
            }
            return;
        }

        pendingEnabled = !pendingEnabled;
    }
}
