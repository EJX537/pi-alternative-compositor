import type { RootComponentLineRange } from "./types.js";

// ── Types ────────────────────────────────────────────────────

export type RootViewportAnchor = {
    component: RootComponentLineRange["component"];
    lineOffset: number;
};

// ── Helpers ──────────────────────────────────────────────────

/**
 * Capture the outermost (root-level) component at the first visible line.
 * Root-level children are always in the component line ranges (the mapper
 * adds every root child unconditionally), so this anchor survives
 * collapse/expand.  Using the innermost child would be wrong because that
 * child (e.g. a tool output line) may disappear when its parent collapses,
 * leaving us without a valid anchor.
 */
export function captureRootViewportAnchor(
    rootComponentLineRanges: RootComponentLineRange[],
    visibleRootStart: number,
    scrollOffset: number,
    rootChildren: readonly unknown[],
): RootViewportAnchor | null {
    if (scrollOffset === 0) return null;

    const rootComponents = new Set<object>(
        rootChildren.filter(
            (c) => typeof c === "object" && c !== null,
        ) as object[],
    );
    const range = rootComponentLineRanges.find(
        (r) =>
            rootComponents.has(r.component as object) &&
            visibleRootStart >= r.startLine &&
            visibleRootStart < r.startLine + r.lineCount,
    );
    if (!range || range.lineCount === 0) return null;
    return {
        component: range.component,
        lineOffset: visibleRootStart - range.startLine,
    };
}

/**
 * Given a previously captured viewport anchor and the new total line count,
 * compute a scroll offset that keeps the anchored component at the same
 * screen position.  Returns `null` when the anchor is no longer valid.
 */
export function offsetForRootViewportAnchor(
    anchor: RootViewportAnchor | null,
    rootComponentLineRanges: RootComponentLineRange[],
    lineCount: number,
    viewportRows: number,
): number | null {
    if (!anchor) return null;
    const range = rootComponentLineRanges.find(
        (candidate) => candidate.component === anchor.component,
    );
    if (!range || range.lineCount === 0 || lineCount === 0) return null;

    const desiredStart = Math.min(
        lineCount - 1,
        range.startLine +
            Math.min(anchor.lineOffset, range.lineCount - 1),
    );
    return Math.max(0, lineCount - viewportRows - desiredStart);
}
