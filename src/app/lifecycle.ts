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
        this.sidebar.visible = false;
    }

    setup(ctx: ExtensionContext, tui: TuiInternals): void {
        if (this.installed || this.compositor || ctx.mode !== "tui") return;

        const terminal = tui.terminal;
        if (!terminal) return;

        const editorMatch = findEditorContainer(tui);
        if (!editorMatch) return;

        // Collect ALL children from the above-widget through the end of the
        // children list. In pi's default layout this spans:
        //   widgetContainerAbove → editorContainer → widgetContainerBelow → footer
        // and any other children extensions place around the editor.
        // Previously only three immediate neighbors were captured, which missed
        // the footer and caused it to render in the scrollable root above the
        // editor instead of below it.
        const clusterStartIndex = Math.max(0, editorMatch.index - 1);

        let nextCompositor: TerminalSplitCompositor;
        nextCompositor = new TerminalSplitCompositor({
            tui,
            terminal: terminal as Terminal & TerminalInternals,
            onCopySelection: (text) => void copyToClipboard(text),
            sidebar: this.sidebar.createOptions(),
            getShowHardwareCursor: () => tui.getShowHardwareCursor(),
            renderCluster: (width, terminalRows) => {
                // Slice dynamically from tui.children at render time so that
                // components replaced after setup (e.g. pi-input-revamp&#39;s
                // setFooter swapping the footer instance) are always included.
                const clusterChildren = tui.children.slice(
                    clusterStartIndex,
                ) as Component[];
                const editorSliceIndex = editorMatch.index - clusterStartIndex;
                const editorContainer: Component | null =
                    clusterChildren[editorSliceIndex] ?? null;
                const aboveChildren = clusterChildren.slice(0, editorSliceIndex);
                const belowChildren = clusterChildren.slice(
                    editorSliceIndex + 1,
                );
                return renderFixedEditorCluster({
                    width,
                    terminalRows,
                    aboveWidgetLines: aboveChildren.flatMap((child) =>
                        renderHidden(nextCompositor, child, width),
                    ),
                    editorLines: renderHidden(
                        nextCompositor,
                        editorContainer,
                        width,
                    ),
                    belowWidgetLines: belowChildren.flatMap((child) =>
                        renderHidden(nextCompositor, child, width),
                    ),
                });
            },
        });

        this.compositor = nextCompositor;
        // Keep the registry callback bound to this installed terminal instance.
        // It must not follow lifecycle state during session replacement.
        setSidebarRequestRender(() => nextCompositor.requestRender());

        // Tell the render engine to exclude cluster children from root rendering
        // by index range.  This is robust against component replacement: even if
        // an extension replaces the footer instance, the new instance is still at
        // or above clusterStartIndex and is automatically excluded.
        nextCompositor.setClusterStartIndex(clusterStartIndex);

        try {
            nextCompositor.install();
            this.installed = true;
            tui.requestRender();
        } catch {
            this.teardown();
        }
    }
}
