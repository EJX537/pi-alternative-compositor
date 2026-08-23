import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Terminal } from "@earendil-works/pi-tui";
import { renderFixedEditorCluster } from "../compositor/cluster.js";
import { findEditorContainer, renderHidden } from "../pi/editor-tree.js";
import { logError } from "../terminal/debug-log.js";
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
        if (!editorMatch) {
            // Never silently disappear: an error or missing editor on /resume
            // must be logged even when debug logging is off.
            logError(
                "compositor-setup: no editor container found; compositor not installed",
            );
            return;
        }

        // Collect ALL children from the above-widget through the end of the
        // children list. In pi's default layout this spans:
        //   widgetContainerAbove → editorContainer → widgetContainerBelow → footer
        // and any other children extensions place around the editor.
        // Previously only three immediate neighbors were captured, which missed
        // the footer and caused it to render in the scrollable root above the
        // editor instead of below it.
        //
        // IMPORTANT: the chat container (error text included) is ALWAYS
        // tui.children[0]. Clamping to >= 1 keeps it in the scrollable root so
        // pi's error messages (e.g. on a failed /resume) are never hidden by
        // the fixed cluster.  With Math.max(0, ...), a session whose layout
        // lacks the widget-above-editor (editor at index 1) yielded
        // clusterStartIndex = 0, pulling chatContainer into the cluster and
        // rendering it blank — the compositor then painted over the error.
        const clusterStartIndex = Math.max(1, editorMatch.index - 1);

        let nextCompositor: TerminalSplitCompositor;
        nextCompositor = new TerminalSplitCompositor({
            tui,
            terminal: terminal as Terminal & TerminalInternals,
            onCopySelection: (text) => void copyToClipboard(text),
            sidebar: this.sidebar.createOptions(),
            getShowHardwareCursor: () => tui.getShowHardwareCursor(),
            renderCluster: (width, terminalRows) => {
                // Re-derive the editor position at render time: on /resume the
                // children list is rebuilt and the index captured at install
                // time may no longer match, which would mis-hide children and
                // blank the chat container (hiding pi's error text).
                const currentEditor = findEditorContainer(tui);
                const currentStart = Math.max(
                    1,
                    (currentEditor?.index ?? editorMatch.index) - 1,
                );
                // Keep the engine's root/cluster boundary in sync with the
                // re-derived index so getRootChildren() (line mapping) and the
                // cluster render below always agree.  Without this, a session
                // switch that shifts the editor index leaves the two out of
                // step and the chat container (error text) can be dropped.
                nextCompositor.setClusterStartIndex(currentStart);
                const clusterChildren = tui.children.slice(
                    currentStart,
                ) as Component[];
                const editorSliceIndex =
                    (currentEditor?.index ?? editorMatch.index) - currentStart;
                const editorContainer: Component | null =
                    clusterChildren[editorSliceIndex] ?? null;

                // Hide every cluster child from Pi&#39;s Container.render() so that
                // renderOverlayFrame() does not render them twice: once via
                // originalRender() (which iterates all tui.children) and once
                // via the explicit getCluster() path below.  Without this, the
                // cluster (input bar) appears duplicated on screen whenever a
                // Pi native overlay is active.
                for (const child of clusterChildren) {
                    nextCompositor.hideRenderable(child);
                }

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
                    topPaddingLines: 1,
                    bottomPaddingLines: 1,
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
        // or above clusterStartIndex and is automatically excluded.  The
        // renderCluster callback re-derives and re-syncs this boundary on every
        // render (including install()'s eager refresh), so it self-corrects if
        // the layout shifts during a session switch.
        nextCompositor.setClusterStartIndex(clusterStartIndex);

        try {
            nextCompositor.install();
            this.installed = true;
            tui.requestRender();
        } catch (err) {
            // Never swallow install failures: without this log the error is
            // invisible because the compositor has already patched the render
            // pipeline and paints over pi's own error display.
            logError("compositor-install-error:", err);
            try {
                ctx.ui.notify(
                    `Compositor failed to install: ${err instanceof Error ? err.message : String(err)} — see ~/.pi/agent/pi-alternative-compositor-debug.log`,
                    "error",
                );
            } catch {
                // notify may not be available during session teardown
            }
            this.teardown();
        }
    }
}
