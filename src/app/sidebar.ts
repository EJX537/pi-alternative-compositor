import { renderSidebarPanels } from "./sidebar-registry.js";

export class SidebarState {
    enabled = true;
    visible = false;

    createOptions() {
        return {
            breakpoint: "md" as const,
            visible: () => this.enabled && this.visible,
            render: (width: number, rows: number): string[] => {
                const separator = "│";
                const contentWidth = Math.max(0, width - 2);
                const line = (text: string) =>
                    `${separator} ${text.slice(0, contentWidth)}`;
                const builtInLines = [
                    line("COMPOSITOR"),
                    separator,
                    line("Session active"),
                    line("PgUp/PgDn to scroll"),
                    line("Drag to select"),
                ];
                return [
                    ...builtInLines,
                    ...renderSidebarPanels(
                        width,
                        Math.max(0, rows - builtInLines.length),
                    ),
                ];
            },
        };
    }
}
