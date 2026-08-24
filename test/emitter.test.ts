import { describe, expect, it } from "vitest";
import { Emitter } from "../src/compile/emit/emitter.js";

describe("Emitter", () => {
  it("joins lines with a single trailing newline", () => {
    const e = new Emitter();
    e.line("a").line("b");
    expect(e.text()).toBe("a\nb\n");
  });

  it("emits a blank line for no argument", () => {
    const e = new Emitter();
    e.line("a").line().line("b");
    expect(e.text()).toBe("a\n\nb\n");
  });

  it("applies two-space indentation and never indents blank lines", () => {
    const e = new Emitter();
    e.line("outer").indent().line("inner").line().dedent().line("outer again");
    expect(e.text()).toBe("outer\n  inner\n\nouter again\n");
  });

  it("records the spec origin of a line, one-based", () => {
    const e = new Emitter();
    e.line("first").line("second", ["pages", "/", "sections", 0]);
    expect(e.map().get(2)).toEqual(["pages", "/", "sections", 0]);
  });

  it("records nothing for lines with no origin", () => {
    const e = new Emitter();
    e.line("first");
    expect(e.map().has(1)).toBe(false);
  });

  it("applies one origin across a block of lines", () => {
    const e = new Emitter();
    e.lines(["a", "b"], ["pages", "/"]);
    expect(e.map().get(1)).toEqual(["pages", "/"]);
    expect(e.map().get(2)).toEqual(["pages", "/"]);
  });

  it("never dedents past zero", () => {
    const e = new Emitter();
    e.dedent().dedent().line("x");
    expect(e.text()).toBe("x\n");
  });
});
