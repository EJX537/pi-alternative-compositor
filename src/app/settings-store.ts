import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_FILE = "settings.json";

export interface CompositorSettings {
    enableSidebar: boolean;
}

export const DEFAULT_SETTINGS: CompositorSettings = {
    enableSidebar: true,
};

type RootSettings = Record<string, unknown>;

function settingsPath(agentDir: string): string {
    return join(agentDir, SETTINGS_FILE);
}

function compositorSettings(raw: unknown): CompositorSettings {
    if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS };
    const compositor = (raw as RootSettings).compositor;
    if (typeof compositor !== "object" || compositor === null) {
        return { ...DEFAULT_SETTINGS };
    }
    const enableSidebar = (compositor as Record<string, unknown>).enableSidebar;
    return {
        enableSidebar:
            typeof enableSidebar === "boolean"
                ? enableSidebar
                : DEFAULT_SETTINGS.enableSidebar,
    };
}

async function readRootSettings(agentDir: string): Promise<RootSettings> {
    try {
        const parsed: unknown = JSON.parse(
            await readFile(settingsPath(agentDir), "utf8"),
        );
        if (typeof parsed !== "object" || parsed === null) {
            throw new Error("Pi settings must be a JSON object");
        }
        return parsed as RootSettings;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
}

/** Read `compositor.enableSidebar` from Pi's global settings.json. */
export async function loadSettings(
    agentDir = getAgentDir(),
): Promise<CompositorSettings> {
    try {
        return compositorSettings(await readRootSettings(agentDir));
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

/**
 * Merge the compositor namespace into Pi's global settings.json without
 * changing any settings owned by Pi or other extensions.
 */
export async function saveSettings(
    settings: CompositorSettings,
    agentDir = getAgentDir(),
): Promise<void> {
    const root = await readRootSettings(agentDir);
    const existingCompositor = root.compositor;
    root.compositor = {
        ...(typeof existingCompositor === "object" && existingCompositor !== null
            ? existingCompositor
            : {}),
        enableSidebar: settings.enableSidebar,
    };

    await mkdir(agentDir, { recursive: true });
    await writeFile(
        settingsPath(agentDir),
        `${JSON.stringify(root, null, 2)}\n`,
        "utf8",
    );
}
