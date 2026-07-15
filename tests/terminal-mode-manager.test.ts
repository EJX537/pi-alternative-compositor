import { describe, expect, it } from "vitest";
import { TerminalModeManager } from "../src/terminal/terminal-mode-manager";

function makeTerminal() {
    const writes: string[] = [];
    const terminal = {
        columns: 80,
        rows: 24,
        kittyProtocolActive: false,
        modifyOtherKeysActive: false,
        write: (data: string) => writes.push(data),
    };
    return { terminal, writes };
}

function makeManager() {
    const { terminal, writes } = makeTerminal();
    const manager = new TerminalModeManager(
        terminal as unknown as import("../src/terminal/terminal-mode-manager").TerminalModeManager["terminal"],
        true,
        (data: string) => terminal.write(data),
        () => null,
        () => "",
    );
    return { manager, terminal, writes };
}

describe("TerminalModeManager", () => {
    it("enables bracketed paste on install", () => {
        const { manager, writes } = makeManager();
        const sequence = manager.buildInstallSequence();
        expect(sequence).toContain("\x1b[?2004h"); // enable bracketed paste
        expect(sequence).not.toContain("\x1b[?2004l"); // should not disable it
        expect(writes).toHaveLength(0); // buildInstallSequence does not write
    });

    it("disables bracketed paste on restore", () => {
        const { manager } = makeManager();
        manager.buildInstallSequence();
        const sequence = manager.restoreTerminalState();
        expect(sequence).toContain("\x1b[?2004l"); // disable bracketed paste
        expect(sequence).not.toContain("\x1b[?2004h"); // should not enable it
    });

    it("emergency exit reset disables bracketed paste", () => {
        const { manager } = makeManager();
        manager.buildInstallSequence();
        const sequence = manager.restoreTerminalStateForExit();
        expect(sequence).toContain("\x1b[?2004l");
    });
});
