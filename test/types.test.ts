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
    expect(parseBinding("filters.month")).toEqual({ kind: "filter", name: "month" });
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
