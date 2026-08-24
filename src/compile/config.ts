export type NovaConfig = {
  /** Module specifiers whose capitalised callable exports are usable in specs. */
  components: string[];
  /** Catalog component names used for the generated loading, error and empty states. */
  states: { loading: string; error: string; empty: string };
  /** Directory name, relative to the app folder, for emitted files. */
  outDir: string;
  /** tsconfig used to resolve modules and typecheck emitted output. */
  tsconfigPath: string;
  /** Extension appended to relative imports in emitted code. "" for bundler resolution. */
  importExtension?: "" | ".js";
};
