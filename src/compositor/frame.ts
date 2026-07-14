import { sanitizeLine } from "./text.js";
import type { FixedEditorClusterRender } from "./cluster.js";

const esc = "\x1b[";
const moveCursor = (row: number, col: number) => `${esc}${row};${col}H`;

/** Construct fixed-cluster bytes only; callers own terminal writes and modes. */
export function buildFixedClusterPaint(
    cluster: FixedEditorClusterRender,
    terminalRows: number,
    width: number,
    showHardwareCursor: boolean,
): string {
    if (cluster.lines.length === 0) return "";
    const startRow = Math.max(1, terminalRows - cluster.lines.length + 1);
    let buffer = `${esc}r`;
    for (let i = 0; i < cluster.lines.length; i++)
        buffer +=
            moveCursor(startRow + i, 1) +
            `${esc}2K` +
            sanitizeLine(cluster.lines[i] ?? "", width);
    return cluster.cursor && showHardwareCursor
        ? buffer +
              moveCursor(
                  startRow + cluster.cursor.row,
                  Math.max(1, cluster.cursor.col + 1),
              ) +
              `${esc}?25h`
        : buffer + `${esc}?25l`;
}
