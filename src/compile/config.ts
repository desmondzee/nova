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
   * Prefix for the loader and action URLs the generated client fetches — the path the
   * host mounts this app's handler map at, e.g. "/api/apps/trips". Defaults to "", which
   * keeps the origin-relative "/_data/x" and "/_actions/x" a site-root host expects.
   * Handler map keys are relative to the mount and are unaffected by it.
   */
  basePath?: string;
};
