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
  '      month: { default: "2026-08" }',
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
    expect(page.filters).toEqual([{ name: "month", default: "2026-08" }]);
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

  it("reports an invalid route for a leading double slash", () => {
    const { diagnostics } = check('pages:\n  "//a":\n    sections: []\n');
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1005");
  });

  it("reports an invalid route for a leading double slash with a param", () => {
    const { diagnostics } = check('pages:\n  "//:id":\n    sections: []\n');
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1005");
  });

  it("accepts a filter with no keys at all", () => {
    // `type` used to be required and was then read by nothing, so every spec carried a
    // key that changed no output. A filter is now just a name plus an optional default.
    const { spec, diagnostics } = check(
      'pages:\n  "/":\n    filters:\n      month: {}\n    sections: []\n',
    );
    expect(diagnostics).toEqual([]);
    expect(spec!.pages[0]!.filters).toEqual([{ name: "month" }]);
  });

  it("reports a leftover 'type' key rather than silently ignoring it", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    filters:\n      month: { type: month }\n    sections: []\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
    expect(diagnostics[0]!.message).toContain("'type'");
  });

  it("rejects a filter named 'set', which would collide with useFilters' setter", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    filters:\n      set: {}\n    sections: []\n',
    );
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1001");
    expect(diagnostics.find((d) => d.code === "NOVA1001")!.message).toContain("reserved");
  });

  it("accepts 'confirm' on a section that binds exactly one action", () => {
    const { spec, diagnostics } = check(
      [
        "pages:",
        '  "/":',
        "    sections:",
        "      - DeleteButton:",
        "          label: Delete",
        "          onSubmit: actions#deleteTrip",
        "          confirm: Delete this trip?",
        "",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    const section = spec!.pages[0]!.sections[0]!;
    expect(section.confirm).toBe("Delete this trip?");
    // Consumed by nova, not forwarded: a component that does not declare a `confirm`
    // prop would otherwise fail with a NOVA3001 the author cannot act on.
    expect(section.props.confirm).toBeUndefined();
    expect(Object.keys(section.props).sort()).toEqual(["label", "onSubmit"]);
  });

  it("reports 'confirm' on a section that binds no action", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: b, confirm: Sure? }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1007"]);
    expect(diagnostics[0]!.message).toContain("no action");
  });

  it("reports 'confirm' on a section that binds two different actions", () => {
    const { diagnostics } = check(
      [
        "pages:",
        '  "/":',
        "    sections:",
        "      - Pair:",
        "          onSave: actions#save",
        "          onDrop: actions#drop",
        "          confirm: Sure?",
        "",
      ].join("\n"),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1007"]);
    expect(diagnostics[0]!.message).toContain("2 actions");
  });

  it("reports one action bound with two different confirmations on one page", () => {
    // useAction is hoisted once per action per page, so two sections asking for
    // different confirmation text on the same action cannot both be honoured. Silently
    // picking one would ship a delete button with the wrong prompt.
    const { diagnostics } = check(
      [
        "pages:",
        '  "/":',
        "    sections:",
        "      - A: { onSubmit: actions#drop, confirm: Really? }",
        "      - B: { onSubmit: actions#drop, confirm: Are you sure? }",
        "",
      ].join("\n"),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1010"]);
    expect(diagnostics[0]!.message).toContain("drop");
  });

  it("accepts the same action bound twice on one page with the same confirmation", () => {
    const { diagnostics } = check(
      [
        "pages:",
        '  "/":',
        "    sections:",
        "      - A: { onSubmit: actions#drop, confirm: Really? }",
        "      - B: { onSubmit: actions#drop, confirm: Really? }",
        "",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
  });

  const FORM = [
    "pages:",
    '  "/":',
    "    sections:",
    "      - Form:",
    "          submit: actions#saveTrip",
    "          fields:",
    "            - DateField: { name: date, label: Date }",
    "            - NumberField: { name: km, initial: 0 }",
    "",
  ].join("\n");

  it("normalises a form section into a submit action and a field list", () => {
    const { spec, diagnostics } = check(FORM);
    expect(diagnostics).toEqual([]);
    const section = spec!.pages[0]!.sections[0]!;
    expect(section.submit).toBe("saveTrip");
    // Neither `submit` nor `fields` is forwarded as a prop.
    expect(Object.keys(section.props)).toEqual([]);
    expect(section.fields).toHaveLength(2);
    expect(section.fields![0]).toEqual({
      component: { kind: "catalog", name: "DateField" },
      name: "date",
      // A field with no `initial` starts empty, which is right for the text-shaped
      // fields that make up most of a form; a NumberField says so explicitly, and gets
      // a type error at the form line if it does not.
      initial: "",
      props: { label: { kind: "literal", value: "Date" }, name: { kind: "literal", value: "date" } },
    });
    expect(section.fields![1]!.initial).toBe(0);
  });

  it("reports 'fields' on a section that does not submit an action", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    sections:\n      - Form:\n          fields:\n            - TextField: { name: a }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1002"]);
    expect(diagnostics[0]!.message).toContain("submit");
  });

  it("reports a 'submit' that is not an actions# binding", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    sections:\n      - Form: { submit: data#trips }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1003"]);
    expect(diagnostics[0]!.message).toContain("submit");
  });

  it("reports a field with no name", () => {
    const { diagnostics } = check(FORM.replace("{ name: date, label: Date }", "{ label: Date }"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1002"]);
    expect(diagnostics[0]!.message).toContain("name");
  });

  it("reports two fields editing the same key", () => {
    const { diagnostics } = check(FORM.replace("name: km", "name: date"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1008"]);
    expect(diagnostics[0]!.message).toContain("date");
  });

  it("reports a field prop nova supplies itself", () => {
    const { diagnostics } = check(FORM.replace("label: Date", "value: nope"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
    expect(diagnostics[0]!.message).toContain("'value'");
  });

  it("reports a form prop nova supplies itself", () => {
    const { diagnostics } = check(FORM.replace("submit: actions#saveTrip", "submit: actions#saveTrip\n          busy: true"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
    expect(diagnostics[0]!.message).toContain("'busy'");
  });

  it("reports two forms on one page submitting the same action", () => {
    // Each form hoists `const <action>Form = useForm(...)`, so two would redeclare it —
    // a nova bug surfacing as a TypeScript error against the author's spec.
    const { diagnostics } = check(
      [
        "pages:",
        '  "/":',
        "    sections:",
        "      - Form: { submit: actions#saveTrip }",
        "      - Form: { submit: actions#saveTrip }",
        "",
      ].join("\n"),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1010"]);
    expect(diagnostics[0]!.message).toContain("saveTrip");
  });

  const SORT = [
    "pages:",
    '  "/":',
    "    sections:",
    "      - Table:",
    "          rows: data#trips",
    "          columns: [date, km]",
    "          sortable: [date]",
    "",
  ].join("\n");

  it("records sortable columns and still forwards the list as a prop", () => {
    const { spec, diagnostics } = check(SORT);
    expect(diagnostics).toEqual([]);
    const section = spec!.pages[0]!.sections[0]!;
    expect(section.sortable).toEqual(["date"]);
    // Wiring *and* an ordinary prop, like a field's `name`: the table needs to know
    // which headers are clickable.
    expect(section.props.sortable).toEqual({ kind: "literal", value: ["date"] });
  });

  it("reports a sortable column the section's own columns list does not have", () => {
    const { diagnostics } = check(SORT.replace("sortable: [date]", "sortable: [date, distance]"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1009"]);
    expect(diagnostics[0]!.message).toContain("distance");
  });

  it("accepts sortable columns when the section names no columns to check against", () => {
    // `columns:` is an ordinary prop, not spec vocabulary — a host table may call it
    // something else, or supply it from a loader. The subset check applies where there
    // is a literal list to check against, and is silent where there is not.
    const { diagnostics } = check(
      SORT.replace("          columns: [date, km]\n", "").replace(
        "sortable: [date]",
        "sortable: [anything]",
      ),
    );
    expect(diagnostics).toEqual([]);
  });

  it("reports a sortable that is not a list of strings", () => {
    const { diagnostics } = check(SORT.replace("sortable: [date]", "sortable: date"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1003"]);
  });

  it("reports two sortable sections on one page", () => {
    // One sort state per page, kept under `?sort=&dir=`. Two tables would fight over it.
    const { diagnostics } = check(SORT + SORT.split("\n").slice(3).join("\n"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1011"]);
  });

  it("reports a sort prop nova supplies itself", () => {
    const { diagnostics } = check(SORT.replace("sortable: [date]", "sortable: [date]\n          onSort: x"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
    expect(diagnostics[0]!.message).toContain("'onSort'");
  });

  const REFRESH = [
    "pages:",
    '  "/":',
    "    sections:",
    "      - Form: { submit: actions#saveTrip, refreshes: [trips] }",
    "      - Table: { rows: data#trips, columns: [date] }",
    "",
  ].join("\n");

  it("records the loaders a section refreshes without forwarding them as a prop", () => {
    const { spec, diagnostics } = check(REFRESH);
    expect(diagnostics).toEqual([]);
    const section = spec!.pages[0]!.sections[0]!;
    expect(section.refreshes).toEqual(["trips"]);
    // Consumed by nova, like `confirm:`: a form shell declares no `refreshes` prop, so
    // forwarding it would be a NOVA3001 on every form that used one.
    expect(section.props.refreshes).toBeUndefined();
  });

  it("reports a refreshes naming a loader the page does not bind", () => {
    const { diagnostics } = check(REFRESH.replace("refreshes: [trips]", "refreshes: [tirps]"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1012"]);
    expect(diagnostics[0]!.message).toContain("tirps");
    expect(diagnostics[0]!.hint).toContain("trips");
  });

  it("reports a refreshes on a section that binds no action", () => {
    const { diagnostics } = check(
      REFRESH.replace("submit: actions#saveTrip, ", "").replace("- Form:", "- StatCard:"),
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1007"]);
    expect(diagnostics[0]!.message).toContain("no action");
  });

  it("reports a refreshes that is not a list of loader names", () => {
    const { diagnostics } = check(REFRESH.replace("refreshes: [trips]", "refreshes: trips"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1003"]);
  });

  it("collects every problem rather than stopping at the first", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    titel: a\n    sections: "nope"\n  bad:\n    sections: []\n',
    );
    expect(diagnostics.length).toBeGreaterThanOrEqual(3);
  });
});
