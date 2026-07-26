/**
 * Component-level collapse controller.
 *
 * Manages per-cell collapse/expand overrides by patching pi's own
 * `setExpanded` / `setHideThinkingBlock` methods so they respect
 * our per-cell choices instead of only pi's global toggle.
 *
 * ## Design (vs the old TUI-level approach)
 *
 * **Old approach** (`ComponentCollapseState`, in the TUI layer):
 *   Called `setExpanded()`/`setHideThinkingBlock()` directly, then
 *   fought pi's reconciliation with `snapshotCollapseState()` →
 *   `reconcile()` → `consumeGlobalToggle()` cycles.
 *
 * **This approach** (component-level):
 *   Patches `setExpanded()` / `setHideThinkingBlock()` on each
 *   collapsible component so that when pi calls them (e.g. global
 *   keyboard shortcut, reconciliation after streaming), the patch
 *   ignores the call if we have a per-cell override.  Our override
 *   — keyed by `toolCallId` / `message.id` — always wins.
 *
 * Pi's own rendering pipeline handles the actual collapse rendering
 * (shorter tool output, hidden thinking block).  No render wrapping,
 * no header-line heuristics, no thinking-child tree walking.
 */

import {
    isToolComponent,
    isAssistantComponent,
    isCollapsibleComponent as isCompCollapsible,
    type ToolComponent,
    type AssistantComponent,
} from "./types.js";

// Stable object identity for fallback assistant keying.
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

export class CollapseController {
    /**
     * Per-component collapsed-state overrides, keyed by stable identity.
     * - Tools: keyed by `toolCallId` (string) — survives Pi rebuilds.
     * - Assistants: keyed by `responseId ?? id ?? stableObjectId(message)`
     *   — survives Pi rebuilds when the response id is stable.
     * - `true` → collapsed (tool hidden / thinking hidden)
     * - `false` → expanded
     * - absent → defer to pi's native state
     */
    private toolOverrides = new Map<string, boolean>();
    private assistantOverrides = new Map<string | object, boolean>();

    /** Components whose setExpanded/setHideThinkingBlock is patched. */
    private patched = new WeakSet<object>();

    /**
     * Most recent explicit toggle, consumed by the TUI render engine for
     * viewport anchoring.  `startLine` is the absolute root line where
     * the user clicked.
     */
    private _lastToggle: {
        component: object;
        collapsed: boolean;
        startLine: number;
    } | null = null;

    // ── Key helpers ──────────────────────────────────────────

    private toolKey(tool: ToolComponent): string {
        return tool.toolCallId;
    }

    private assistantKey(comp: AssistantComponent): string | object {
        const m = comp.lastMessage;
        return m.responseId ?? m.id ?? String(stableObjectId(m));
    }

    // ── Toggle API ───────────────────────────────────────────

    /**
     * Toggle a tool component's collapsed state.
     * Calls `setExpanded()` so pi handles the rendering; the patched
     * `setExpanded` defers to our override on subsequent pi calls.
     */
    toggleTool(tool: unknown, clickLine: number): boolean {
        if (!isToolComponent(tool)) return false;

        const key = this.toolKey(tool);
        const current = this.toolOverrides.get(key);
        const isCurrentlyCollapsed =
            current !== undefined
                ? current
                : !(tool.expanded ?? true);
        const nextCollapsed = !isCurrentlyCollapsed;

        // Patch BEFORE toggling so pi can't override us afterward.
        if (!this.patched.has(tool)) this.patchTool(tool);

        // Call pi's native setExpanded FIRST, then set our override.
        // The patch lets through calls that happen before the override is set.
        // (We use origSetExpanded to bypass the patch for this initial call.)
        this.origSetExpandedFor(tool, !nextCollapsed);
        this.toolOverrides.set(key, nextCollapsed);
        this._lastToggle = {
            component: tool,
            collapsed: nextCollapsed,
            startLine: clickLine,
        };
        return true;
    }

