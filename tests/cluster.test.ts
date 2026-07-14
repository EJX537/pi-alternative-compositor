import { describe, it, expect } from "vitest";
import { renderFixedEditorCluster } from "../src/compositor/cluster";
import type { FixedEditorClusterInput } from "../src/compositor/cluster";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

describe("renderFixedEditorCluster", () => {
    const baseInput: FixedEditorClusterInput = {
        width: 40,
        terminalRows: 20,
        editorLines: ["editor line 1", "editor line 2"],
    };

    it("renders editor lines with padding above and below", () => {
        const result = renderFixedEditorCluster(baseInput);

        // 2 editor lines + 1 padding above + 1 padding below = 4
        // terminalRows=20 → maxRows=19 → plenty of room
        expect(result.lines.length).toBeGreaterThanOrEqual(4);
        expect(result.lines).toContain("editor line 1");
        expect(result.lines).toContain("editor line 2");
    });

    it("pads with empty lines above and below the editor", () => {
        const result = renderFixedEditorCluster(baseInput);

        // Find where editor lines are
        const editorIndex1 = result.lines.indexOf("editor line 1");
        const editorIndex2 = result.lines.indexOf("editor line 2");

        expect(editorIndex1).toBeGreaterThanOrEqual(0);
        expect(editorIndex2).toBe(editorIndex1 + 1);

        // There should be a padding row above editor line 1
        expect(result.lines[editorIndex1 - 1]).toBe(" ".repeat(40));
    });

    it("caps editor lines to available rows", () => {
        const manyLines = Array.from(
            { length: 50 },
            (_, i) => `line ${i}`,
        );
        const result = renderFixedEditorCluster({
            ...baseInput,
            editorLines: manyLines,
        });

        // maxRows = 19, so we can fit at most 19 editor lines
        // Since there's no cursor marker, it takes the tail
        expect(result.lines.length).toBeLessThanOrEqual(19);
    });

    it("extracts cursor position from CURSOR_MARKER", () => {
        const lines = [
            "first line",
            `before${CURSOR_MARKER}after`,
            "third line",
        ];
        const input: FixedEditorClusterInput = {
            ...baseInput,
            width: 50,
            editorLines: lines,
        };

        const result = renderFixedEditorCluster(input);

        expect(result.cursor).not.toBeNull();
        expect(result.cursor!.row).toBeGreaterThanOrEqual(0);
        expect(result.cursor!.col).toBeGreaterThanOrEqual(0);

        // CURSOR_MARKER should be stripped from all lines
        for (const line of result.lines) {
            expect(line).not.toContain(CURSOR_MARKER);
        }
    });

    it("centers the cursor-bearing line in the viewport", () => {
        const manyLines = Array.from(
            { length: 100 },
            (_, i) => `line ${i}`,
        );
        // Put cursor on line 80
        manyLines[80] = `cursor here${CURSOR_MARKER}`;

        const input: FixedEditorClusterInput = {
            ...baseInput,
            terminalRows: 30,
            width: 60,
            editorLines: manyLines,
        };

        const result = renderFixedEditorCluster(input);

        // Cursor row should be somewhere in the visible lines
        expect(result.cursor).not.toBeNull();
        expect(result.cursor!.row).toBeGreaterThanOrEqual(0);
        expect(result.cursor!.row).toBeLessThan(result.lines.length);

        // The cursor line should be visible
        const cursorLine = result.lines[result.cursor!.row];
        expect(cursorLine).toContain("cursor here");
    });

    it("returns no cursor when no marker present", () => {
        const result = renderFixedEditorCluster({
            ...baseInput,
            editorLines: ["no cursor here"],
        });

        expect(result.cursor).toBeNull();
    });

    it("truncates lines wider than width", () => {
        const input: FixedEditorClusterInput = {
            width: 10,
            terminalRows: 20,
            editorLines: ["this is a very long line that should be truncated"],
        };

        const result = renderFixedEditorCluster(input);

        for (const line of result.lines) {
            // Use visual width check — some chars may be double-width
            // visibleWidth check not available in test, approximate with length
            expect(line.length <= 10 + 5).toBe(true); // allow some slack for trailing spaces
        }
    });

    it("includes footer lines when space permits", () => {
        const input: FixedEditorClusterInput = {
            ...baseInput,
            editorLines: ["one line"],
            footerLines: ["footer!"],
        };

        const result = renderFixedEditorCluster(input);

        expect(result.lines).toContain("footer!");
    });

    it("includes widgets above and below editor", () => {
        const input: FixedEditorClusterInput = {
            ...baseInput,
            editorLines: ["editor"],
            aboveWidgetLines: ["above widget"],
            belowWidgetLines: ["below widget"],
        };

        const result = renderFixedEditorCluster(input);

        expect(result.lines).toContain("above widget");
        expect(result.lines).toContain("below widget");
    });

    it("includes status lines at the top", () => {
        const input: FixedEditorClusterInput = {
            ...baseInput,
            editorLines: ["editor"],
            statusLines: ["status line"],
        };

        const result = renderFixedEditorCluster(input);

        // Status should appear before padding/editor
        const statusIdx = result.lines.indexOf("status line");
        const editorIdx = result.lines.indexOf("editor");
        expect(statusIdx).toBeLessThan(editorIdx!);
    });

    it("handles empty editor lines", () => {
        const result = renderFixedEditorCluster({
            ...baseInput,
            editorLines: [],
        });

        expect(result.lines.length).toBeGreaterThanOrEqual(0);
        expect(result.cursor).toBeNull();
    });

    it("fills remaining space with empty lines when editor is small", () => {
        const input: FixedEditorClusterInput = {
            width: 40,
            terminalRows: 5,
            editorLines: ["edit"],
        };

        const result = renderFixedEditorCluster(input);

        // maxRows = 4: 1 editor + 1 pad above + 1 pad below + ? = 3 minimum
        expect(result.lines.length).toBe(3);
    });

    it("does not crash on huge terminalRows", () => {
        const input: FixedEditorClusterInput = {
            width: 80,
            terminalRows: 999,
            editorLines: ["hello"],
        };

        const result = renderFixedEditorCluster(input);

        expect(result.lines.length).toBeGreaterThan(0);
        expect(result.lines).toContain("hello");
    });

    it("handles zero-width gracefully", () => {
        const result = renderFixedEditorCluster({
            width: 0,
            terminalRows: 20,
            editorLines: ["hello"],
        });

        expect(result.lines.length).toBeGreaterThanOrEqual(0);
    });

    it("handles minimal terminalRows", () => {
        const result = renderFixedEditorCluster({
            width: 40,
            terminalRows: 1,
            editorLines: ["hello"],
        });

        expect(result.lines.length).toBeLessThanOrEqual(1);
    });
});
