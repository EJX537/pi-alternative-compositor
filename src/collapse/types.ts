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
 * Check whether a component looks like the thinking-block Markdown child
 * inside an AssistantMessageComponent.
 *
 * Pi's AssistantMessageComponent creates a Markdown child with
 * `{italic: true, color: thinkingText}` for the visible thinking block.
 */
export function isThinkingMarkdown(comp: unknown): boolean {
    if (!comp || typeof comp !== "object") return false;
    const c = comp as Record<string, unknown>;
    const ds = c.defaultTextStyle;
    return (
        typeof ds === "object" &&
        ds !== null &&
        (ds as Record<string, unknown>).italic === true
    );
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
