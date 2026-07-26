import { describe, expect, it } from "vitest";
import { CollapseController } from "../src/collapse/collapse-controller.js";
import { isAssistantComponent, isToolComponent } from "../src/collapse/types.js";
import { TerminalSplitCompositor } from "../src/terminal/controller";
import type { TerminalSplitCompositorOptions } from "../src/terminal/types";

// ── Helpers ───────────────────────────────────────────────────

function createAssistantComponent(overrides: {
    role?: string;
    id?: string;
    responseId?: string;
    hideThinkingBlock?: boolean;
} = {}): {
    component: {
        lastMessage: { role: string; responseId?: string };
        hideThinkingBlock: boolean;
        setHideThinkingBlock: (hide: boolean) => void;
        children?: unknown[];
    };
} {
    const state = {
        lastMessage: {
            role: overrides.role ?? "assistant",
            ...(overrides.responseId !== undefined && {
                responseId: overrides.responseId,
            }),
        },
        hideThinkingBlock: overrides.hideThinkingBlock ?? false,
        setHideThinkingBlock(hide: boolean) {
            this.hideThinkingBlock = hide;
        },
    };
    return { component: state };
}

function createToolComponent(expanded = true) {
    return {
        toolCallId: "t1",
        toolName: "read",
        expanded,
        setExpanded(value: boolean) {
            this.expanded = value;
        },
    };
}

// ── Type guard tests ──────────────────────────────────────────

describe("isAssistantComponent", () => {
    it("recognizes an assistant component without a message id field", () => {
        const { component } = createAssistantComponent();
        expect(isAssistantComponent(component)).toBe(true);
    });

    it("rejects a component with the wrong role", () => {
        const { component } = createAssistantComponent({ role: "user" });
        expect(isAssistantComponent(component)).toBe(false);
    });

    it("rejects a component missing setHideThinkingBlock", () => {
        const component = { lastMessage: { role: "assistant" } };
        expect(isAssistantComponent(component)).toBe(false);
    });

    it("recognizes an assistant component with responseId", () => {
        const { component } = createAssistantComponent({ responseId: "resp-1" });
        expect(isAssistantComponent(component)).toBe(true);
    });
});

// ── CollapseController unit tests ─────────────────────────────

describe("CollapseController", () => {
    it("toggles an assistant component to collapsed", () => {
        const collapse = new CollapseController();
        const { component } = createAssistantComponent();
        collapse.toggle(component, 0);
        expect(collapse.isCollapsed(component)).toBe(true);
    });

    it("toggles an assistant component back to expanded", () => {
        const collapse = new CollapseController();
        const { component } = createAssistantComponent({ hideThinkingBlock: true });
        collapse.toggle(component, 0);
        expect(collapse.isCollapsed(component)).toBe(false);
    });

    it("prefers the local override over pi's instance state", () => {
        const collapse = new CollapseController();
        const { component } = createAssistantComponent();
        collapse.toggle(component, 0);
        expect(collapse.isCollapsed(component)).toBe(true);

        // Simulate pi rebuilding the component with a different default.
        const rebuilt = { ...component, hideThinkingBlock: false };
        // Override in WeakMap persists regardless of pi's instance property.
        expect(collapse.isCollapsed(rebuilt)).toBe(true);
    });

    it("returns false for a non-collapsible component", () => {
        const collapse = new CollapseController();
        const component = { render: () => [] };
        expect(collapse.toggle(component, 0)).toBe(false);
    });

    it("toggles a tool component", () => {
        const collapse = new CollapseController();
        const tool = createToolComponent(true);
        collapse.toggle(tool, 0);
        expect(collapse.isCollapsed(tool)).toBe(true);
    });

    it("consumes and clears lastToggle", () => {
        const collapse = new CollapseController();
        const tool = createToolComponent(true);
        collapse.toggle(tool, 42);
        const t = collapse.consumeLastToggle();
        expect(t).not.toBeNull();
        expect(t!.component).toBe(tool);
        expect(t!.collapsed).toBe(true);
        expect(t!.startLine).toBe(42);
        expect(collapse.consumeLastToggle()).toBeNull();
    });

    it("reports pending toggle correctly", () => {
        const collapse = new CollapseController();
        expect(collapse.hasPendingToggle).toBe(false);
        collapse.toggle(createToolComponent(true), 0);
        expect(collapse.hasPendingToggle).toBe(true);
        collapse.consumeLastToggle();
        expect(collapse.hasPendingToggle).toBe(false);
    });
});

// ── Integration: TerminalSplitCompositor + collapse ───────────

function createOptions(): {
    options: TerminalSplitCompositorOptions;
    writes: string[];
} {
    const writes: string[] = [];
    const terminal = {
        columns: 80,
        rows: 24,
        modifyOtherKeysActive: false,
        write: (data: string) => writes.push(data),
    };
    const tui = {
        terminal,
        children: [] as unknown[],
        focusedComponent: null,
        hardwareCursorRow: 1,
        cursorRow: 0,
        previousViewportTop: 0,
        previousLines: [] as string[],
        previousKittyImageIds: new Set<number>(),
        previousWidth: 0,
        previousHeight: 0,
        maxLinesRendered: 0,
        requestRender: () => {},
        addInputListener: () => () => {},
        hasOverlay: () => false,
        render: () => [] as string[],
        getShowHardwareCursor: () => false,
        doRender: () => {},
        compositeLineAt: (baseLine: string) => baseLine,
        overlayStack: [],
        collectKittyImageIds: () => new Set<number>(),
    };

    return {
        options: {
            tui: tui as unknown as TerminalSplitCompositorOptions["tui"],
            terminal: terminal as unknown as TerminalSplitCompositorOptions["terminal"],
            renderCluster: () => ({ lines: [], cursor: null }),
        },
        writes,
    };
}

describe("TerminalSplitCompositor collapse integration", () => {
    it("identifies an assistant message component in the line range map", () => {
        const { options } = createOptions();
        const assistant = createAssistantComponent().component;
        assistant.children = [{ render: () => ["Thinking..."] }];
        assistant.render = function (this: { children: { render: (w: number) => string[] }[] }, width: number) {
            return this.children.flatMap((c) => c.render(width));
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [assistant];
        tui.render = () => assistant.render(80);

        const compositor = new TerminalSplitCompositor(options);
        compositor.install();
        tui.render(80);

        const ranges = compositor.getRootComponentLineRanges();
        const assistantRange = ranges.find((r) => r.component === assistant);
        expect(assistantRange).toBeDefined();
        expect(assistantRange?.lineCount).toBe(1);

        compositor.dispose();
    });

    it("toggles thinking collapse via the collapse state", () => {
        const { options } = createOptions();
        const assistant = createAssistantComponent().component;
        assistant.children = [{ render: () => ["Thinking..."] }];
        assistant.render = function (this: { children: { render: (w: number) => string[] }[] }, width: number) {
            return this.children.flatMap((c) => c.render(width));
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [assistant];
        tui.render = () => assistant.render(80);

        const compositor = new TerminalSplitCompositor(options);
        compositor.install();
        tui.render(80);

        const path = compositor.getRootComponentPathAtLine(0);
        // Find assistant component from path
        const target = [...path].reverse().find((r) => isAssistantComponent(r.component));
        expect(target).toBeDefined();
        if (!target) return;

        const toggled = compositor.collapseState.toggle(target.component, 0);
        expect(toggled).toBe(true);
        expect(compositor.collapseState.isCollapsed(target.component)).toBe(true);

        compositor.dispose();
    });
});
