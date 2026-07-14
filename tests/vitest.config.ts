import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        conditions: ["development", "import"],
    },
    test: {
        include: ["**/*.test.ts"],
    },
});
