import type { RootComponentLineRange } from "./types.js";

type Renderable = {
    render?: (width: number) => string[];
    children?: unknown[];
};

type RenderableContainer = Renderable & {
    children?: Renderable[];
};

type CachedSize = {
    width: number;
    lineCount: number;
    lines?: string[];
};

/**
 * Builds component-to-root-line mappings with caching and viewport windowing.
 *
 * Pi still produces the full flattened root output, but this mapper avoids
 * re-rendering every child on every frame. It caches per-component line counts
 * and only renders children that intersect the visible window plus overscan.
 */
export class ComponentRangeMapper {
    private cache = new WeakMap<object, CachedSize>();
    private lastWidth = -1;

    clear(): void {
        this.cache = new WeakMap();
        this.lastWidth = -1;
    }

    setWidth(width: number): void {
        if (width !== this.lastWidth) {
            this.clear();
            this.lastWidth = width;
        }
    }

    invalidateComponent(component: object): void {
        this.cache.delete(component);
    }

    /**
     * Pre-populate the rendered lines for a component. Used by the render cache
     * so the range mapper can locate child components inside a parent's output
     * without re-rendering it.
     */
    seedLines(component: object, width: number, lines: string[]): void {
        this.lastWidth = width;
        this.cache.set(component, { width, lineCount: lines.length, lines });
    }

    /**
     * Map root children to absolute root line ranges, but only for components
     * inside [windowStart, windowEnd] plus overscan. Components outside the
     * window use cached sizes to compute absolute positions without rendering.
     */
    buildRanges(
        roots: readonly unknown[],
        width: number,
        windowStart: number,
        windowEnd: number,
        overscan: number,
    ): RootComponentLineRange[] {
        this.setWidth(width);
        const ranges: RootComponentLineRange[] = [];
        let startLine = 0;
        const minLine = Math.max(0, windowStart - overscan);
        const maxLine = windowEnd + overscan;

        for (const component of roots) {
            if (!this.isRenderable(component)) continue;
            const lines = this.getLines(component, width);
            const lineCount = lines.length;
            const endLine = startLine + lineCount;
            // Always keep root-child ranges so the compositor can locate any
            // top-level component for collapse anchoring and hit-testing.
            ranges.push({ component, startLine, lineCount });
            if (endLine > minLine && startLine < maxLine) {
                this.appendDescendants(
                    ranges,
                    component,
                    lines,
                    startLine,
                    width,
                    minLine,
                    maxLine,
                );
            }
            startLine = endLine;
        }
        return ranges;
    }

    private appendDescendants(
        ranges: RootComponentLineRange[],
        parent: object,
        parentLines: string[],
        parentStart: number,
        width: number,
        minLine: number,
        maxLine: number,
    ): void {
        const children = (parent as RenderableContainer).children;
        if (!Array.isArray(children) || children.length === 0) return;

        const rendered: { component: object; lines: string[] }[] = [];
        for (const child of children) {
            if (!this.isRenderable(child)) continue;
            rendered.push({ component: child, lines: this.getLines(child, width) });
        }
        if (rendered.length === 0) return;

        // Fast path: the parent's output is exactly the concatenation of its
        // renderable children. This is common for pure Container components.
        const concatenatedLength = rendered.reduce(
            (sum, { lines }) => sum + lines.length,
            0,
        );
        let fastPathOffset = 0;
        const canUseFastPath =
            concatenatedLength === parentLines.length &&
            rendered.every(({ lines }) => {
                const offset = fastPathOffset;
                fastPathOffset += lines.length;
                return lines.every(
                    (line, i) => line === parentLines[offset + i],
                );
            });

        let searchFrom = 0;
        for (const { component, lines } of rendered) {
            const lineCount = lines.length;
            let childStart: number;
            if (canUseFastPath) {
                childStart = parentStart + searchFrom;
            } else {
                const found = this.findLineSubsequence(
                    parentLines,
                    lines,
                    searchFrom,
                );
                if (found === -1) {
                    // Cannot reliably locate this child; skip it and any
                    // subsequent children that overlap the same region.
                    continue;
                }
                childStart = parentStart + found;
            }
            const endLine = childStart + lineCount;
            if (endLine > minLine && childStart < maxLine) {
                ranges.push({
                    component,
                    startLine: childStart,
                    lineCount,
                });
                this.appendDescendants(
                    ranges,
                    component,
                    lines,
                    childStart,
                    width,
                    minLine,
                    maxLine,
                );
            }
            searchFrom = canUseFastPath
                ? searchFrom + lineCount
                : Math.max(searchFrom, childStart - parentStart + lineCount);
        }
    }

    private findLineSubsequence(
        haystack: string[],
        needle: string[],
        startIndex: number,
    ): number {
        if (needle.length === 0) return startIndex;
        if (needle.length > haystack.length - startIndex) return -1;
        for (let i = startIndex; i <= haystack.length - needle.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
                if (haystack[i + j] !== needle[j]) {
                    match = false;
                    break;
                }
            }
            if (match) return i;
        }
        return -1;
    }

    private getLines(component: Renderable, width: number): string[] {
        const cached = this.cache.get(component);
        if (cached && cached.width === width && cached.lines) {
            return cached.lines;
        }
        const lines = component.render!(width);
        this.cache.set(component, { width, lineCount: lines.length, lines });
        return lines;
    }

    private isRenderable(value: unknown): value is Renderable {
        return (
            typeof value === "object" &&
            value !== null &&
            typeof (value as Renderable).render === "function"
        );
    }
}
