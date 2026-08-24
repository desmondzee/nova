import { describe, expect, it } from "vitest";
import { loadSpecFile } from "../src/compile/load.js";

const SRC = ['pages:', '  "/":', "    title: Trips", "    sections:", "      - Table", ""].join("\n");

describe("loadSpecFile", () => {
  it("parses the document into plain JS values", () => {
    const { raw, diagnostics } = loadSpecFile("app.yaml", SRC);
    expect(diagnostics).toEqual([]);
    expect(raw).toEqual({ pages: { "/": { title: "Trips", sections: ["Table"] } } });
  });

  it("maps a nested path to the position of its value", () => {
    const { positions } = loadSpecFile("app.yaml", SRC);
    expect(positions.at(["pages", "/", "title"])).toEqual({ file: "app.yaml", line: 3, col: 12 });
  });

  it("maps a sequence index", () => {
    const { positions } = loadSpecFile("app.yaml", SRC);
    expect(positions.at(["pages", "/", "sections", 0])).toEqual({
      file: "app.yaml",
      line: 5,
      col: 9,
    });
  });

  it("falls back to the nearest existing ancestor for a missing path", () => {
    const { positions } = loadSpecFile("app.yaml", SRC);
    expect(positions.at(["pages", "/", "nope"])).toEqual({ file: "app.yaml", line: 3, col: 5 });
  });

  it("returns a diagnostic instead of throwing on malformed YAML", () => {
    const { raw, diagnostics } = loadSpecFile("app.yaml", "pages:\n  - a\n  b: c\n");
    expect(raw).toBeNull();
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.code).toBe("NOVA1000");
    expect(diagnostics[0]!.file).toBe("app.yaml");
  });
});
