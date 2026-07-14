import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Terminal } from "@earendil-works/pi-tui";
import { renderFixedEditorCluster } from "../compositor/cluster.js";
import { findEditorContainer, renderHidden } from "../pi/editor-tree.js";
import type { TerminalInternals, TuiInternals } from "../pi/internals.js";
import { TerminalSplitCompositor } from "../terminal/controller.js";
import type { DisposeOptions } from "../terminal/types.js";
import { resetSidebarRegistry, setSidebarRequestRender } from "./sidebar-registry.js";
import { SidebarState } from "./sidebar.js";

export class CompositorLifecycle {
    readonly sidebar = new SidebarState();
    private compositor: TerminalSplitCompositor | null = null;
    private installed = false;
    private fixedEditorContainer: Component | null = null;
    private fixedWidgetContainerAbove: Component | null = null;
    private fixedWidgetContainerBelow: Component | null = null;

    requestRender = (): void => this.compositor?.requestRender();

    setSidebarVisible(visible: boolean): void {
        this.sidebar.visible = visible;
        this.requestRender();
    }

    teardown(
        exitAlternateScreen = true,
        reason?: DisposeOptions["reason"],
    ): void {
        this.compositor?.dispose({ exitAlternateScreen, reason });
        setSidebarRequestRender(null);
        resetSidebarRegistry();
        this.compositor = null;
        this.installed = false;
        this.fixedEditorContainer = null;
        this.fixedWidgetContainerAbove = null;
        this.fixedWidgetContainerBelow = null;
        this.sidebar.visible = false;
    }

    setup(ctx: ExtensionContext, tui: TuiInternals): void {
        if (this.installed || this.compositor || ctx.mode !== "tui") return;

        const terminal = tui.terminal;
        if (!terminal) return;

        const editorMatch = findEditorContainer(tui);
        if (!editorMatch) return;

        this.fixedWidgetContainerAbove =
            (tui.children[editorMatch.index - 1] as Component | undefined) ?? null;
        this.fixedEditorContainer = editorMatch.container;
        this.fixedWidgetContainerBelow =
            (tui.children[editorMatch.index + 1] as Component | undefined) ?? null;

        let nextCompositor: TerminalSplitCompositor;
        nextCompositor = new TerminalSplitCompositor({
            tui,
            terminal: terminal as Terminal & TerminalInternals,
            onCopySelection: (text) => void copyToClipboard(text),
            sidebar: this.sidebar.createOptions(),
            getShowHardwareCursor: () => tui.getShowHardwareCursor(),
            renderCluster: (width, terminalRows) =>
                renderFixedEditorCluster({
                    width,
                    terminalRows,
                    aboveWidgetLines: renderHidden(
                        nextCompositor,
                        this.fixedWidgetContainerAbove,
                        width,
                    ),
                    editorLines: renderHidden(
                        nextCompositor,
                        this.fixedEditorContainer,
                        width,
                    ),
                    belowWidgetLines: renderHidden(
                        nextCompositor,
                        this.fixedWidgetContainerBelow,
                        width,
                    ),
                }),
        });

        this.compositor = nextCompositor;
        // Keep the registry callback bound to this installed terminal instance.
        // It must not follow lifecycle state during session replacement.
        setSidebarRequestRender(() => nextCompositor.requestRender());
        if (this.fixedWidgetContainerAbove)
            nextCompositor.hideRenderable(this.fixedWidgetContainerAbove);
        if (this.fixedEditorContainer)
            nextCompositor.hideRenderable(this.fixedEditorContainer);
        if (this.fixedWidgetContainerBelow)
            nextCompositor.hideRenderable(this.fixedWidgetContainerBelow);

        try {
            nextCompositor.install();
            this.installed = true;
            tui.requestRender();
        } catch {
            this.teardown();
        }
    }
}
