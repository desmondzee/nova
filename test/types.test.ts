import { describe, expect, it } from "vitest";
import { parseBinding, parseComponentRef } from "../src/schema/types.js";

describe("parseBinding", () => {
  it("parses a data reference", () => {
    expect(parseBinding("data#trips")).toEqual({ kind: "data", name: "trips", path: [] });
  });

  it("parses a dotted data path", () => {
    expect(parseBinding("data#trip.km")).toEqual({ kind: "data", name: "trip", path: ["km"] });
  });

  it("parses action, compute, param and filter references", () => {
    expect(parseBinding("actions#saveTravel")).toEqual({ kind: "actions", name: "saveTravel" });
    expect(parseBinding("compute#formatKm")).toEqual({ kind: "compute", name: "formatKm" });
    expect(parseBinding("params.id")).toEqual({ kind: "param", name: "id" });
    expect(parseBinding("filters.month")).toEqual({ kind: "filter", name: "month", mode: "read" });
  });

  it("parses a filter write as a distinct mode of the same reference", () => {
    // `filters.set` is unreachable from any spec until a binding form produces it, which
    // makes §5's URL round trip read-only. A write is the same filter reference in a
    // different mode rather than a fourth namespace, so NOVA2006 ("page declares no
    // filter 'x'") already covers a typo in the name with no new resolve code.
    expect(parseBinding("filters.month.set")).toEqual({
      kind: "filter",
      name: "month",
      mode: "set",
    });
  });

  it("rejects a filter path that is neither a read nor a write", () => {
    expect(parseBinding("filters.month.value")).toBeNull();
    expect(parseBinding("filters.month.set.x")).toBeNull();
    expect(parseBinding("params.id.set")).toBeNull();
  });

  it("returns null for a plain string literal", () => {
    expect(parseBinding("This month")).toBeNull();
    expect(parseBinding("data")).toBeNull();
    expect(parseBinding("data#")).toBeNull();
  });
});

describe("parseComponentRef", () => {
  it("parses a bare catalog name", () => {
    expect(parseComponentRef("Table")).toEqual({ kind: "catalog", name: "Table" });
  });

  it("parses a relative module reference", () => {
    expect(parseComponentRef("./views/charts#BridgeChart")).toEqual({
      kind: "local",
      module: "./views/charts",
      name: "BridgeChart",
    });
  });

  it("rejects a lowercase bare name, which JSX would treat as an intrinsic element", () => {
    expect(parseComponentRef("table")).toBeNull();
  });

  it("rejects a relative reference with a lowercase export name", () => {
    expect(parseComponentRef("./views/charts#helper")).toBeNull();
  });
});
