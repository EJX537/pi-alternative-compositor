import type { RootComponentLineRange } from "./types.js";

type ComponentLike = {
    children?: unknown;
    setExpanded?: (expanded: boolean) => void;
    setHideThinkingBlock?: (hide: boolean) => void;
    toolCallId?: unknown;
    toolName?: unknown;
    lastMessage?: unknown;
};

type AssistantComponent = ComponentLike & {
    lastMessage: { role: "assistant"; responseId?: string; id?: string };
    setHideThinkingBlock: (hide: boolean) => void;
    hideThinkingBlock?: boolean;
};

type ToolComponent = ComponentLike & {
    toolCallId: string;
    toolName: string;
    setExpanded: (expanded: boolean) => void;
    expanded?: boolean;
};

export function isAssistantComponent(component: unknown): component is AssistantComponent {
    if (!component || typeof component !== "object") return false;
    const candidate = component as ComponentLike;
    const message = candidate.lastMessage;
    return (
        typeof candidate.setHideThinkingBlock === "function" &&
        typeof message === "object" &&
        message !== null &&
        (message as { role?: unknown }).role === "assistant"
    );
}

function assistantOverrideKey(
    message: object,
): string | object {
    const id =
        (message as { responseId?: string }).responseId ??
        (message as { id?: string }).id;
    return typeof id === "string" ? id : message;
}

export function isToolComponent(component: unknown): component is ToolComponent {
    if (!component || typeof component !== "object") return false;
    const candidate = component as ComponentLike;
    return (
        typeof candidate.setExpanded === "function" &&
        typeof candidate.toolCallId === "string" &&
        typeof candidate.toolName === "string"
    );
}

/**
 * Check whether the clicked line falls on the thinking-block portion of an
 * assistant message component, by scanning the component path for known
 * thinking-block markers.
 *
 * - **Visible** thinking block: a `Markdown` whose `defaultTextStyle.italic`
 *   is `true`.  Pi's `AssistantMessageComponent` always creates thinking
 *   Markdown instances with `{italic: true, color: thinkingText}`.
 * - **Hidden** thinking block (already collapsed): a `Text` component
 *   ("Thinking…" label).  Text components have no `children` array, no
 *   `defaultTextStyle`, no `theme` (unlike Markdown), and no `lines`
 *   (unlike Spacer).
 *
 * Response-text Markdown instances have NO `defaultTextStyle`, so they
 * never match the first check.  Error-message Text instances also lack
 * `defaultTextStyle`, but they appear AFTER response text while the
 * hidden thinking label appears BEFORE it, so the first non-Spacer child
 * of `contentContainer` is unambiguous.
 *
 * Falls back to `true` (allow toggle) when the assistant has no deeper
 * children in the path (simplified test mocks).
 */
function isClickOnThinkingBlock(
    path: readonly RootComponentLineRange[],
    assistantIndex: number,
): boolean {
    // No deeper components → synthetic test mock; allow toggle.
    if (assistantIndex + 1 >= path.length) return true;

    // Scan from innermost outward for a visible thinking marker.
    for (let i = path.length - 1; i > assistantIndex; i--) {
        const comp = path[i].component;
        if (!comp || typeof comp !== "object") continue;
        const candidate = comp as Record<string, unknown>;

        // --- Visible thinking: Markdown with italic defaultTextStyle ---
        const ds = candidate.defaultTextStyle;
        if (
            typeof ds === "object" &&
            ds !== null &&
            (ds as Record<string, unknown>).italic === true
        ) {
            return true;
        }

        // --- Hidden thinking: Text component ---
        // Not a Container (no children), not a Markdown (no theme),
        // not a Spacer (no lines).
        if (
            !Array.isArray(candidate.children) &&
            candidate.defaultTextStyle === undefined &&
            candidate.lines === undefined &&
            candidate.theme === undefined &&
            typeof candidate.render === "function"
        ) {
            // Verify this Text is truly the hidden thinking label by
            // checking it is the first non-Spacer child of contentContainer.
            const containerRange = path[assistantIndex + 1];
            if (containerRange) {
                const container = containerRange.component as
                    | { children?: unknown[] }
                    | undefined;
                if (
                    container &&
                    Array.isArray(container.children) &&
                    container.children.length > 0
                ) {
                    const firstNonSpacer = container.children.find(
                        (c) =>
                            typeof c === "object" &&
                            c !== null &&
                            (c as Record<string, unknown>).lines ===
                                undefined,
                    );
                    if (firstNonSpacer) {
                        return firstNonSpacer === comp;
                    }
                }
            }
            // If we can't find contentContainer children, allow toggle.
            return true;
        }
    }
    return false;
}

