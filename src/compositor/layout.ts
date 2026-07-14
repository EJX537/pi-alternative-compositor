import type { SidebarOptions } from "./contracts.js";

const BREAKPOINT_COLUMNS = { sm: 80, md: 120 } as const;
const DEFAULT_MAIN_WIDTH = 40;
const DEFAULT_SIDEBAR_MIN_WIDTH = 24;
const DEFAULT_SIDEBAR_MAX_WIDTH = 40;
const DEFAULT_SIDEBAR_WIDTH_RATIO = 1 / 3;

export interface SidebarLayout {
    mainWidth: number;
    sidebarWidth: number;
}

/** Resolve the responsive main/sidebar split without accessing the terminal. */
export function resolveSidebarLayout(
    columns: number,
    sidebar: SidebarOptions | undefined,
): SidebarLayout {
    const physicalWidth = Math.max(1, columns);
    if (!sidebar || sidebar.visible?.() === false)
        return { mainWidth: physicalWidth, sidebarWidth: 0 };
    const breakpoint = sidebar.breakpoint ?? "md";
    const minimumColumns =
        typeof breakpoint === "number"
            ? breakpoint
            : BREAKPOINT_COLUMNS[breakpoint];
    if (physicalWidth < minimumColumns)
        return { mainWidth: physicalWidth, sidebarWidth: 0 };
    const minWidth = Math.max(1, sidebar.minWidth ?? DEFAULT_SIDEBAR_MIN_WIDTH);
    const maxWidth = Math.max(
        minWidth,
        sidebar.maxWidth ?? DEFAULT_SIDEBAR_MAX_WIDTH,
    );
    const desiredWidth = Math.floor(
        physicalWidth * (sidebar.widthRatio ?? DEFAULT_SIDEBAR_WIDTH_RATIO),
    );
    const sidebarWidth = Math.min(
        Math.max(minWidth, desiredWidth),
        maxWidth,
        Math.max(0, physicalWidth - DEFAULT_MAIN_WIDTH),
    );
    return sidebarWidth < minWidth
        ? { mainWidth: physicalWidth, sidebarWidth: 0 }
        : { mainWidth: physicalWidth - sidebarWidth, sidebarWidth };
}
