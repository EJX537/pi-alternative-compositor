import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings, loadSettingsSync, saveSettings } from "../src/app/settings-store";

const directories: string[] = [];

async function createTempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-compositor-settings-"));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true,
    })));
});

describe("compositor settings", () => {
    it("uses disabled sidebar defaults when Pi settings do not exist", async () => {
        const agentDir = await createTempDirectory();
        await expect(loadSettings(agentDir)).resolves.toEqual({
            enableSidebar: false,
        });
    });

    it("merges compositor.enableSidebar into Pi settings.json", async () => {
        const agentDir = await createTempDirectory();
        await writeFile(
            join(agentDir, "settings.json"),
            JSON.stringify({ theme: "dracula", compositor: { other: true } }),
            "utf8",
        );
        await saveSettings({ enableSidebar: false }, agentDir);

        await expect(loadSettings(agentDir)).resolves.toEqual({
            enableSidebar: false,
        });
        const saved = JSON.parse(
            await readFile(join(agentDir, "settings.json"), "utf8"),
        );
        expect(saved).toMatchObject({
            theme: "dracula",
            compositor: { other: true, enableSidebar: false },
        });
    });

    it("reads settings synchronously from disk", async () => {
        const agentDir = await createTempDirectory();
        await writeFile(
            join(agentDir, "settings.json"),
            JSON.stringify({ compositor: { enableSidebar: true } }),
            "utf8",
        );

        expect(loadSettingsSync(agentDir)).toEqual({ enableSidebar: true });
    });

    it("falls back to defaults for synchronous read errors", async () => {
        const agentDir = await createTempDirectory();
        await writeFile(
            join(agentDir, "settings.json"),
            "not json",
            "utf8",
        );

        expect(loadSettingsSync(agentDir)).toEqual({ enableSidebar: false });
    });

    it("falls back to defaults for malformed settings", async () => {
        const agentDir = await createTempDirectory();
        await writeFile(join(agentDir, "settings.json"), "not json", "utf8");

        await expect(loadSettings(agentDir)).resolves.toEqual({
            enableSidebar: false,
        });
    });
});
