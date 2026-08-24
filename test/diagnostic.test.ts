import { describe, expect, it } from "vitest";
import { diagnostic, suggest } from "../src/schema/diagnostic.js";

describe("diagnostic", () => {
  it("defaults to error severity and carries the position inline", () => {
    const d = diagnostic("NOVA1001", "unknown key 'sectons'", {
      file: "app.yaml",
      line: 3,
      col: 5,
    });
    expect(d).toEqual({
      code: "NOVA1001",
      severity: "error",
      message: "unknown key 'sectons'",
      file: "app.yaml",
      line: 3,
      col: 5,
    });
  });

  it("omits hint and related when not supplied", () => {
    const d = diagnostic("NOVA1001", "boom", { file: "a.yaml", line: 1, col: 1 });
    expect("hint" in d).toBe(false);
    expect("related" in d).toBe(false);
  });

  it("carries hint, severity and related when supplied", () => {
    const d = diagnostic("NOVA2001", "unknown component 'Tabel'", { file: "a.yaml", line: 9, col: 7 }, {
      severity: "warning",
      hint: "did you mean 'Table'?",
      related: [{ file: "ui.tsx", line: 1, col: 1, message: "catalog defined here" }],
    });
    expect(d.severity).toBe("warning");
    expect(d.hint).toBe("did you mean 'Table'?");
    expect(d.related).toHaveLength(1);
  });
});

describe("suggest", () => {
  it("finds the nearest candidate within edit distance 2", () => {
    expect(suggest("Tabel", ["Table", "StatCard", "Row"])).toBe("Table");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(suggest("Wombat", ["Table", "StatCard", "Row"])).toBeUndefined();
  });

  it("prefers the closest candidate when several are near", () => {
    expect(suggest("Ro", ["Row", "Root", "Table"])).toBe("Row");
  });

  it("breaks a genuine tie (equal edit distance) alphabetically", () => {
    // "Cel" is edit distance 1 from both "Col" (e/o substitution) and "Bel"
    // (c/b substitution) — a real tie, not one resolved by the distance filter.
    expect(suggest("Cel", ["Col", "Bel"])).toBe("Bel");
  });
});
