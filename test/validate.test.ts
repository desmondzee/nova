import { describe, expect, it } from "vitest";
import { loadSpecFile } from "../src/compile/load.js";
import { validate } from "../src/schema/validate.js";

function check(src: string) {
  const { raw, positions } = loadSpecFile("app.yaml", src);
  return validate(raw, positions);
}

const GOOD = [
  "pages:",
  '  "/":',
  "    title: Mileage",
  "    filters:",
  "      month: { type: month, default: current }",
  "    sections:",
  "      - StatCard: { label: This month, value: data#monthlyTotal }",
  "      - Table:",
  "          rows: data#trips",
  "          columns: [date, km]",
  "",
].join("\n");

describe("validate", () => {
  it("normalises a valid document", () => {
    const { spec, diagnostics } = check(GOOD);
    expect(diagnostics).toEqual([]);
    expect(spec!.pages).toHaveLength(1);
    const page = spec!.pages[0]!;
    expect(page.route).toBe("/");
    expect(page.title).toBe("Mileage");
    expect(page.filters).toEqual([{ name: "month", type: "month", default: "current" }]);
    expect(page.sections).toHaveLength(2);
    expect(page.sections[0]!.component).toEqual({ kind: "catalog", name: "StatCard" });
    expect(page.sections[0]!.props.label).toEqual({ kind: "literal", value: "This month" });
    expect(page.sections[0]!.props.value).toEqual({
      kind: "binding",
      ref: { kind: "data", name: "monthlyTotal", path: [] },
    });
    expect(page.sections[1]!.props.columns).toEqual({ kind: "literal", value: ["date", "km"] });
  });

  it("reports an unknown page key with a suggestion", () => {
    const { diagnostics } = check('pages:\n  "/":\n    titel: Trips\n    sections: []\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("NOVA1001");
    expect(diagnostics[0]!.line).toBe(3);
    expect(diagnostics[0]!.hint).toBe("did you mean 'title'?");
  });

  it("reports a missing required key", () => {
    const { spec, diagnostics } = check('pages:\n  "/":\n    title: Trips\n');
    expect(spec).toBeNull();
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1002");
  });

  it("reports a wrong value type", () => {
    const { diagnostics } = check('pages:\n  "/":\n    sections: "nope"\n');
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1003");
  });

  it("reports a malformed component reference", () => {
    const { diagnostics } = check('pages:\n  "/":\n    sections:\n      - table: {}\n');
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1004");
  });

  it("reports an invalid route", () => {
    const { diagnostics } = check("pages:\n  trips:\n    sections: []\n");
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1005");
  });

  it("collects every problem rather than stopping at the first", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    titel: a\n    sections: "nope"\n  bad:\n    sections: []\n',
    );
    expect(diagnostics.length).toBeGreaterThanOrEqual(3);
  });
});
