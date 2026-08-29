import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests share one database, so running files in parallel would let them
    // delete each other's rows. One at a time is slower and correct.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
