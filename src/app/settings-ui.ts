import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveSettings } from "./settings-store.js";
import type { SidebarState } from "./sidebar.js";

export async function showCompositorSettings(
    ctx: ExtensionCommandContext,
    sidebar: SidebarState,
    requestRender: () => void,
): Promise<void> {
    while (true) {
        const choices = [
            `Toggle sidebar (currently ${sidebar.enabled ? "on" : "off"})`,
            "Done",
        ];

        const choice = await ctx.ui.select("Compositor Settings", choices);
        if (!choice || choice === "Done") return;

        sidebar.enabled = !sidebar.enabled;
        requestRender();

        try {
            await saveSettings({ enableSidebar: sidebar.enabled });
        } catch {
            ctx.ui.notify("Could not save compositor settings.", "error");
        }
    }
}
