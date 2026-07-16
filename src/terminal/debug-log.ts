import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let debugLogPath: string | null = null;

export function logDebug(...parts: unknown[]): void {
    if (process.env.PI_COMPOSITOR_DEBUG !== "1") return;
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
    const line = `[${new Date().toISOString()}] ${parts.map(String).join(" ")}\n`;
    try {
        fs.appendFileSync(debugLogPath, line);
    } catch {
        // ignore
    }
}
