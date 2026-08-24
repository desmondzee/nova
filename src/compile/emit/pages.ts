import type { PageSpec, PropValue, SectionSpec } from "../../schema/types.js";
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter, type SpecPath } from "./emitter.js";
import { HEADER, appRel, cap, rel, type EmittedFile } from "./types.js";

const PAGES_TYPE =
  "Record<string, React.ComponentType<{ params: Record<string, string> }>>";

function expr(value: PropValue): string {
  if (value.kind === "literal") return JSON.stringify(value.value);
  const ref = value.ref;
  switch (ref.kind) {
    case "data":
      return [`${ref.name}.value`, ...ref.path].join(".");
    case "actions":
      return `${ref.name}Action.run`;
    case "compute":
      return `compute.${ref.name}`;
    case "param":
      return `params.${ref.name}`;
    case "filter":
      return `filters.${ref.name}`;
  }
}

export function emitPages(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  const byModule = new Map<string, string[]>();
  for (const c of app.components) {
    byModule.set(c.module, [...(byModule.get(c.module) ?? []), c.name]);
  }

  e.line(HEADER);
  e.line('"use client";');
  e.line();
  e.line('import * as React from "react";');
  for (const module of [...byModule.keys()].sort()) {
    const names = [...new Set(byModule.get(module)!)].sort();
    e.line(`import { ${names.join(", ")} } from "${module}";`);
  }
  if (app.computes.length > 0) e.line(`import * as compute from "${appRel(config, "compute")}";`);
  // Each hook is imported only when some page actually needs it. A host with
  // `noUnusedLocals` fails the build on an unconditional import that a given spec
  // never calls — a spec with no filters (useFilters), no bound action (useAction), or
  // no data binding at all (useLoader) is entirely ordinary, not a spec bug. A page can
  // *declare* filters without anything reading them yet (see pageNeedsFilters below), so
  // "has filters" alone is not sufficient here either.
  const usesFilters = app.spec.pages.some(pageNeedsFilters);
  const usesActions = app.actions.length > 0;
  const usesLoaders = app.loaders.length > 0;
  const hooks = [
    ...(usesActions ? ["useAction"] : []),
    ...(usesFilters ? ["useFilters"] : []),
    ...(usesLoaders ? ["useLoader"] : []),
  ];
  if (hooks.length > 0) e.line(`import { ${hooks.join(", ")} } from "${rel(config, "./runtime")}";`);
  for (const name of app.loaders) {
    e.line(`import type { ${cap(name)} } from "${rel(config, "./types")}";`);
  }
  e.line();

  app.spec.pages.forEach((page, index) => {
    const path: SpecPath = ["pages", page.route];
    const used = usedLoaders(page.sections);
    const usedActions = usedActionNames(page.sections);

    e.line(`function Page_${index}({ params }: { params: Record<string, string> }) {`, path);
    e.indent();
    e.line("void params;");
    if (pageNeedsFilters(page)) {
      const defaults = page.filters
        .map((f) => `${JSON.stringify(f.name)}: ${JSON.stringify(String(f.default ?? ""))}`)
        .join(", ");
      e.line(`const filters = useFilters({ ${defaults} });`);
    }
    const query =
      page.filters.length > 0
        ? `{ ${page.filters.map((f) => `${JSON.stringify(f.name)}: filters[${JSON.stringify(f.name)}]`).join(", ")} }`
        : "{}";
    for (const name of used) {
      e.line(
        `const ${name} = useLoader<${cap(name)}>("/_data/${name}", ${query});`,
      );
    }
    for (const name of usedActions) {
      e.line(`const ${name}Action = useAction("/_actions/${name}");`);
    }
    if (used.length > 0) {
      const anyError = used.map((n) => `${n}.error`).join(" ?? ");
      const anyValueNull = used.map((n) => `${n}.value === null`).join(" || ");
      e.line(`const error = ${anyError};`);
      e.line(`if (error) return <${config.states.error}>{error}</${config.states.error}>;`);
      e.line(`if (${anyValueNull}) return <${config.states.loading} />;`);
    }
    e.line("return (");
    e.indent().line("<>");
    e.indent();
    page.sections.forEach((section, i) => {
      emitSection(section, [...path, "sections", i]);
    });
    e.dedent().line("</>").dedent();
    e.line(");");
    e.dedent();
    e.line("}");
    e.line();
  });

  e.line(`export const pages: ${PAGES_TYPE} = {`);
  e.indent();
  app.spec.pages.forEach((page, index) => {
    e.line(`${JSON.stringify(page.route)}: Page_${index},`, ["pages", page.route]);
  });
  e.dedent();
  e.line("};");

  return { name: "pages.tsx", text: e.text(), map: e.map() };

  function emitSection(section: SectionSpec, path: SpecPath): void {
    const name = section.component.name;
    const props = Object.keys(section.props)
      .sort()
      .map((p) => `${p}={${expr(section.props[p]!)}}`)
      .join(" ");
    const open = props === "" ? `<${name}` : `<${name} ${props}`;
    if (section.children.length === 0) {
      e.line(`${open} />`, path);
      return;
    }
    e.line(`${open}>`, path);
    e.indent();
    section.children.forEach((child, i) => emitSection(child, [...path, "children", i]));
    e.dedent();
    e.line(`</${name}>`, path);
  }
}

// A page's `filters` local is only worth declaring when something in that page's
// function body will actually read it: at least one loader (filters feed the loader's
// query object), or a component prop bound directly to `filters.xxx` (a filter value
// can be rendered or otherwise consumed with no loader involved at all — TabNav's
// `active` state driven straight from a filter, for example). "the page declares
// filters" alone is not enough — under `noUnusedLocals`, a page with filters that
// nothing reads (yet) must not declare the local.
function pageNeedsFilters(page: PageSpec): boolean {
  return page.filters.length > 0 && (usedLoaders(page.sections).length > 0 || collect(page.sections, "filter").length > 0);
}

function usedLoaders(sections: SectionSpec[]): string[] {
  return collect(sections, "data");
}

function usedActionNames(sections: SectionSpec[]): string[] {
  return collect(sections, "actions");
}

function collect(sections: SectionSpec[], kind: "data" | "actions" | "filter"): string[] {
  const found = new Set<string>();
  const walk = (list: SectionSpec[]) => {
    for (const s of list) {
      for (const value of Object.values(s.props)) {
        if (value.kind === "binding" && value.ref.kind === kind) found.add(value.ref.name);
      }
      walk(s.children);
    }
  };
  walk(sections);
  return [...found].sort();
}
