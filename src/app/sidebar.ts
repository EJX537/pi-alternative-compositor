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
                    line("Just to showcase its possible"),
                    separator,
                    line("Originally intended to copy what"),
                    line("OpenCode displays here but I don't"),
                    line("actually read is so (idk)"),
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
