// ─── Event adapter barrel ───
// Public surface of the event/adapter split. Consumers import this
// directory (or the event/adapter.ts shim) — never the 3 modules directly.
// Star re-exports on purpose: named re-exports trip TS1205 under
// isolatedModules (pinned by adapter-split.test.mts). The handler families are
// re-exported explicitly from handlers.ts, which is where the surface is
// audited (issue #2033).

export * from "./normalize.ts";
export * from "./handlers.ts";
export * from "./forward.ts";
