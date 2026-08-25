import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The input hash stamped into every emitted file includes the compiler version, so a
 * host that skips recompilation on an unchanged stamp keeps stale output when the two
 * drift. They live in separate files, so nothing but this test couples them.
 */
describe("compiler version", () => {
  it("matches the published package version", () => {
    const root = new URL("../", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")) as {
      version: string;
    };
    const source = readFileSync(fileURLToPath(new URL("src/compile/index.ts", root)), "utf8");
    const declared = /const VERSION = "([^"]+)";/.exec(source)?.[1];
    expect(declared).toBe(pkg.version);
  });
});