/** Extension-owned local collapse state, independent of Pi's global toggle. */
export class ComponentCollapseState {
    /**
     * Per-component override of Pi's current state. `true` means collapsed,
     * `false` means expanded, and absence means "defer to Pi".
     */
    private readonly assistantOverrides = new Map<string | object, boolean>();
    private readonly toolOverrides = new Map<string, boolean>();

    /** Most recent explicit toggle, consumed by the render engine for anchoring. */
    private lastToggled: {
        component: object;
        kind: "tool" | "assistant";
        collapsed: boolean;
        /** Absolute root line of the toggled component at the time of the click. */
        startLine: number;
    } | null = null;

    /**
     * Snapshot of collapse states taken before reconciliation, used to detect
     * Pi's native global collapse/expand toggle (keyboard shortcut) which
     * bypasses this.toggle().
     */
    private preReconcileSnapshot: Map<object, boolean> | null = null;

    /**
     * Toggle the most specific supported component in an outer-to-inner path.
     * `clickedLine` is the absolute root line the user clicked, used for
     * viewport anchoring. When omitted (e.g. global keyboard toggles), the
     * component's startLine is used as a fallback.
     */
    toggle(
        path: readonly RootComponentLineRange[],
        clickedLine?: number,
    ): boolean {
        const tool = path.toReversed().find((range) =>
            isToolComponent(range.component),
        );
        if (tool && isToolComponent(tool.component)) {
            const id = tool.component.toolCallId;
            // The local override is the source of truth. Pi rebuilds components
            // frequently, so `expanded` on the instance may reflect a default
            // rather than the last toggled state.
            const override = this.toolOverrides.get(id);
            const currentlyCollapsed =
                override !== undefined
                    ? override
                    : !(tool.component.expanded ?? true);
            const nextCollapsed = !currentlyCollapsed;
            this.toolOverrides.set(id, nextCollapsed);
            this.lastToggled = {
                component: tool.component,
                kind: "tool",
                collapsed: nextCollapsed,
                // For small tool headers the component startLine is usually
                // identical to the click line, but using the click line keeps
                // behavior consistent with assistant/thinking toggles.
                startLine: clickedLine ?? tool.startLine,
            };
            tool.component.setExpanded(!nextCollapsed);
            return true;
        }

        const assistant = path.toReversed().find((range) =>
            isAssistantComponent(range.component),
        );
        if (!assistant || !isAssistantComponent(assistant.component)) return false;

        // Only toggle when the click is on the thinking block portion of the
        // assistant message, not on response text or other non-thinking content.
        const assistantIndex = path.indexOf(assistant);
        if (assistantIndex >= 0 && clickedLine !== undefined) {
          if (!isClickOnThinkingBlock(path, assistantIndex)) return false;
        }

        const message = assistant.component.lastMessage;
        const key = assistantOverrideKey(message);
        const override = this.assistantOverrides.get(key);
        const currentlyCollapsed =
            override !== undefined
                ? override
                : (assistant.component.hideThinkingBlock ?? false);
        const nextCollapsed = !currentlyCollapsed;
        this.assistantOverrides.set(key, nextCollapsed);
        this.lastToggled = {
            component: assistant.component,
            kind: "assistant",
            collapsed: nextCollapsed,
            // Assistant components can be very tall (the thinking block is a
            // small child inside a large message). Anchor from the actual click
            // line so the viewport doesn't jump when a deep thinking block is
            // collapsed.
            startLine: clickedLine ?? assistant.startLine,
        };
        assistant.component.setHideThinkingBlock(nextCollapsed);
        return true;
    }

