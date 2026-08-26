import { diagnostic, type Diagnostic, type Position } from "../schema/diagnostic.js";

export type NovaConfig = {
  /** Module specifiers whose capitalised callable exports are usable in specs. */
  components: string[];
  /**
   * Catalog component names for the generated states.
   *
   * `loading` and `error` are rendered by every page that binds a loader — `<Loading />`
   * with no props at all, and `<ErrorNotice>{message}</ErrorNotice>` with the message as
   * children. `empty` is optional because no generated page renders one: a section knows
   * whether its own rows are empty and nova does not, so the empty state belongs to the
   * section component (a table's own `empty:` prop). Where it is given it is still
   * checked against the catalog, so a host that has one can keep naming it.
   */
  states: { loading: string; error: string; empty?: string };
  /**
   * Catalog component wrapping every page: nova renders `<Shell title={…}>` around a
   * page's sections — and around its loading and error states, so the page's own chrome
   * does not vanish while it loads. It receives the page's `title:` (omitted when the
   * page declares none) and the sections as `children`, and it is where spacing between
   * top-level sections belongs.
   *
   * Optional. Without one a page's sections emit into a bare `<></>`, which is what
   * every generated page did before shells existed — so leaving it unset changes
   * nothing. With one, `title:` has somewhere to go; that is why there is no longer a
   * `titles` map.
   */
  shell?: string;
  /** Directory name, relative to the app folder, for emitted files. */
  outDir: string;
  /** tsconfig used to resolve modules and typecheck emitted output. */
  tsconfigPath: string;
  /** Extension appended to relative imports in emitted code. "" for bundler resolution. */
  importExtension?: "" | ".js";
  /**
   * Prop names whose literal string-array value nova checks against the row type the
   * section's loader returns, beside its own `sortable:`.
   *
   * Defaults to `["columns", "numeric"]`, which is the naming the reference host uses
   * and which caught a `columns: [dayz]` rendering a column of en dashes on three
   * production pages. It is a **default, not a rule**: a catalog whose column prop is
   * `cols` or `fields` names it here and gets the same check, and a catalog whose
   * `columns` prop carries display *labels* rather than row keys sets `columnProps: []`
   * — or omits `"columns"` from the list — and gets none. Without this the check had no
   * opt-out and a correct spec on such a catalog was a `NOVA3001` with nothing to do
   * about it.
   *
   * `sortable:` is not affected: it is nova's own word, its values are row keys by
   * definition, and it is checked whatever this says.
   */
  columnProps?: string[];
  /**
   * Prefix for the loader and action URLs the generated client fetches — the path the
   * host mounts this app's handler map at, e.g. "/api/apps/orders". Defaults to "", which
   * keeps the origin-relative "/_data/x" and "/_actions/x" a site-root host expects.
   * Handler map keys are relative to the mount and are unaffected by it.
   */
  basePath?: string;
};

/** The `importExtension` values the emitter knows how to write. */
const IMPORT_EXTENSIONS = ["", ".js"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * Checks the host's `NovaConfig` before any of it is used.
 *
 * `NovaConfig` is a TypeScript type, and a type checks nothing for a host that builds
 * its config in JavaScript, reads it from JSON or YAML, or assembles it from the
 * environment. Every field here is read by a different stage, so an omitted one used to
 * surface as whatever that stage happened to do with `undefined`: a missing `states`
 * was a `TypeError` inside the emitter, a missing `outDir` a `TypeError` from
 * `node:path`, and a missing `tsconfigPath` an `Error: Debug Failure.` thrown from
 * inside `typescript.js` — an internal compiler assertion naming neither nova, nor the
 * config, nor the field. That is the first thing a new host gets wrong and it was the
 * least actionable message nova could produce.
 *
 * Reported as `NOVA2014`: the block is where facts about the host's own configuration
 * already live (`NOVA2000` for a `components:` entry that does not resolve, `NOVA2011`
 * for a `tsconfigPath` that does not parse), and this is the same kind of fact,
 * answered one stage earlier.
 *
 * Every problem is reported, not just the first, so a host fixing a config by hand sees
 * the whole list in one run.
 */
export function validateConfig(config: unknown, at: Position): Diagnostic[] {
  const bad = (message: string, hint?: string) =>
    diagnostic("NOVA2014", message, at, hint === undefined ? {} : { hint });

  if (!isRecord(config)) {
    return [
      bad(
        `nova.config is ${config === null ? "null" : typeof config}, not an object`,
        "pass a NovaConfig: { components, states, outDir, tsconfigPath }",
      ),
    ];
  }

  const out: Diagnostic[] = [];

  if (!Array.isArray(config["components"])) {
    out.push(
      bad(
        "nova.config is missing 'components'",
        "an array of module specifiers whose components specs may name, e.g. ['@acme/ui']",
      ),
    );
  } else if (!config["components"].every(isNonEmptyString)) {
    out.push(bad("nova.config 'components' must be an array of module specifiers"));
  }

  const states = config["states"];
  if (!isRecord(states)) {
    out.push(
      bad(
        "nova.config is missing 'states'",
        "{ loading, error } naming catalog components, and optionally 'empty'",
      ),
    );
  } else {
    for (const key of ["loading", "error"] as const) {
      if (!isNonEmptyString(states[key])) {
        out.push(bad(`nova.config is missing 'states.${key}'`, "name a component in a catalog"));
      }
    }
    if (states["empty"] !== undefined && !isNonEmptyString(states["empty"])) {
      out.push(bad("nova.config 'states.empty' must be a component name"));
    }
  }

  if (!isNonEmptyString(config["outDir"])) {
    out.push(
      bad(
        "nova.config is missing 'outDir'",
        "a directory for emitted files, relative to the app folder — e.g. 'generated'",
      ),
    );
  }

  if (!isNonEmptyString(config["tsconfigPath"])) {
    out.push(
      bad(
        "nova.config is missing 'tsconfigPath'",
        "a path to the tsconfig used to resolve modules and typecheck emitted output",
      ),
    );
  }

  const columnProps = config["columnProps"];
  if (
    columnProps !== undefined &&
    (!Array.isArray(columnProps) || !columnProps.every(isNonEmptyString))
  ) {
    out.push(bad("nova.config 'columnProps' must be an array of prop names"));
  }

  for (const key of ["shell", "basePath"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") {
      out.push(bad(`nova.config '${key}' must be a string`));
    }
  }

  const extension = config["importExtension"];
  // Documented as `"" | ".js"` and "nothing else is accepted", which was true of the
  // type and not of the runtime: `".mjs"` went straight into every emitted specifier and
  // came back as nine NOVA3001/NOVA3002s about modules that do not exist. One config
  // error is the honest answer.
  if (extension !== undefined && !IMPORT_EXTENSIONS.includes(extension as "" | ".js")) {
    out.push(
      bad(
        `nova.config 'importExtension' is ${JSON.stringify(extension)}`,
        'the emitter writes "" (bundler resolution) or ".js" (node16/nodenext)',
      ),
    );
  }

  return out;
}
