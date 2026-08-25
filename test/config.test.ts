import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/compile/config.js";
import type { NovaConfig } from "../src/compile/config.js";
import { compileApp } from "../src/compile/index.js";
import { missingCompilerApi } from "../src/compile/program.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturesDir = here("./fixtures/");
const at = { file: "app.yaml", line: 1, col: 1 };

const dirs: string[] = [];
function fixtureCopy(): string {
  const root = mkdtempSync(join(fixturesDir, "tmp-cfg-"));
  dirs.push(root);
  cpSync(join(fixturesDir, "app-basic"), join(root, "app-basic"), { recursive: true });
  cpSync(join(fixturesDir, "tsconfig.json"), join(root, "tsconfig.json"));
  cpSync(join(fixturesDir, "catalog"), join(root, "catalog"), { recursive: true });
  return join(root, "app-basic");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.json"),
});

/**
 * The peer range says `>=5.5 <7`, but a range binds a package manager, not a
 * `node_modules` that already exists. `missingCompilerApi` is the runtime half, and it
 * is a pure function precisely so the unsupported case can be exercised without
 * installing an unsupported TypeScript.
 */
describe("the resolved TypeScript", () => {
  it("names every entry point a TypeScript 7 main entry does not have", () => {
    // TypeScript 7.0.2's main entry, verbatim: `Object.keys(ts)` is these two.
    expect(missingCompilerApi({ version: "7.0.2", versionMajorMinor: "7.0" })).toEqual([
      "createCompilerHost",
      "createProgram",
      "flattenDiagnosticMessageText",
      "isTypeParameterDeclaration",
      "parseJsonConfigFileContent",
      "readConfigFile",
      "resolveModuleName",
      "sys",
    ]);
  });

  it("accepts the TypeScript this repo resolves", async () => {
    const ts = (await import("typescript")).default;
    expect(missingCompilerApi(ts)).toEqual([]);
  });

  it("names a partial namespace's gaps, not the whole list", () => {
    const partial = {
      version: "5.9.3",
      createCompilerHost: () => {},
      createProgram: () => {},
      flattenDiagnosticMessageText: () => {},
      isTypeParameterDeclaration: () => {},
      parseJsonConfigFileContent: () => {},
      readConfigFile: () => {},
      sys: {},
    };
    expect(missingCompilerApi(partial)).toEqual(["resolveModuleName"]);
  });
});

/**
 * `NovaConfig` is a type, and a type checks nothing for a host writing JavaScript or
 * reading its config out of JSON. Each of these used to be a raw throw from whichever
 * stage first touched the field — the worst being `Error: Debug Failure.` from inside
 * `typescript.js` for a missing `tsconfigPath`.
 */
describe("validateConfig", () => {
  const complete: NovaConfig = {
    components: ["@acme/ui"],
    states: { loading: "Loading", error: "ErrorNotice" },
    outDir: "generated",
    tsconfigPath: "tsconfig.json",
  };

  it("passes a complete config", () => {
    expect(validateConfig(complete, at)).toEqual([]);
    expect(
      validateConfig({ ...complete, shell: "Shell", basePath: "/api", importExtension: ".js" }, at),
    ).toEqual([]);
  });

  it.each(["components", "states", "outDir", "tsconfigPath"] as const)(
    "names the missing field '%s'",
    (field) => {
      const partial = { ...complete };
      delete (partial as Record<string, unknown>)[field];
      const diagnostics = validateConfig(partial, at);
      expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2014"]);
      expect(diagnostics[0]!.message).toContain(`'${field}'`);
    },
  );

  it("names a missing state by its own path", () => {
    const diagnostics = validateConfig({ ...complete, states: { loading: "Loading" } }, at);
    expect(diagnostics.map((d) => d.message)).toEqual([
      "nova.config is missing 'states.error'",
    ]);
  });

  it("reports every problem in one run", () => {
    expect(validateConfig({}, at)).toHaveLength(4);
  });

  it("rejects a config that is not an object at all", () => {
    for (const value of [undefined, null, "generated", 7]) {
      expect(validateConfig(value, at).map((d) => d.code)).toEqual(["NOVA2014"]);
    }
  });

  /**
   * Documented as `"" | ".js"` and "nothing else is accepted", which was true of the
   * type and false of the runtime: `".mjs"` produced nine NOVA3001/NOVA3002s about
   * modules that do not exist.
   */
  it("rejects an importExtension the emitter cannot write", () => {
    const diagnostics = validateConfig({ ...complete, importExtension: ".mjs" }, at);
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2014"]);
    expect(diagnostics[0]!.message).toContain(".mjs");
  });
});

describe("compileApp with a bad config", () => {
  it("reports the missing field instead of throwing out of typescript", async () => {
    const appDir = fixtureCopy();
    const config = configFor(appDir) as Record<string, unknown>;
    delete config["tsconfigPath"];
    const result = await compileApp(appDir, config as unknown as NovaConfig);
    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2014"]);
    expect(result.diagnostics[0]!.message).toContain("tsconfigPath");
  });

  it("reports a missing states before the emitter dereferences it", async () => {
    const appDir = fixtureCopy();
    const config = configFor(appDir) as Record<string, unknown>;
    delete config["states"];
    const result = await compileApp(appDir, config as unknown as NovaConfig);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2014"]);
    expect(result.diagnostics[0]!.message).toContain("states");
  });

  it("reports an app folder that is not a path", async () => {
    const result = await compileApp(undefined as unknown as string, {
      components: [],
      states: { loading: "L", error: "E" },
      outDir: "generated",
      tsconfigPath: "tsconfig.json",
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2014"]);
  });
});
