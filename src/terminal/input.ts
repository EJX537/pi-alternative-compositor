import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { SgrMousePacket } from "./types.js";

export type { SgrMousePacket };

export interface SgrMouseParseResult {
    packets: SgrMousePacket[];
    /** Number of bytes from the start of `data` that were consumed. */
    consumed: number;
}

// ── Keyboard scroll patterns ─────────────────────────────────

const PAGE_UP_PATTERN = new RegExp(
    "^\\u001b\\[(?:5;9(?::[12])?~|1;6(?::[12])?A|57421;9(?::[12])?u|57419;6(?::[12])?u)$",
);
const PAGE_DOWN_PATTERN = new RegExp(
    "^\\u001b\\[(?:6;9(?::[12])?~|1;6(?::[12])?B|57422;9(?::[12])?u|57420;6(?::[12])?u)$",
);

// ── SGR mouse pattern ────────────────────────────────────────

export const SGR_MOUSE_PATTERN = new RegExp(
    "\\u001b\\[<(\\d+);(\\d+);(\\d+)([Mm])",
    "g",
);

// ── Keyboard input ───────────────────────────────────────────

export function isRootSubmitInput(data: string): boolean {
    return (
        !isKeyRelease(data) &&
        (matchesKey(data, "enter") || matchesKey(data, "return"))
    );
}

export function parseKeyboardScrollDelta(data: string): number {
    if (isKeyRelease(data)) return 0;

    if (
        matchesKey(data, "pageUp") ||
        matchesKey(data, "ctrl+shift+up") ||
        PAGE_UP_PATTERN.test(data)
    )
        return 10;
    if (
        matchesKey(data, "pageDown") ||
        matchesKey(data, "ctrl+shift+down") ||
        PAGE_DOWN_PATTERN.test(data)
    )
        return -10;
    return 0;
}

// ── SGR mouse packets ────────────────────────────────────────

/**
 * Extract SGR mouse packets from input data.
 *
 * Terminals sometimes interleave mouse sequences with other input events
 * (focus events, bracketed-paste boundaries, key releases, etc.). This parser
 * locates every complete SGR mouse packet and reports how many leading bytes
 * were consumed, so the caller can pass any remaining bytes back to Pi.
 */
export function parseSgrMousePackets(
    data: string,
): SgrMouseParseResult | null {
    SGR_MOUSE_PATTERN.lastIndex = 0;
    const packets: SgrMousePacket[] = [];
    let consumed = 0;

    for (const match of data.matchAll(SGR_MOUSE_PATTERN)) {
        if (match.index === undefined) continue;
        packets.push({
            code: Number(match[1]),
            col: Number(match[2]),
            row: Number(match[3]),
            final: match[4] as "M" | "m",
        });
        consumed = Math.max(consumed, match.index + match[0].length);
    }

    return packets.length > 0 ? { packets, consumed } : null;
}

export function mouseBaseButton(code: number): number {
    return code & ~(4 | 8 | 16 | 32);
}

export function mouseScrollDelta(packet: SgrMousePacket): number {
    if (packet.final !== "M") return 0;
    const baseButton = mouseBaseButton(packet.code);
    if (baseButton === 64) return 3;
    if (baseButton === 65) return -3;
    return 0;
}

export function isLeftPress(packet: SgrMousePacket): boolean {
    return (
        packet.final === "M" &&
        mouseBaseButton(packet.code) === 0 &&
        (packet.code & 32) === 0
    );
}

export function isLeftDrag(packet: SgrMousePacket): boolean {
    return (
        packet.final === "M" &&
        mouseBaseButton(packet.code) === 0 &&
        (packet.code & 32) !== 0
    );
}

export function isRightPress(packet: SgrMousePacket): boolean {
    return (
        packet.final === "M" &&
        mouseBaseButton(packet.code) === 2 &&
        (packet.code & 32) === 0
    );
}

export function isMouseRelease(packet: SgrMousePacket): boolean {
    return packet.final === "m";
}

export function isMouseMotion(packet: SgrMousePacket): boolean {
    return (
        packet.final === "M" &&
        (packet.code & 32) !== 0 &&
        mouseBaseButton(packet.code) === 3
    );
}