    /** Return and clear the most recent explicit toggle, if any. */
    consumeLastToggle(): {
        component: object;
        kind: "tool" | "assistant";
        collapsed: boolean;
        startLine: number;
    } | null {
        const toggled = this.lastToggled;
        this.lastToggled = null;
        return toggled;
    }

    /** Return whether a toggle is pending without consuming it. */
    hasPendingToggle(): boolean {
        return this.lastToggled !== null;
    }

    /**
     * Return whether a collapsible component is currently collapsed, or `null`
     * if the component is not collapsible.
     */
    isCollapsed(component: unknown): boolean | null {
        if (isToolComponent(component)) {
            const override = this.toolOverrides.get(component.toolCallId);
            if (override !== undefined) return override;
            return !(component.expanded ?? true);
        }
        if (isAssistantComponent(component)) {
            const override = this.assistantOverrides.get(
                assistantOverrideKey(component.lastMessage),
            );
            if (override !== undefined) return override;
            return component.hideThinkingBlock ?? false;
        }
        return null;
    }

    /** Return true if the component supports collapse/expand toggling. */
    isCollapsibleComponent(component: unknown): boolean {
        return isToolComponent(component) || isAssistantComponent(component);
    }

    /** Walk the component tree and record the collapse state of every collapsible component. */
    snapshotCollapseState(roots: readonly unknown[]): void {
        this.preReconcileSnapshot = new Map();
        const seen = new Set<object>();
        const visit = (component: unknown): void => {
            if (!component || typeof component !== "object" || seen.has(component)) return;
            seen.add(component);
            const collapsed = this.isCollapsed(component);
            if (collapsed !== null) {
                this.preReconcileSnapshot!.set(component, collapsed);
            }
            const children = (component as ComponentLike).children;
            if (Array.isArray(children)) children.forEach(visit);
        };
        roots.forEach(visit);
    }

    /**
     * After rendering, detect any component whose collapse state changed compared
     * to the pre-reconcile snapshot.  Returns a pseudo-toggle entry for the first
     * change found, or null if no global toggle occurred.  Consumes the snapshot.
     *
     * If a local toggle was already recorded (via toggle()), returns null so the
     * caller handles the local toggle exclusively.  startLine is set to -1
     * because the pre-render absolute line position is unknown here; the caller
     * should look it up from the previous root component line ranges.
     */
    consumeGlobalToggle(roots: readonly unknown[]): {
        component: object;
        collapsed: boolean;
    } | null {
        const snapshot = this.preReconcileSnapshot;
        this.preReconcileSnapshot = null;
        if (!snapshot || snapshot.size === 0 || this.lastToggled) return null;

        const seen = new Set<object>();
        const walk = (component: unknown): { component: object; collapsed: boolean } | null => {
            if (!component || typeof component !== "object" || seen.has(component))
                return null;
            seen.add(component);

            const prev = snapshot.get(component);
            if (prev !== undefined) {
                const now = this.isCollapsed(component);
                if (now !== null && prev !== now) {
                    return { component, collapsed: now };
                }
            }

            const children = (component as ComponentLike).children;
            if (Array.isArray(children)) {
                for (const child of children) {
                    const result = walk(child);
                    if (result) return result;
                }
            }
            return null;
        };

        for (const root of roots) {
            const result = walk(root);
            if (result) return result;
        }
        return null;
    }

    /** Reapply only explicit local overrides, never undo Pi's global state. */
    reconcile(roots: readonly unknown[]): void {
        const seen = new Set<object>();
        const visit = (component: unknown): void => {
            if (!component || typeof component !== "object" || seen.has(component))
                return;
            seen.add(component);

            if (isAssistantComponent(component)) {
                const key = assistantOverrideKey(component.lastMessage);
                if (this.assistantOverrides.has(key)) {
                    component.setHideThinkingBlock(
                        this.assistantOverrides.get(key)!,
                    );
                }
            }
            if (isToolComponent(component)) {
                const id = component.toolCallId;
                if (this.toolOverrides.has(id)) {
                    component.setExpanded(!this.toolOverrides.get(id)!);
                }
            }

            const children = (component as ComponentLike).children;
            if (Array.isArray(children)) children.forEach(visit);
        };
        roots.forEach(visit);
    }
}
