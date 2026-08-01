/**
 * LSP client module — manages one LSP server lifecycle per audit group.
 *
 * Houses all LSP protocol interaction: spawn, connection setup, didOpen,
 * publishDiagnostics collection, shutdown. This is the only module with
 * Node I/O + external dependency (vscode-jsonrpc).
 *
 * Injection seam: setLspRuntime/resetLspRuntime for tests.
 * Tests inject a mock LspRuntime to replace Node I/O and vscode-jsonrpc,
 * eliminating the need for --experimental-test-module-mocks and mock.module().
 *
 * Fixes:
 * - C4 P1: jsonRpcModule cached inside loadJsonRpc() function scope (not module-level)
 * - P4 P2: catch (err) has instanceof Error check
 *
 * Split into:
 * - lsp-client/audit-group.ts — auditFileGroup orchestrator + lifecycle steps
 * - lsp-client/audit-one.ts   — single-file didOpen + diagnostics collector
 * - lsp-client/runtime.ts     — createDefaultRuntime + withTimeout + seam
 *
 * This file is a re-export shim so the public specifier ./lsp-client.ts
 * (imported by run-pre-audit.ts, index.ts, and the test suites) keeps
 * resolving unchanged.
 */

export { auditFileGroup } from "./lsp-client/audit-group.ts";
export { setLspRuntime, resetLspRuntime } from "./lsp-client/runtime.ts";
