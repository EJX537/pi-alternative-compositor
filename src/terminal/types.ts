import type { Terminal } from "@earendil-works/pi-tui";
import type { FixedEditorClusterRender } from "../compositor/cluster.js";
import type { SidebarOptions } from "../compositor/contracts.js";
import type { TerminalInternals, TuiInternals } from "../pi/internals.js";
export type { SidebarBreakpoint, SidebarOptions } from "../compositor/contracts.js";

// ── Compositor options ───────────────────────────────────────

export interface TerminalSplitCompositorOptions {
    /**
     * The TUI instance.  Uses TuiInternals so the compositor can access
     * private members needed to overload the render pipeline.  Callers
     * cast the real TUI once at the call site.
     */
    tui: TuiInternals;
    /**
     * The terminal instance.  Includes TerminalInternals for private
     * members (modifyOtherKeysActive) used during keyboard-protocol
     * negotiation.
     */
    terminal: Terminal & TerminalInternals;
    renderCluster: (
        width: number,
        terminalRows: number,
    ) => FixedEditorClusterRender;
    getShowHardwareCursor?: () => boolean;
    mouseScroll?: boolean;
    onCopySelection?: (text: string) => void;
    /** An optional compositor-owned pane that reserves columns on the right. */
    sidebar?: SidebarOptions;
}


// ── Render patches ───────────────────────────────────────────

export interface PatchedRenderable {
    render(width: number): string[];
}

export interface RenderPatch {
    target: PatchedRenderable;
    originalRender: (width: number) => string[];
}

export interface RenderPassCluster {
    width: number;
    terminalRows: number;
    cluster: FixedEditorClusterRender;
}

/** A root child and the contiguous lines it produced in the latest render. */
export interface RootComponentLineRange {
    /** The actual Pi component instance; treated as opaque outside the mapper. */
    component: unknown;
    startLine: number;
    lineCount: number;
}

// ── Mouse ────────────────────────────────────────────────────

export interface SgrMousePacket {
    code: number;
    col: number;
    row: number;
    final: "M" | "m";
}

// ── Selection ────────────────────────────────────────────────

export interface SelectionPoint {
    line: number;
    col: number;
}

export type SelectionArea = "root" | "cluster";

export interface SelectionLocation {
    area: SelectionArea;
    point: SelectionPoint;
    /** Screen row where the packet originated (1-indexed). */
    screenRow: number;
    /** Screen column where the packet originated (1-indexed). */
    screenCol: number;
}

export interface DisposeOptions {
    resetExtendedKeyboardModes?: boolean;
    /**
     * Leave the alternate screen active when Pi is replacing a live session.
     * The TUI can still have a queued redraw, which must never target the
     * user's main terminal screen.
     */
    exitAlternateScreen?: boolean;
    /**
     * Why the compositor is being disposed. Used to avoid terminal-state
     * flicker during `/reload`, where the old and new extension instances
     * can keep the alternate screen alive across the handoff.
     */
    reason?: "quit" | "reload" | "new" | "resume" | "fork";
}

// ── Keyboard ─────────────────────────────────────────────────

export type ExtendedKeyboardMode = "kitty" | "modifyOtherKeys";
