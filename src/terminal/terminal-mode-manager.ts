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

export function isAlternateScreenActive(): boolean {
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
          // During session switches the new compositor will repaint
          // immediately.  Erasing the screen here drops Pi's existing frame,
          // leaving Pi's restore-protocol writes visible on a blank canvas.
          if (
              options.reason === "reload" ||
              options.reason === "resume" ||
              options.reason === "fork"
          ) {
              return "";
          }

        const activeMode =
            this.extendedKeyboardMode ?? this.activeExtendedKeyboardMode();

        // When exiting the alternate screen (returning to the shell), always
        // do a full keyboard-mode reset.  The shell does not want kitty
        // keyboard protocol or modifyOtherKeys active — either would garble
        // every keystroke by encoding them as longer escape sequences.
        const exitingAltScreen = options.exitAlternateScreen !== false;
        const doFullKeyboardReset =
            exitingAltScreen || options.resetExtendedKeyboardModes === true;

        // restoreMainScreenMode only applies when staying in Pi (session
        // switch, not quit): re-enable the keyboard mode that Pi itself
        // uses on the main screen.
        const restoreMainScreenMode =
            !exitingAltScreen &&
            !options.resetExtendedKeyboardModes &&
            this.extendedKeyboardMode === null &&
            activeMode !== null;

        // Ghostty-specific: ALL mode-reset sequences must be sent BEFORE
        // \x1b[?1049l (exit alternate screen).  If any escape sequence is sent
        // AFTER the alt-screen exit, it lands on the primary screen where
        // Ghostty may not process it reliably, leaving terminal modes (kitty
        // keyboard protocol, synchronized output, etc.) active.  This renders
        // shell input completely unusable until the terminal is reset.
        // Everything that must happen WHILE the alternate screen is active.
        const preExitAlt =
            beginSynchronizedOutput() +
            eraseDisplay() +
            homeCursor() +
            resetScrollRegion() +
            (this.mouseScroll ? this.emitDisableMouseReporting() : "") +
            disableBracketedPaste() +
            enableAlternateScrollMode() +
            endSynchronizedOutput();

        // Kitty protocol pop/reset must happen AFTER \x1b[?1049l so it lands
        // on the MAIN screen's stack where Pi pushed the protocol.
        const postExitAlt =
            (activeMode ? disableExtendedKeyboardMode(activeMode) : "") +
            (restoreMainScreenMode && activeMode
                ? enableExtendedKeyboardMode(activeMode)
                : "") +
            (doFullKeyboardReset ? resetExtendedKeyboardModes() : "");

        if (!exitingAltScreen) {
            return preExitAlt;
        }

        setAlternateScreenActive(false);
        return preExitAlt + exitAlternateScreen() + postExitAlt;
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
            !this.mouseReportingResumeTimer
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
