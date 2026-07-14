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

    /** Toggle the most specific supported component in an outer-to-inner path. */
    toggle(path: readonly RootComponentLineRange[]): boolean {
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
                startLine: tool.startLine,
            };
            tool.component.setExpanded(!nextCollapsed);
            return true;
        }

        const assistant = path.toReversed().find((range) =>
            isAssistantComponent(range.component),
        );
        if (!assistant || !isAssistantComponent(assistant.component)) return false;

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
            startLine: assistant.startLine,
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
