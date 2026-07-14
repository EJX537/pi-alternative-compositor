/** Pi-independent contracts shared by compositor core modules. */
export interface SelectionPoint {
    line: number;
    col: number;
}

export type SelectionArea = "root" | "cluster";

export type SidebarBreakpoint = "sm" | "md" | number;

/** Display-only right pane contract; core never invokes terminal APIs. */
export interface SidebarOptions {
    render(width: number, rows: number): string[];
    visible?: () => boolean;
    breakpoint?: SidebarBreakpoint;
    minWidth?: number;
    maxWidth?: number;
    widthRatio?: number;
}


