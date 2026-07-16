import {
    beginSynchronizedOutput,
    disableAlternateScrollMode,
    disableBracketedPaste,
    disableExtendedKeyboardMode,
    disableFocusEvents,
    disableMouseReporting,
    enableAlternateScrollMode,
    enableBracketedPaste,
    enableExtendedKeyboardMode,
    enableMouseReporting,
    endSynchronizedOutput,
    enterAlternateScreen,
    eraseDisplay,
    exitAlternateScreen,
    homeCursor,
    resetExtendedKeyboardModes,
    resetScrollRegion,
} from "./escape.js";
import type { Terminal } from "@earendil-works/pi-tui";
import type { TerminalInternals } from "../pi/internals.js";
import type {
    DisposeOptions,
    ExtendedKeyboardMode,
} from "./types.js";

const CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS = 1200;
const CONTEXT_MENU_SELECTION_RESTORE_WINDOW_MS = 3000;
const CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS = 300;

const ALTERNATE_SCREEN_KEY = Symbol.for(
    "pi-fixed-editor-compositor.alternateScreenActive",
);

type GlobalWithAlternateScreen = typeof globalThis & {
    [ALTERNATE_SCREEN_KEY]?: boolean;
};

function isAlternateScreenActive(): boolean {
    return (globalThis as GlobalWithAlternateScreen)[ALTERNATE_SCREEN_KEY] === true;
}

function setAlternateScreenActive(active: boolean): void {
    (globalThis as GlobalWithAlternateScreen)[ALTERNATE_SCREEN_KEY] = active;
}

// ── TerminalModeManager ──────────────────────────────────────

/**
 * Owns alternate-screen keyboard modes, extended keyboard modes,
 * mouse reporting enable/disable, context-menu mouse-reporting
 * pause with clipboard restore polling, and terminal-state restore.
 */
export class TerminalModeManager {
    private readonly terminal: Terminal & TerminalInternals;
    private readonly mouseScroll: boolean;
    private readonly originalWrite: (data: string) => void;
    private readonly getOnCopySelection: () => ((text: string) => void) | null;
    private readonly getSelectedTextNow: () => string;
    private extendedKeyboardMode: ExtendedKeyboardMode | null = null;
    private mouseReportingResumeTimer: ReturnType<typeof setTimeout> | null =
        null;
    private clipboardRestoreTimer: ReturnType<typeof setTimeout> | null = null;
    private mouseReportingActive = false;
    private disposed = false;

    constructor(
        terminal: Terminal & TerminalInternals,
        mouseScroll: boolean,
        originalWrite: (data: string) => void,
        getOnCopySelection: () => ((text: string) => void) | null,
        getSelectedTextNow: () => string,
    ) {
        this.terminal = terminal;
        this.mouseScroll = mouseScroll;
        this.originalWrite = originalWrite;
        this.getOnCopySelection = getOnCopySelection;
        this.getSelectedTextNow = getSelectedTextNow;
    }

    /** Mark as disposed so delayed timers become no-ops. */
    markDisposed(): void {
        this.disposed = true;
    }

    /** Clear all pending timers. */
    clearTimers(): void {
        if (this.mouseReportingResumeTimer) {
            clearTimeout(this.mouseReportingResumeTimer);
            this.mouseReportingResumeTimer = null;
        }
        if (this.clipboardRestoreTimer) {
            clearTimeout(this.clipboardRestoreTimer);
            this.clipboardRestoreTimer = null;
        }
    }

    // ── Initialization ────────────────────────────────────────

    /** Build the install escape sequence (alternate screen, keyboard modes, etc.). */
    buildInstallSequence(): string {
        const alreadyInAlternateScreen = isAlternateScreenActive();
        setAlternateScreenActive(true);

        // During `/reload` the old extension instance keeps the terminal in the
        // alternate screen. Re-entering or homing the cursor would cause a
        // visible flicker; we only need to repaint, which the first render pass
        // does.
        return (
            beginSynchronizedOutput() +
            (alreadyInAlternateScreen
                ? ""
                : enterAlternateScreen() + eraseDisplay() + homeCursor()) +
            this.enableAlternateScreenKeyboardMode() +
            disableAlternateScrollMode() +
            disableFocusEvents() +
            enableBracketedPaste() +
            this.mouseReportingStateGuard() +
            endSynchronizedOutput()
        );
    }

    // ── Keyboard modes ────────────────────────────────────────

    private activeExtendedKeyboardMode(): ExtendedKeyboardMode | null {
        if (this.terminal.kittyProtocolActive === true) return "kitty";
        if (this.terminal.modifyOtherKeysActive === true)
            return "modifyOtherKeys";
        return null;
    }

