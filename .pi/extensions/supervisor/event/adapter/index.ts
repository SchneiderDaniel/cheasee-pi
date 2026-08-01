// ─── Event adapter barrel ──
// Public surface of the event/adapter split. Consumers import this
// directory (or the event/adapter.ts shim) — never the 3 modules directly.

export * from "./normalize.ts";
export * from "./handlers.ts";
export * from "./forward.ts";
