// ─── Pipeline Handler (re-export shim) ───────────────────────────
// Issue #1395 split: the former 1139-line megahandler now lives in
// handler/{preflight,agent-loop,post-pipeline,shared}.ts, orchestrated
// by handler/index.ts. This shim is kept because pipeline/index.ts and
// several auxiliary tests import from this path — do not re-grow it.

export { handleSupervisorCommand, handlePostPipeline } from "./handler/index.ts";
