import { describe, it, expect } from "vitest";
import {
    SGR_MOUSE_PATTERN,
    isRootSubmitInput,
    parseKeyboardScrollDelta,
    parseSgrMousePackets,
    mouseBaseButton,
    mouseScrollDelta,
    isLeftPress,
    isLeftDrag,
    isRightPress,
    isMouseRelease,
} from "../src/terminal/input.js";

describe("input parsing", () => {
    describe("SGR_MOUSE_PATTERN", () => {
        it("matches standard SGR mouse packets", () => {
            SGR_MOUSE_PATTERN.lastIndex = 0;
            const match =
                SGR_MOUSE_PATTERN.exec("\x1b[<0;10;20M");
            expect(match).not.toBeNull();
            expect(match![1]).toBe("0");
            expect(match![2]).toBe("10");
            expect(match![3]).toBe("20");
            expect(match![4]).toBe("M");
        });

        it("matches release packets", () => {
            SGR_MOUSE_PATTERN.lastIndex = 0;
            const match =
                SGR_MOUSE_PATTERN.exec("\x1b[<0;10;20m");
            expect(match).not.toBeNull();
            expect(match![4]).toBe("m");
        });
    });

    describe("parseSgrMousePackets", () => {
        it("parses a single press packet", () => {
            const result = parseSgrMousePackets("\x1b[<0;10;20M");
            expect(result).not.toBeNull();
            expect(result!.packets).toHaveLength(1);
            expect(result!.packets[0]).toEqual({
                code: 0,
                col: 10,
                row: 20,
                final: "M",
            });
            expect(result!.consumed).toBe(11);
        });

        it("parses a single release packet", () => {
            const result = parseSgrMousePackets("\x1b[<0;10;20m");
            expect(result).not.toBeNull();
            expect(result!.packets).toHaveLength(1);
            expect(result!.packets[0]).toEqual({
                code: 0,
                col: 10,
                row: 20,
                final: "m",
            });
        });

        it("parses multiple packets", () => {
            const result = parseSgrMousePackets(
                "\x1b[<0;5;10M\x1b[<2;15;25M",
            );
            expect(result).not.toBeNull();
            expect(result!.packets).toHaveLength(2);
            expect(result!.packets[0]).toEqual({
                code: 0,
                col: 5,
                row: 10,
                final: "M",
            });
            expect(result!.packets[1]).toEqual({
                code: 2,
                col: 15,
                row: 25,
                final: "M",
            });
        });

        it("returns null for non-mouse data", () => {
            expect(parseSgrMousePackets("hello")).toBeNull();
        });

        it("returns null for empty string", () => {
            expect(parseSgrMousePackets("")).toBeNull();
        });

        it("parses packets from data with leading and trailing garbage", () => {
            const result = parseSgrMousePackets(
                "\x1b[O\x1b[<0;10;20M\x1b[I\x1b[<0;10;20mextra",
            );
            expect(result).not.toBeNull();
            expect(result!.packets).toHaveLength(2);
            expect(result!.consumed).toBe(28);
        });

        it("handles multi-digit coordinates", () => {
            const result = parseSgrMousePackets("\x1b[<64;123;456M");
            expect(result).not.toBeNull();
            expect(result!.packets).toHaveLength(1);
            expect(result!.packets[0]).toEqual({
                code: 64,
                col: 123,
                row: 456,
                final: "M",
            });
        });
    });

    describe("mouseBaseButton", () => {
        it("strips modifier flags for button 0", () => {
            expect(mouseBaseButton(0)).toBe(0);
        });

        it("strips modifier flags for button 2", () => {
            expect(mouseBaseButton(2)).toBe(2);
        });

        it("strips modifier flags (32 = drag flag)", () => {
            expect(mouseBaseButton(32)).toBe(0);
            expect(mouseBaseButton(34)).toBe(2);
        });

        it("strips all modifier flags (4|8|16|32)", () => {
            expect(mouseBaseButton(4 | 8 | 16 | 32 | 0)).toBe(0);
            expect(mouseBaseButton(4 | 8 | 16 | 32 | 64)).toBe(64);
        });
    });

    describe("mouseScrollDelta", () => {
        it("returns 3 for wheel up (code 64)", () => {
            const packet = { code: 64, col: 1, row: 1, final: "M" as const };
            expect(mouseScrollDelta(packet)).toBe(3);
        });

        it("returns -3 for wheel down (code 65)", () => {
            const packet = { code: 65, col: 1, row: 1, final: "M" as const };
            expect(mouseScrollDelta(packet)).toBe(-3);
        });

        it("returns 0 for non-scroll buttons", () => {
            const packet = { code: 0, col: 1, row: 1, final: "M" as const };
            expect(mouseScrollDelta(packet)).toBe(0);
        });

        it("returns 0 for release packets", () => {
            const packet = { code: 64, col: 1, row: 1, final: "m" as const };
            expect(mouseScrollDelta(packet)).toBe(0);
        });
    });

    describe("mouse button classification", () => {
        it("isLeftPress — button 0, no drag, press", () => {
            expect(
                isLeftPress({
                    code: 0,
                    col: 1,
                    row: 1,
                    final: "M",
                }),
            ).toBe(true);
        });

        it("isLeftPress — button 0 with drag flag is not a new press", () => {
            expect(
                isLeftPress({
                    code: 32,
                    col: 1,
                    row: 1,
                    final: "M",
                }),
            ).toBe(false);
        });

        it("isLeftPress — release packet is not a press", () => {
            expect(
                isLeftPress({
                    code: 0,
                    col: 1,
                    row: 1,
                    final: "m",
                }),
            ).toBe(false);
        });

        it("isLeftDrag — button 0 with drag flag", () => {
            expect(
                isLeftDrag({
                    code: 32,
                    col: 1,
                    row: 1,
                    final: "M",
                }),
            ).toBe(true);
        });

        it("isLeftDrag — button 0 without drag flag is not a drag", () => {
            expect(
                isLeftDrag({
                    code: 0,
                    col: 1,
                    row: 1,
                    final: "M",
                }),
            ).toBe(false);
        });

        it("isLeftDrag — release packet is not a drag", () => {
            expect(
                isLeftDrag({
                    code: 32,
                    col: 1,
                    row: 1,
                    final: "m",
                }),
            ).toBe(false);
        });

        it("isRightPress — button 2, no drag, press", () => {
            expect(
                isRightPress({
                    code: 2,
                    col: 1,
                    row: 1,
                    final: "M",
                }),
            ).toBe(true);
        });

        it("isRightPress — button 0 is not right", () => {
            expect(
                isRightPress({
                    code: 0,
                    col: 1,
                    row: 1,
                    final: "M",
                }),
            ).toBe(false);
        });

        it("isMouseRelease — final 'm'", () => {
            expect(
                isMouseRelease({
                    code: 0,
                    col: 1,
                    row: 1,
                    final: "m",
                }),
            ).toBe(true);
        });

        it("isMouseRelease — final 'M' is not release", () => {
            expect(
                isMouseRelease({
                    code: 0,
                    col: 1,
                    row: 1,
                    final: "M",
                }),
            ).toBe(false);
        });
    });

    describe("isRootSubmitInput", () => {
        it("returns true for enter", () => {
            expect(isRootSubmitInput("\r")).toBe(true);
            expect(isRootSubmitInput("\n")).toBe(true);
        });

        it("returns false for other keys", () => {
            expect(isRootSubmitInput("a")).toBe(false);
            expect(isRootSubmitInput("\x1b[A")).toBe(false);
        });

        it("returns false for key releases", () => {
            // CSI sequence with release info
            expect(isRootSubmitInput("\x1b[1;2A")).toBe(false);
        });
    });

    describe("parseKeyboardScrollDelta", () => {
        it("returns 10 for page up (CSI ~ form)", () => {
            expect(parseKeyboardScrollDelta("\x1b[5~")).toBe(10);
        });

        it("returns -10 for page down (CSI ~ form)", () => {
            expect(parseKeyboardScrollDelta("\x1b[6~")).toBe(-10);
        });

        it("returns 0 for non-scroll keys", () => {
            expect(parseKeyboardScrollDelta("a")).toBe(0);
            expect(parseKeyboardScrollDelta("\x1b[A")).toBe(0);
        });

        it("returns 0 for enter", () => {
            expect(parseKeyboardScrollDelta("\r")).toBe(0);
        });
    });
});
