import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node", // DOM tests opt in with: // @vitest-environment jsdom
  },
});
