import type { Component } from "@earendil-works/pi-tui";

/** Pi-independent contracts shared by compositor core modules. */
export interface SelectionPoint {
    line: number;
    col: number;
}

export type SelectionArea = "root" | "cluster";

export type SidebarBreakpoint = "sm" | "md" | number;

/**
 * The sidebar is a pi TUI Component tree rendered in reserved columns on
 * the right side of the terminal. The compositor calls `component.render(width)`
 * to get content lines and paints them alongside the scrollable root.
 */
export interface SidebarOptions {
    /** The sidebar's root Component (typically a Container holding built-in + extension panels). */
    component: Component;
    visible?: () => boolean;
    breakpoint?: SidebarBreakpoint;
    minWidth?: number;
    maxWidth?: number;
    widthRatio?: number;
}