    /**
     * Toggle an assistant component's thinking-block visibility.
     * Calls `setHideThinkingBlock()` so pi handles rendering.
     */
    toggleAssistant(comp: unknown, clickLine: number): boolean {
        if (!isAssistantComponent(comp)) return false;

        const key = this.assistantKey(comp);
        const current = this.assistantOverrides.get(key);
        const isCurrentlyCollapsed =
            current !== undefined
                ? current
                : (comp.hideThinkingBlock ?? false);
        const nextCollapsed = !isCurrentlyCollapsed;

        if (!this.patched.has(comp)) this.patchAssistant(comp);

        this.origSetHideFor(comp, nextCollapsed);
        this.assistantOverrides.set(key, nextCollapsed);
        this._lastToggle = {
            component: comp,
            collapsed: nextCollapsed,
            startLine: clickLine,
        };
        return true;
    }

    /** Toggle whichever collapsible component `comp` is. */
    toggle(comp: unknown, clickLine: number): boolean {
        return (
            this.toggleTool(comp, clickLine) ||
            this.toggleAssistant(comp, clickLine)
        );
    }

    // ── State queries ────────────────────────────────────────

    /**
     * Return the effective collapsed state of a component.
     * Override takes precedence over pi's stored property.
     */
    isCollapsed(component: unknown): boolean | null {
        if (isToolComponent(component)) {
            const key = this.toolKey(component);
            const o = this.toolOverrides.get(key);
            return o !== undefined ? o : !(component.expanded ?? true);
        }
        if (isAssistantComponent(component)) {
            const key = this.assistantKey(component);
            const o = this.assistantOverrides.get(key);
            return o !== undefined ? o : (component.hideThinkingBlock ?? false);
        }
        return null;
    }

    isCollapsibleComponent(component: unknown): boolean {
        return isCompCollapsible(component);
    }

    // ── Last-toggle (for TUI-layer viewport anchoring) ───────

    consumeLastToggle(): {
        component: object;
        collapsed: boolean;
        startLine: number;
    } | null {
        const t = this._lastToggle;
        this._lastToggle = null;
        return t;
    }

    get hasPendingToggle(): boolean {
        return this._lastToggle !== null;
    }

    // ── Patch setExpanded / setHideThinkingBlock ─────────────

    /**
     * Patch a tool's `setExpanded` so that if we have a per-cell
     * override for this tool, pi's calls to `setExpanded` are
     * ignored.  Without an override, passthrough to pi normally.
     *
     * This means:
     * - User clicks to collapse → `toggleTool()` calls our override
     *   AND `setExpanded(false)` → tool renders collapsed.
     * - Pi does a global collapse/expand → `setExpanded()` is called
     *   but our patch sees the override and ignores the call → our
     *   per-cell choice sticks.
     */
    /** Saved original setExpanded for each tool, used by toggleTool. */
    private origSetExpandedMap = new WeakMap<ToolComponent, (v: boolean) => void>();

    private origSetExpandedFor(tool: ToolComponent, value: boolean): void {
        const fn = this.origSetExpandedMap.get(tool);
        if (fn) fn(value);
    }

    private patchTool(tool: ToolComponent): void {
        if (!this.patched.has(tool)) {
            this.patched.add(tool);
        }
        const origSetExpanded = tool.setExpanded.bind(tool);
        this.origSetExpandedMap.set(tool, origSetExpanded);
        const overrides = this.toolOverrides;
        const key = this.toolKey(tool);

        tool.setExpanded = function (value: boolean) {
            if (!overrides.has(key)) {
                origSetExpanded(value);
            }
        };
    }

    /**
     * Patch an assistant's `setHideThinkingBlock` so our per-cell
     * override survives pi's global toggle and reconciliation.
     */
    /** Saved original setHideThinkingBlock for each assistant. */
    private origSetHideMap = new WeakMap<AssistantComponent, (v: boolean) => void>();

    private origSetHideFor(comp: AssistantComponent, value: boolean): void {
        const fn = this.origSetHideMap.get(comp);
        if (fn) fn(value);
    }

    private patchAssistant(comp: AssistantComponent): void {
        if (!this.patched.has(comp)) {
            this.patched.add(comp);
        }
        const origSetHide = comp.setHideThinkingBlock.bind(comp);
        this.origSetHideMap.set(comp, origSetHide);
        const overrides = this.assistantOverrides;
        const key = this.assistantKey(comp);

        comp.setHideThinkingBlock = function (value: boolean) {
            if (!overrides.has(key)) {
                origSetHide(value);
            }
        };
    }
}
