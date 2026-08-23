import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let debugLogPath: string | null = null;

function appendLog(level: string, parts: unknown[]): void {
    if (!debugLogPath) {
        debugLogPath = path.join(
            os.homedir(),
            ".pi",
            "agent",
            "pi-alternative-compositor-debug.log",
        );
        try {
            fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
        } catch {
            // ignore
        }
    }
    const line = `[${new Date().toISOString()}] ${level} ${parts
        .map(String)
        .join(" ")}\n`;
    try {
        fs.appendFileSync(debugLogPath, line);
    } catch {
        // ignore
    }
}

export function logDebug(...parts: unknown[]): void {
    if (process.env.PI_COMPOSITOR_DEBUG !== "1") return;
    appendLog("DEBUG", parts);
}

/**
 * Always-on error logging. Unlike logDebug, this is NOT gated behind
 * PI_COMPOSITOR_DEBUG: errors that pi would otherwise paint over (e.g. during
 * /resume session switches) must be recoverable from the log file even when
 * debug logging is off.
 */
export function logError(...parts: unknown[]): void {
    appendLog("ERROR", parts);
    // Also mirror to stderr so the error is visible when pi is run from a
    // terminal that captures stderr (or when the TUI has crashed/exited).
    try {
        console.error("[pi-alternative-compositor]", ...parts.map(String));
    } catch {
        // ignore
    }
}
