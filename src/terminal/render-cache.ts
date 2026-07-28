import { CollapseController } from "../collapse/collapse-controller.js";
import {
    isAssistantComponent,
    isToolComponent,
} from "../collapse/types.js";
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
 * Bernstein (djb2) hash — combines a string into an existing hash state.
 * Returns a 32-bit signed integer (via `| 0`).
 */
function hashString(h: number, s: string): number {
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return h;
}

/**
 * Combine a numeric value into an existing hash state (avoids string
 * conversion for child hashes which are already numbers).
 */
function hashNumber(h: number, n: number): number {
    return ((h << 5) - h + n) | 0;
}

/**
 * Recursively build a deterministic 32-bit hash signature for a component.
 *
 * The hash includes the component's own collapse state and content
 * fingerprint, plus the hashes of all its children.  This means that
 * collapsing a tool nested inside an assistant message changes the assistant's
 * hash, so the assistant's cached rendered lines are invalidated and the
 * viewport line count updates correctly.
 *
 * Using a numeric hash instead of a string signature eliminates the
 * per-component string-allocation overhead (the old `parts.join("|")`)
 * while maintaining the same change-detection semantics.
 */
function signatureForComponent(
    component: unknown,
    width: number,
    collapseState: CollapseController,
    seen: WeakSet<object>,
): number {
    if (!component || typeof component !== "object") {
        return hashString(0, String(component));
    }
    if (seen.has(component)) {
        return hashString(0, "<cycle>");
    }
    seen.add(component);

    let h = 0;
    if (isToolComponent(component)) {
        h = hashString(h, "tool");
        h = hashString(h, component.toolCallId);
        h = hashString(h, component.toolName);
        h = hashString(h, String(collapseState.isCollapsed(component)));
        h = hashString(h, String(contentLength(component)));
    } else if (isAssistantComponent(component)) {
        h = hashString(h, "assistant");
        h = hashString(h, String(stableObjectId(component.lastMessage)));
        h = hashString(h, String(collapseState.isCollapsed(component)));
        h = hashString(h, String(contentLength(component.lastMessage)));
    } else {
        // Include `text` (Text/Loader components) or `content`
        // (generic components) so content changes bust the render
        // cache.  Without this, animated components like the
        // CompactionStatusIndicator spinner never refresh because
        // stableObjectId + width don't change when the spinner
        // frame cycles.
        const textContent =
            (component as { text?: unknown }).text ??
            (component as { content?: unknown }).content;
        h = hashString(h, "unknown");
        h = hashString(h, String(stableObjectId(component)));
        h = hashString(h, String(textContent));
    }

    h = hashString(h, String(width));

    const children = (component as { children?: unknown }).children;
    if (Array.isArray(children)) {
        for (const child of children) {
            h = hashNumber(h, signatureForComponent(child, width, collapseState, seen));
        }
    } else if (children && typeof children === "object") {
        h = hashNumber(h, signatureForComponent(children, width, collapseState, seen));
    }

    // Do NOT delete from `seen`: a component may appear multiple times in
    // its own descendant tree (shared children), and removing it here would
    // defeat cycle detection for those paths.
    return h;
}

function signatureForChild(
    component: object,
    width: number,
    collapseState: CollapseController,
): number {
    return signatureForComponent(component, width, collapseState, new WeakSet());
}

// ── Cached entry ─────────────────────────────────────────────

interface CachedEntry {
    lines: string[];
    /** 32-bit hash of the component's full recursive state */
    signature: number;
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
     * @returns The composed lines, whether any child was re-rendered, and a
     *          set of components whose content actually changed (cache-miss).
     */
    render(
        children: readonly unknown[],
        width: number,
        collapseState: CollapseController,
        rangeMapper: ComponentRangeMapper,
    ): { lines: string[]; changed: boolean; changedComponents: Set<object> } {
        let changed = false;
        const changedComponents = new Set<object>();
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
                changedComponents.add(component);
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

        return { lines: allLines, changed, changedComponents };
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
