export type SpecPath = (string | number)[];
export type LineMap = Map<number, SpecPath>;

export class Emitter {
  #lines: string[] = [];
  #map: LineMap = new Map();
  #depth = 0;

  line(text = "", origin?: SpecPath): this {
    this.#lines.push(text === "" ? "" : "  ".repeat(this.#depth) + text);
    if (origin) this.#map.set(this.#lines.length, [...origin]);
    return this;
  }

  lines(texts: string[], origin?: SpecPath): this {
    for (const t of texts) this.line(t, origin);
    return this;
  }

  indent(): this {
    this.#depth++;
    return this;
  }

  dedent(): this {
    this.#depth = Math.max(0, this.#depth - 1);
    return this;
  }

  text(): string {
    return this.#lines.length === 0 ? "" : this.#lines.join("\n") + "\n";
  }

  map(): LineMap {
    return new Map(this.#map);
  }
}