    private enableAlternateScreenKeyboardMode(): string {
        this.extendedKeyboardMode = this.activeExtendedKeyboardMode();
        return this.extendedKeyboardMode
            ? enableExtendedKeyboardMode(this.extendedKeyboardMode)
            : "";
    }

    // ── Terminal state restore ────────────────────────────────

    /** Build the terminal restore escape sequence. */
    restoreTerminalState(options: DisposeOptions = {}): string {
        // During `/reload` the new extension instance will repaint immediately.
        // Erasing the screen here leaves a blank frame between instances, so
        // we emit nothing and let the new install re-establish modes.
        if (options.reason === "reload") {
            return "";
        }

        const activeMode =
            this.extendedKeyboardMode ?? this.activeExtendedKeyboardMode();
        const restoreMainScreenMode =
            !options.resetExtendedKeyboardModes &&
            this.extendedKeyboardMode === null &&
            activeMode !== null;

        return (
            beginSynchronizedOutput() +
            eraseDisplay() +
            homeCursor() +
            resetScrollRegion() +
            (this.mouseScroll ? this.emitDisableMouseReporting() : "") +
            (activeMode ? disableExtendedKeyboardMode(activeMode) : "") +
            disableBracketedPaste() +
            enableAlternateScrollMode() +
            (options.exitAlternateScreen !== false
                ? (setAlternateScreenActive(false), exitAlternateScreen())
                : "") +
            (restoreMainScreenMode && activeMode
                ? enableExtendedKeyboardMode(activeMode)
                : "") +
            (options.resetExtendedKeyboardModes
                ? resetExtendedKeyboardModes()
                : "") +
            endSynchronizedOutput()
        );
    }

    /** Build terminal restore for process-exit cleanup. */
    restoreTerminalStateForExit(): string {
        return this.restoreTerminalState({ resetExtendedKeyboardModes: true });
    }

    // ── Mouse reporting ──────────────────────────────────────

    /** Return the escape sequence to (re-)enable mouse reporting if applicable. */
    mouseReportingStateGuard(): string {
        if (
            this.mouseScroll &&
            !this.mouseReportingResumeTimer &&
            !this.mouseReportingActive
        ) {
            return this.emitEnableMouseReporting();
        }
        return "";
    }

    private emitEnableMouseReporting(): string {
        this.mouseReportingActive = true;
        return enableMouseReporting();
    }

    private emitDisableMouseReporting(): string {
        this.mouseReportingActive = false;
        return disableMouseReporting();
    }

    /**
     * Pause mouse reporting for a context menu (right-click). Optionally
     * restores clipboard text when the user dismisses a context menu without
     * altering the selection.
     */
    pauseMouseReportingForContextMenu(
        textToRestoreToClipboard: string | null = null,
    ): void {
        if (this.mouseReportingResumeTimer) {
            clearTimeout(this.mouseReportingResumeTimer);
        }
        if (this.clipboardRestoreTimer) {
            clearTimeout(this.clipboardRestoreTimer);
            this.clipboardRestoreTimer = null;
        }

        this.originalWrite(
            beginSynchronizedOutput() +
                this.emitDisableMouseReporting() +
                endSynchronizedOutput(),
        );
        this.mouseReportingResumeTimer = setTimeout(() => {
            this.mouseReportingResumeTimer = null;
            if (!this.disposed) {
                this.originalWrite(
                    beginSynchronizedOutput() +
                        this.emitEnableMouseReporting() +
                        endSynchronizedOutput(),
                );
            }
        }, CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS);

        if (
            typeof this.mouseReportingResumeTimer === "object" &&
            "unref" in this.mouseReportingResumeTimer
        ) {
            this.mouseReportingResumeTimer.unref();
        }

        const restoreClipboard = this.getOnCopySelection();
        if (!textToRestoreToClipboard || !restoreClipboard) return;

        let remainingRestores = Math.ceil(
            CONTEXT_MENU_SELECTION_RESTORE_WINDOW_MS /
                CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS,
        );
        const scheduleClipboardRestore = () => {
            this.clipboardRestoreTimer = setTimeout(() => {
                this.clipboardRestoreTimer = null;
                if (this.disposed) return;

                remainingRestores -= 1;
                if (
                    this.getSelectedTextNow() !== textToRestoreToClipboard
                ) {
                    return;
                }

                restoreClipboard(textToRestoreToClipboard);
                if (remainingRestores > 0) {
                    scheduleClipboardRestore();
                }
            }, CONTEXT_MENU_CLIPBOARD_RESTORE_INTERVAL_MS);

            if (
                typeof this.clipboardRestoreTimer === "object" &&
                "unref" in this.clipboardRestoreTimer
            ) {
                this.clipboardRestoreTimer.unref();
            }
        };

        scheduleClipboardRestore();
    }
}
