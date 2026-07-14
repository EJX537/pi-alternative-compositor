import { describe, expect, it } from "vitest";
import {
    ComponentCollapseState,
    isAssistantComponent,
} from "../src/terminal/collapse";
import { TerminalSplitCompositor } from "../src/terminal/controller";
import type { TerminalSplitCompositorOptions } from "../src/terminal/types";

function createAssistantComponent(overrides: {
    role?: string;
    id?: string;
    responseId?: string;
    hideThinkingBlock?: boolean;
} = {}): {
    component: {
        lastMessage: { role: string; responseId?: string };
        hideThinkingBlock: boolean;
        setHideThinkingBlockCalls: boolean[];
        setHideThinkingBlock: (hide: boolean) => void;
        children?: unknown[];
    };
    setHideThinkingBlock: (hide: boolean) => void;
} {
    const state = {
        lastMessage: {
            role: overrides.role ?? "assistant",
            ...(overrides.responseId !== undefined && {
                responseId: overrides.responseId,
            }),
        },
        hideThinkingBlock: overrides.hideThinkingBlock ?? false,
        setHideThinkingBlockCalls: [] as boolean[],
        setHideThinkingBlock(hide: boolean) {
            this.hideThinkingBlock = hide;
            this.setHideThinkingBlockCalls.push(hide);
        },
    };
    return { component: state, setHideThinkingBlock: state.setHideThinkingBlock };
}

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
        const component = {
            lastMessage: { role: "assistant" },
        };
        expect(isAssistantComponent(component)).toBe(false);
    });

    it("recognizes an assistant component with responseId but no id", () => {
        const { component } = createAssistantComponent({ responseId: "resp-1" });
        expect(isAssistantComponent(component)).toBe(true);
    });
});

describe("ComponentCollapseState thinking toggles", () => {
    it("toggles an assistant component to collapsed", () => {
        const collapse = new ComponentCollapseState();
        const { component } = createAssistantComponent();

        const toggled = collapse.toggle([
            { component, startLine: 0, lineCount: 5 },
        ]);

        expect(toggled).toBe(true);
        expect(component.hideThinkingBlock).toBe(true);
        expect(component.setHideThinkingBlockCalls).toEqual([true]);
    });

    it("toggles an assistant component back to expanded", () => {
        const collapse = new ComponentCollapseState();
        const { component } = createAssistantComponent({
            hideThinkingBlock: true,
        });

        collapse.toggle([{ component, startLine: 0, lineCount: 5 }]);
        expect(component.hideThinkingBlock).toBe(false);
    });

    it("prefers the local override over the instance default", () => {
        const collapse = new ComponentCollapseState();
        const { component } = createAssistantComponent();

        collapse.toggle([{ component, startLine: 0, lineCount: 5 }]);
        expect(collapse.isCollapsed(component)).toBe(true);

        // Simulate Pi rebuilding the component with the opposite default.
        const rebuilt = {
            ...component,
            hideThinkingBlock: false,
            setHideThinkingBlockCalls: [] as boolean[],
            setHideThinkingBlock(hide: boolean) {
                this.hideThinkingBlock = hide;
                this.setHideThinkingBlockCalls.push(hide);
            },
        };

        collapse.reconcile([rebuilt]);
        expect(rebuilt.hideThinkingBlock).toBe(true);
    });

    it("returns false for a non-collapsible path", () => {
        const collapse = new ComponentCollapseState();
        const component = { render: () => [] };
        expect(collapse.toggle([{ component, startLine: 0, lineCount: 1 }])).toBe(
            false,
        );
    });

    it("prefers the innermost tool over an enclosing assistant", () => {
        const collapse = new ComponentCollapseState();
        const assistant = createAssistantComponent().component;
        const tool = {
            toolCallId: "t1",
            toolName: "read",
            expanded: true,
            setExpandedCalls: [] as boolean[],
            setExpanded(value: boolean) {
                this.expanded = value;
                this.setExpandedCalls.push(value);
            },
        };

        const toggled = collapse.toggle([
            { component: assistant, startLine: 0, lineCount: 10 },
            { component: tool, startLine: 2, lineCount: 5 },
        ]);

        expect(toggled).toBe(true);
        expect(tool.expanded).toBe(false);
        expect(assistant.hideThinkingBlock).toBe(false);
    });
});

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

describe("TerminalSplitCompositor thinking collapse integration", () => {
    it("identifies an assistant message component in the line range map", () => {
        const { options } = createOptions();
        const assistant = createAssistantComponent().component;
        assistant.children = [
            {
                render: () => ["Thinking..."],
            },
        ];
        assistant.render = function (width: number) {
            return this.children!.flatMap((c: { render: (w: number) => string[] }) =>
                c.render(width),
            );
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
        assistant.children = [
            {
                render: () => ["Thinking..."],
            },
        ];
        assistant.render = function (width: number) {
            return this.children!.flatMap((c: { render: (w: number) => string[] }) =>
                c.render(width),
            );
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
        const cs = compositor as unknown as {
            collapseState: { toggle: (path: unknown[]) => boolean };
        };
        const toggled = cs.collapseState.toggle(path);
        expect(toggled).toBe(true);
        expect(assistant.hideThinkingBlock).toBe(true);

        compositor.dispose();
    });
});
