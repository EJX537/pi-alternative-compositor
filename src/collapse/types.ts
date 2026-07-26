/**
 * Type guards for pi's collapsible component types.
 *
 * Extracted from the old collapse.ts so they can be shared by the
 * CollapseController (component-level) and the TUI-layer code that
 * still needs to identify collapsible components for mouse hit-testing
 * and viewport anchoring.
 */

type ComponentLike = {
    children?: unknown;
    setExpanded?: (expanded: boolean) => void;
    setHideThinkingBlock?: (hide: boolean) => void;
    toolCallId?: unknown;
    toolName?: unknown;
    lastMessage?: unknown;
};

export type AssistantComponent = ComponentLike & {
    lastMessage: { role: "assistant"; responseId?: string; id?: string };
    setHideThinkingBlock: (hide: boolean) => void;
    hideThinkingBlock?: boolean;
    render: (width: number) => string[];
};

export type ToolComponent = ComponentLike & {
    toolCallId: string;
    toolName: string;
    setExpanded: (expanded: boolean) => void;
    expanded?: boolean;
    render: (width: number) => string[];
};

export function isAssistantComponent(
    component: unknown,
): component is AssistantComponent {
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

export function isToolComponent(
    component: unknown,
): component is ToolComponent {
    if (!component || typeof component !== "object") return false;
    const candidate = component as ComponentLike;
    return (
        typeof candidate.setExpanded === "function" &&
        typeof candidate.toolCallId === "string" &&
        typeof candidate.toolName === "string"
    );
}

/**
 * Check whether a component looks like a thinking-block marker — either
 * the visible (Markdown with italic style) or hidden (Text placeholder)
 * state.
 *
 * - **Visible** thinking: a `Markdown` child whose `defaultTextStyle.italic`
 *   is `true`.  Pi's `AssistantMessageComponent` creates these with
 *   `{italic: true, color: thinkingText}`.
 * - **Hidden** thinking (already collapsed): a `Text` component with no
 *   children, no `defaultTextStyle`, no `theme`, and no `lines`.
 */
export function isThinkingMarkdown(comp: unknown): boolean {
    if (!comp || typeof comp !== "object") return false;
    const c = comp as Record<string, unknown>;

    // Visible thinking: Markdown with italic defaultTextStyle.
    const ds = c.defaultTextStyle;
    if (
        typeof ds === "object" &&
        ds !== null &&
        (ds as Record<string, unknown>).italic === true
    ) {
        return true;
    }

    // Hidden thinking: Text component with no children/theme/lines/defaultTextStyle
    // but with a render function.
    if (
        !Array.isArray(c.children) &&
        c.defaultTextStyle === undefined &&
        c.lines === undefined &&
        c.theme === undefined &&
        typeof c.render === "function"
    ) {
        return true;
    }

    return false;
}

/**
 * Walk an assistant component's children and find the thinking-block Markdown
 * child. Returns `null` if not yet rendered (e.g. streaming hasn't started).
 */
export function findThinkingChild(
    assistant: AssistantComponent,
): object | null {
    const children = (assistant as unknown as { children?: unknown[] }).children;
    if (!Array.isArray(children)) return null;
    for (const child of children) {
        if (isThinkingMarkdown(child)) return child as object;
    }
    return null;
}

export function isCollapsibleComponent(component: unknown): boolean {
    return isToolComponent(component) || isAssistantComponent(component);
}
