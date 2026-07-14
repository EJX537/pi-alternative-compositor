import {
    isAssistantComponent,
    isToolComponent,
    type ComponentCollapseState,
} from "./collapse.js";
import type { ComponentRangeMapper } from "./range-mapper.js";

/**
 * Compute a cheap content-length hash for a value:
 * - string → length
 * - array → length
 * - object with .content → recursive length of .content
 * - otherwise → String(value).length
 */
function contentLength(value: unknown): number {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.length;
    if (
        typeof value === "object" &&
        value !== null &&
        "content" in value
    ) {
        return contentLength((value as { content: unknown }).content);
    }
    return String(value).length;
}

// Stable object identity counter for uncached/unknown components.
const objectIds = new WeakMap<object, number>();
let nextId = 1;
function stableObjectId(obj: object): number {
    let id = objectIds.get(obj);
    if (id === undefined) {
        id = nextId++;
        objectIds.set(obj, id);
    }
    return id;
}

/**
 * Recursively build a deterministic signature for a component.
 *
 * The signature includes the component's own collapse state and content
 * fingerprint, plus the signatures of all its children.  This means that
 * collapsing a tool nested inside an assistant message changes the assistant's
 * signature, so the assistant's cached rendered lines are invalidated and the
 * viewport line count updates correctly.
 */
function signatureForComponent(
    component: unknown,
    width: number,
    collapseState: ComponentCollapseState,
    seen: WeakSet<object>,
): string {
    if (!component || typeof component !== "object") {
        return String(component);
    }
    if (seen.has(component)) {
        return "<cycle>";
    }
    seen.add(component);

    const parts: string[] = [];
    if (isToolComponent(component)) {
        parts.push(
            "tool",
            component.toolCallId,
            component.toolName,
            String(collapseState.isCollapsed(component)),
            String(contentLength(component)),
        );
    } else if (isAssistantComponent(component)) {
        parts.push(
            "assistant",
            String(stableObjectId(component.lastMessage)),
            String(collapseState.isCollapsed(component)),
            String(contentLength(component.lastMessage)),
        );
    } else {
        parts.push("unknown", String(stableObjectId(component)));
    }

    parts.push(String(width));

    const children = (component as { children?: unknown }).children;
    if (Array.isArray(children)) {
        for (const child of children) {
            parts.push(
                signatureForComponent(child, width, collapseState, seen),
            );
        }
    } else if (children && typeof children === "object") {
        parts.push(
            signatureForComponent(children, width, collapseState, seen),
        );
    }

    // Do NOT delete from `seen`: a component may appear multiple times in
    // its own descendant tree (shared children), and removing it here would
    // defeat cycle detection for those paths.
    return parts.join("|");
}

function signatureForChild(
    component: object,
    width: number,
    collapseState: ComponentCollapseState,
): string {
    return signatureForComponent(component, width, collapseState, new WeakSet());
}

// ── Cached entry ─────────────────────────────────────────────

interface CachedEntry {
    lines: string[];
    signature: string;
}

// ── Exports ──────────────────────────────────────────────────

/**
 * Per-child root-render cache that avoids re-rendering components when
 * their signature (identity + collapse state + content length + descendants)
 * is unchanged.
 */
export class ChildRenderCache {
    private readonly cache = new Map<object, CachedEntry>();

    /**
     * Render (or reuse) children, recording line counts into `rangeMapper`.
     *
     * @returns The composed lines and whether any child was actually re-rendered.
     */
    render(
        children: readonly unknown[],
        width: number,
        collapseState: ComponentCollapseState,
        rangeMapper: ComponentRangeMapper,
    ): { lines: string[]; changed: boolean } {
        let changed = false;
        const allLines: string[] = [];
        const seen = new Set<object>();

        for (const child of children) {
            if (!this.isRenderable(child)) continue;
            const component = child as object;
            seen.add(component);

            const signature = signatureForChild(component, width, collapseState);
            const cached = this.cache.get(component);

            let lines: string[];
            if (cached && cached.signature === signature) {
                // Reuse cached lines.
                lines = cached.lines;
            } else {
                // Render and cache.
                lines = (
                    component as { render: (w: number) => string[] }
                ).render(width);
                this.cache.set(component, {
                    lines,
                    signature,
                });
                changed = true;
            }
            for (let i = 0; i < lines.length; i++) {
                allLines.push(lines[i]);
            }
            rangeMapper.seedLines(component, width, lines);
        }

        // Evict cache entries for components no longer in children.
        for (const key of this.cache.keys()) {
            if (!seen.has(key)) {
                this.cache.delete(key);
            }
        }

        return { lines: allLines, changed };
    }

    /** Drop all cached entries (e.g. on width change). */
    clear(): void {
        this.cache.clear();
    }

    /** Remove a single component from the cache. */
    invalidate(component: object): void {
        this.cache.delete(component);
    }

    /** Return cached lines for a component, or null if not cached. */
    getCachedLines(component: object): string[] | null {
        const entry = this.cache.get(component);
        return entry ? entry.lines : null;
    }

    private isRenderable(value: unknown): boolean {
        return (
            typeof value === "object" &&
            value !== null &&
            typeof (value as { render?: (w: number) => string[] }).render ===
                "function"
        );
    }
}
