package main

import (
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// `on_message` liveness gates (issue #2089).
//
// CodeFlow reports `on_message` as dead code in `ui/src/ws.rs` and
// `ui/src/retry/tests_wiring.rs`. Both findings are false positives. The port
// is declared in `retry/wiring.rs`, installed by the sole production caller
// `wire`, implemented over the native socket in `ws.rs`, and implemented again
// by the host-test fake whose `fire_message` fires the real closure.
//
// Two things hide that from the analyzer: the production call site
// `socket.on_message(...)` dispatches through an `S: Socket` bound, which text
// analysis does not resolve, and `ws.rs` only compiles under `feature =
// "hydrate"`, so a host-only run never sees the adapter. No Rust toolchain runs
// here, so these gates pin the exact strings that make the two findings false.
// They fail closed: a missing symbol fails the test and names its file.
// ──────────────────────────────────────────────

// blockEnd returns the offset just past the `}` matching the `{` at open.
// Fails closed on an out-of-range offset or an unterminated block — a
// truncated span would let a contains-check pass over nothing.
func blockEnd(t *testing.T, src string, open int, file string) int {
	t.Helper()
	if open < 0 || open >= len(src) || src[open] != '{' {
		t.Fatalf("%s: no `{` opens the block at offset %d", file, open)
	}
	depth := 0
	for i := open; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			if depth--; depth == 0 {
				return i + 1
			}
		}
	}
	t.Fatalf("%s: the block opened at offset %d is unterminated", file, open)
	return 0
}

// implBlock returns the `impl <header> { ... }` span of src, brace-counted to
// the matching `}`. Scoped on purpose: a file-wide `strings.Contains` would
// prove nothing once the method moved out of this impl.
func implBlock(t *testing.T, src, header, file string) string {
	t.Helper()
	start := strings.Index(src, header)
	if start < 0 {
		t.Fatalf("%s: missing %q — cannot scope the impl block", file, header)
	}
	open := strings.Index(src[start:], "{")
	if open < 0 {
		t.Fatalf("%s: %q has no opening brace", file, header)
	}
	return src[start:blockEnd(t, src, start+open, file)]
}

// TestUI_OnMessageLiveness pins every site that keeps `on_message` live in the
// two files CodeFlow cited, plus the sole production caller in `wire`.
func TestUI_OnMessageLiveness(t *testing.T) {
	wiring := uiAsset(t, "src", "retry", "wiring.rs")
	for _, want := range []string{
		// The port declaration: the `Socket` trait method `wire` installs.
		"fn on_message<F: FnMut(String) + 'static>(&self, handler: F);",
		// The only production call site — the reference the analyzer misses
		// because it dispatches through a generic `S: Socket` bound.
		"socket.on_message(",
	} {
		if !strings.Contains(wiring, want) {
			t.Errorf("ui/src/retry/wiring.rs must contain %q — the Socket port and its production call site keep on_message live", want)
		}
	}

	testsWiring := uiAsset(t, "src", "retry", "tests_wiring.rs")
	for _, want := range []string{
		// The cited second file: the host fake implements the port…
		"impl Socket for FakeSocket",
		"fn on_message<F: FnMut(String) + 'static>(&self, handler: F) {",
		// …and fires the registered closure, so the impl is exercised, not inert.
		"fn fire_message(&self, text: &str) {",
	} {
		if !strings.Contains(testsWiring, want) {
			t.Errorf("ui/src/retry/tests_wiring.rs must contain %q — FakeSocket implements the Socket port and fires it in the lifecycle tests", want)
		}
	}

	ws := uiAsset(t, "src", "ws.rs")
	for _, want := range []string{
		// The wasm shell installs the shared wiring…
		"wire(",
		// …and its message closure routes frames to the slices instead of
		// dropping them, so the browser path cannot degrade to a no-op handler.
		"fan_out(&slices, &text)",
	} {
		if !strings.Contains(ws, want) {
			t.Errorf("ui/src/ws.rs must contain %q — the browser path installs `wire` and routes the message frames", want)
		}
	}
}

// TestUI_BrowserSocketImplDeclaresOnMessage proves the adapter implements the
// port inside its `Socket` impl, which is exactly what CodeFlow reports as dead.
func TestUI_BrowserSocketImplDeclaresOnMessage(t *testing.T) {
	const header = "impl Socket for BrowserSocket"
	const method = "fn on_message<F: FnMut(String) + 'static>"

	ws := uiAsset(t, "src", "ws.rs")
	span := implBlock(t, ws, header, "ui/src/ws.rs")
	if !strings.Contains(span, method) {
		t.Errorf("ui/src/ws.rs: `%s` must declare `%s` — the native adapter implements the Socket port CodeFlow reports as dead", header, method)
	}
	// Scope guard: the span must stop at this impl's closing brace. The next
	// item in the file is the `Transport` impl, so its presence means the span
	// swallowed the rest of the file and the check above proves nothing.
	if strings.Contains(span, "impl crate::retry::Transport for BrowserSocket") {
		t.Errorf("ui/src/ws.rs: the `%s` span ran past its closing brace — a file-wide match cannot prove the method is in this impl", header)
	}
}

// TestUI_ImplBlockHelperDetectsRemoval is the negative control: it excises the
// real `fn on_message` method from the real `ws.rs` text and asserts the same
// impl-block pair reports it absent. Without this, the gate above could be
// passing for the wrong reason.
func TestUI_ImplBlockHelperDetectsRemoval(t *testing.T) {
	const header = "impl Socket for BrowserSocket"
	const method = "fn on_message<F: FnMut(String) + 'static>"

	ws := uiAsset(t, "src", "ws.rs")
	span := implBlock(t, ws, header, "ui/src/ws.rs")
	spanStart := strings.Index(ws, span)
	at := strings.Index(span, method)
	if at < 0 {
		t.Fatalf("ui/src/ws.rs: `%s` has no `%s` to excise — the negative control cannot run", header, method)
	}
	open := strings.Index(span[at:], "{")
	if open < 0 {
		t.Fatalf("ui/src/ws.rs: `%s` in `%s` has no body to excise", method, header)
	}
	end := spanStart + at + open
	end = blockEnd(t, ws, end, "ui/src/ws.rs")
	excised := ws[:spanStart+at] + ws[end:]

	if !strings.Contains(excised, header) {
		t.Fatalf("ui/src/ws.rs: excision removed the `%s` header — the negative control would test nothing", header)
	}
	if got := implBlock(t, excised, header, "ui/src/ws.rs (excised)"); strings.Contains(got, method) {
		t.Error("the impl-block gate fails its negative control: it still reports `fn on_message` present after the method was excised, so it does not detect removal")
	}
}
