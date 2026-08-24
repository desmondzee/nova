// An ambient declaration: no module imports it, so it reaches a program only by being
// a root. Programs are built from roots plus what they import, and every `.d.ts` the
// tsconfig's `include` matches is added as a root precisely so files like this keep
// working. See the "roots and their imports, not the whole include set" test.
declare const NOVA_AMBIENT_GLOBAL: string;
