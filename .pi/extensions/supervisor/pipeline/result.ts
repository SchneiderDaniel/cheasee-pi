// ─── Result<T> Type (Supervisor re-export) ───────────────────────
// The implementation moved to `.pi/extensions/shared/result.ts` (issue #2138)
// so the goal-loop extension and the Supervisor share one definition. This
// module keeps the historical import path (`./result.ts`) working for every
// Supervisor call site.

export { execChecked, failure, nullNotify, toNotifyFn, withNotify } from "../../shared/result.ts";
export type { NotifyFn, NotifyTarget, Result } from "../../shared/result.ts";
