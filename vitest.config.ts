import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Minimal config so unit tests can resolve the project's "@/..." path alias
// (mirrors tsconfig.json `paths`). Tests that mock @/lib/prisma and
// @/lib/services/unipile.service rely on this.
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
});
