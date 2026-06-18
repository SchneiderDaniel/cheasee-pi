# Dead Code Detection Techniques — Code Patterns & Search Strategies

Detailed pattern catalog for each technique. Use as reference during Phase 3.

**Deterministic-first principle:** Every pattern below is designed for deterministic detection. Use `ripgrep_search` to find symbol references. Use `structural_search` to match AST patterns. Trace control flow manually. Never ask the LLM "is this code dead?" — that is speculation. Real dead code proof comes from tools and traced paths.

---

## 1. Unused Exports / Functions / Variables

### Search Strategy

```bash
# For each exported/defined symbol, search the entire extension dir
ripgrep_search "symbolName" .pi/extensions/<name>/

# If only result is the declaration line (and maybe export line), it's unused
# Example output for an unused function:
#   index.ts:42:export function helper(data: string) {
#   index.ts:43:  return data.trim()
# No other files match → confirmed unused
```

### Patterns

```typescript
// UNUSED EXPORT — no importer anywhere
export function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString();
}

// UNUSED PRIVATE FUNCTION — only defined, never called
function logDebug(msg: string) {
	if (config.debug) console.log(msg);
}
// logDebug never appears in any other function body

// UNUSED CONSTANT — assigned but never referenced
const API_VERSION = "v2";
// ... never used in any API call or comparison

// UNUSED DESTRUCTURE — field from object destructuring never read
function processUser({ id, name, email }: User) {
	// email never used in function body
	return { id, name };
}

// UNUSED VARIABLE — assigned but never read
function getStatus(code: number) {
	let message = "unknown"; // ← assigned but never read if all branches overwrite
	if (code === 200) message = "ok";
	else if (code === 404) message = "not found";
	else message = "error";
	return message; // ← first assignment dead, always overwritten
}
```

### False Positive Check

Before filing, verify:

- Symbol is not re-exported from a barrel file (`index.ts` that re-exports)
- Symbol is not referenced in config files, JSON, or templates
- Symbol is not used as a type in another file (for type exports)
- Symbol is not called via dynamic method name (e.g. `obj[symbolName]()`)

---

## 2. Unreachable Code

### Search Strategy

Read each function body top-to-bottom. Look for:

- `return` → statements after it inside same block
- `throw` → statements after it inside same block
- `break` / `continue` → statements after inside loop
- `process.exit()` → statements after
- Infinite loops → statements after

Use structural search for AST-level detection:

```bash
# Find code after return in same block
structural_search '{ $$$PREV; return $VAL; $$$AFTER }' --language ts
```

### Patterns

```typescript
// UNREACHABLE: return, then more code
function parse(input: string) {
	const trimmed = input.trim();
	return trimmed;
	const normalized = trimmed.toLowerCase(); // NEVER RUNS
}

// UNREACHABLE: throw, then more code
function assert(condition: boolean, msg: string) {
	if (!condition) throw new Error(msg);
	return true;
	console.log("assertion passed"); // NEVER RUNS
}

// UNREACHABLE: both branches return
function classify(n: number): string {
	if (n > 0) {
		return "positive";
	} else {
		return "non-positive";
	}
	console.log("classified"); // NEVER RUNS
}

// UNREACHABLE: conditional return then unconditional
function firstOrNull(items: string[]): string | null {
	if (items.length > 0) {
		return items[0];
	}
	return null;
	console.log("checked"); // NEVER RUNS — both paths return above
}

// UNREACHABLE: break then code in loop
function findFirst(items: number[], target: number): number | undefined {
	for (let i = 0; i < items.length; i++) {
		if (items[i] === target) {
			return i;
		}
		break;
		console.log("iterated"); // NEVER RUNS — break always fires
	}
}

// UNREACHABLE: catch returns, finally still runs (but code after try/catch doesn't)
async function fetchData(url: string) {
	try {
		return await fetch(url);
	} catch (err) {
		throw new Error(`fetch failed: ${err}`);
	} finally {
		console.log("cleanup"); // THIS runs — finally always runs
	}
	console.log("done"); // NEVER RUNS — both try and catch exit
}
```

### False Positive Check

- `return` inside a conditional — check both branches. If one branch does not return, code after is reachable via that branch.
- Hoisted functions — function declarations are hoisted, so calling before definition is valid.
- `/* fall through */` comment on empty case in switch — intentional, skip.
- Code after `try/catch` where `catch` does NOT re-throw — the code after is reachable when `catch` handles without throwing.

---

## 3. Dead Branches — Conditionals That Never Vary

### Search Strategy

Inspect each `if`, `switch`, ternary for conditions that are runtime-constant.

```bash
# Find all if-statements for manual inspection
structural_search 'if ($COND) { $$$THEN } else { $$$ELSE }' --language ts
```

### Patterns

```typescript
// DEAD: literal condition
const IS_PROD = true;
if (IS_PROD) {
	useProdConfig();
} else {
	// NEVER RUNS: IS_PROD is always true
	useDevConfig();
}

// DEAD: always-true comparison
function process(items: string[]) {
	// items.length is always >= 0 — never negative
	if (items.length >= 0) {
		// always enters
	}
}

// DEAD: redundant null check on non-nullable type
function greet(name: string) {
	if (name == null) {
		// name is string, cannot be null/undefined
		return "Hello, guest";
	}
	return `Hello, ${name}`;
}

// DEAD: always-false after type guard
function handle(input: string | number) {
	if (typeof input === "string") {
		// string branch
	}
	if (typeof input === "number") {
		// number branch — but if above was if-return, this is fine
	}
	if (typeof input === "boolean") {
		// NEVER RUNS: input is string | number, never boolean
	}
}

// DEAD: impossible enum/union value
type Direction = "north" | "south";
function move(dir: Direction) {
	if (dir === "north") return 1;
	if (dir === "south") return -1;
	if (dir === "east") return 0; // NEVER RUNS — not in union type
}

// DEAD: negated condition on non-nullable
function render(theme: string) {
	// theme is string, never null
	if (theme !== null && theme !== undefined) {
		// Always true — condition is redundant
	}
}
```

### False Positive Check

- Conditions on module-level constants that could change via build-time flags — if code has a build system, `IS_PROD` may vary across builds. Still dead in current build.
- `process.env.NODE_ENV` checks — these are intentional, used for tree-shaking by bundlers. Skip.
- Conditions on `typeof` where the type union legitimately includes the checked type — verify the actual union definition.
- Redundant null checks on public API parameters — even if TypeScript says non-nullable, the JS runtime could receive null from untyped callers. Some teams intentionally guard.

---

## 4. Unnecessary Conditionals

### Search Strategy

Look for conditionals where both branches produce identical result or where result is a tautology.

### Patterns

```typescript
// REDUNDANT: identical branches
if (isEnabled) {
	runChecks();
} else {
	runChecks(); // same function call — if/else pointless
}

// REDUNDANT: if-return-else-return = return condition
function isPositive(n: number): boolean {
	if (n > 0) {
		return true;
	} else {
		return false;
	}
	// SIMPLIFY: return n > 0
}

// REDUNDANT: ternary producing boolean
const hasItems = items.length > 0 ? true : false;
// SIMPLIFY: const hasItems = items.length > 0

// REDUNDANT: !! on boolean-typed parameter
function setActive(flag: boolean) {
	this.active = !!flag; // flag is already boolean
}

// REDUNDANT: empty if body with same code after condition
if (condition) {
	// empty
}
doSomething(); // runs regardless — no branch difference

// REDUNDANT: double negation
const exists = !!items.find((i) => i.id === id);
// items.find returns T | undefined — !! coerces to boolean correctly
// But if items is typed, Boolean() or direct comparison may be clearer
// This is borderline — only flag if there's a simpler alternative
```

### False Positive Check

- Some redundant patterns are stylistic choices (e.g. `!!` for explicit boolean coercion). Only flag if the pattern is **truly unnecessary**, not just stylistic preference.
- `if (condition) { /* empty */ } else { doSomething(); }` — the empty if body may be intentional for side effect in condition evaluation. Check.

---

## 5. Duplicate Code

### Search Strategy

Look for repeated blocks that differ only by variable names or literal values.

```bash
# Find repeated string literals or patterns
ripgrep_search "similar substring" --max-count 5
```

Manual inspection: same logic structure appearing in multiple functions or multiple places in same function.

### Patterns

```typescript
// DUPLICATE: same validation in multiple tools
function validateEmail(email: string) {
	/* ... */
}
function validateUserEmail(email: string) {
	/* same logic */
}
// Should be one shared validator

// DUPLICATE: copy-pasted error handling
try {
	const a = await loadA();
	return a;
} catch (err) {
	ctx.ui.notify(`Failed: ${err}`, "error");
	return null;
}

try {
	const b = await loadB();
	return b;
} catch (err) {
	ctx.ui.notify(`Failed: ${err}`, "error"); // identical handler
	return null;
}
// Should extract helper: async function withCatch<T>(fn: () => T, ctx)

// DUPLICATE: repeated condition chain (same condition checked twice)
if (user.role === "admin") {
	grantFullAccess();
}
if (user.role === "admin") {
	auditLog(user.name); // second check of same condition
}

// DUPLICATE: switch cases with identical bodies
switch (color) {
	case "red":
	case "green":
		handlePrimary(color);
		break;
	case "blue":
		handlePrimary(color); // same handler as red/green
		break;
}
// red, green, blue all do same thing — collapse cases
```

### False Positive Check

- Legitimate WET (Write Everything Twice) — sometimes duplication is intentional to avoid coupling shared logic prematurely.
- Test code duplication is lower priority but still valid if egregious.
- Configuration mapping overrides where same key appears in different files is not duplicate code.

---

## 6. Unused Parameters

### Search Strategy

For each function, check every parameter is referenced in body. Read function body — if parameter appears 0 times outside signature, it is unused.

### Patterns

```typescript
// UNUSED: tool execute parameter not used
execute(toolCallId, params, signal, onUpdate, ctx) {
  // signal, onUpdate never referenced
  return someFunction(params.name);
}

// UNUSED: event handler context not used
pi.on("session_start", async (event, ctx) => {
  // ctx never used — only event is used
  console.log("Session started:", event.sessionId);
});

// UNUSED: callback parameter
function transform(items: string[], callback: (item: string, index: number) => string) {
  return items.map(item => {
    return callback(item, 0); // index parameter always 0 — receiver might use it?
    // Actually, this is misuse — map's index is ignored in favor of hardcoded 0
  });
}

// UNUSED: class constructor parameter
class ConfigProvider {
  constructor(private basePath: string) {
    // basePath auto-assigned to this.basePath via TS shorthand
    // Actually this IS used — TS automatically creates a property
    // Only flag if the auto-created property is never read
  }
}
```

### False Positive Check

- Constructor shorthand (`private param`) creates property auto-matically — the parameter is "used" as a class property. Check if the property is read elsewhere.
- Overridden method in subclass — parent interface may require parameter even if subclass doesn't use it (`_unused` prefix convention).
- `_` prefix convention for intentionally unused params (e.g. `_event`, `_ctx`). Skip these.

---

## 7. Orphaned Imports

### Search Strategy

For each import statement, search the file for usage of each imported symbol.

```bash
# Check if symbol is used in file (beyond import line)
ripgrep_search "symbolName" .pi/extensions/<name>/index.ts
# If only import line matches → orphaned
```

### Patterns

```typescript
// ORPHANED: named import never referenced
import { readFile, writeFile, unlink } from "fs/promises";
// Only writeFile and unlink used — readFile is orphaned

// ORPHANED: default import never used
import path from "path";
// resolve, join, basename used via path.resolve, but maybe using
// `path` namespace — check if any `path.xxx()` call exists

// ORPHANED: type import with no type reference
import type { ExtensionConfig, ToolDefinition } from "./types";
// Only ExtensionConfig used in a type annotation — ToolDefinition is orphaned

// ORPHANED: namespace import with no usage
import * as utils from "./utils";
// No utils.xxx called anywhere in file

// ORPHANED: re-export of unused import
export { unusedFunction } from "./helpers";
// Re-exported but the re-exporting module never uses it
// AND nothing imports it from this module either
```

### False Positive Check

- Side-effect imports (`import "module-alias"`, `import "./polyfill"`) — these are intentional, they execute module side effects. Skip.
- Type imports used in `typeof` — `typeof import("./types").SomeType` — harder to detect with text search. Read carefully.
- Import used as type in a JSDoc comment — rare but possible.
- Re-exported import — if a module imports then re-exports, the import is used as the re-export source. Check `export { ... }`.

---

## 8. Empty Blocks

### Search Strategy

Look for `{}`, `catch {}`, empty `if`/`else` blocks, empty function bodies, empty `switch` cases.

```bash
# Find empty catch blocks with structural search
structural_search 'catch { $$$ }' --language ts
```

### Patterns

```typescript
// EMPTY CATCH — error silently swallowed
try {
	await parseConfig(path);
} catch {
	// Error is completely ignored
}

// EMPTY IF BLOCK — condition checked but nothing happens
if (shouldLog) {
	// TODO: implement logging
}

// EMPTY ELSE BLOCK — no action on negative case
if (condition) {
	doSomething();
} else {
	// intentional nothing
}
// If intentional, add comment explaining why. Otherwise dead.

// EMPTY FUNCTION — placeholder
function migrateOldConfig() {
	// Placeholder for future migration
}

// EMPTY SWITCH CASE — fallthrough with no comment
switch (status) {
	case 200:
	// no break, falls through to 201 — intentional?
	case 201:
		return handleSuccess();
}
// Missing comment makes it ambiguous. If fallthrough intentional, add comment.
```

### False Positive Check

- `catch { /* ignore */ }` with explicit comment — skip if comment explains why.
- Empty constructor in class inheriting from another — sometimes required by TS.
- Abstract methods / interface stubs — they're intentionally empty.
- Empty blocks in test files for setup/teardown placeholders.

---

## 9. Dead Event Handlers / Tool Registrations

### Search Strategy

Check all `pi.on()`, `pi.registerTool()`, `ctx.events.on()` calls. Verify:

- The event name is valid (exists in pi API)
- The handler actually does something (not empty)
- Multiple handlers for same event don't conflict
- Tool name matches what prompts actually call

### Patterns

```typescript
// DEAD: handler for event that doesn't exist in pi API
pi.on("never_emitted", async (event, ctx) => {
	console.log("This never fires");
});

// DEAD: tool registered but no prompt uses it
pi.registerTool({
	name: "legacy_search",
	description: "Old search API — replaced by semantic_search",
	parameters: Type.Object({ query: Type.String() }),
	execute: async (tcId, params, signal, onUpdate, ctx) => {
		// This tool is never called by any prompt
		return { content: [{ type: "text", text: "result" }] };
	},
});

// DEAD: duplicate handler — first one overridden or both run but one ineffective
pi.on("message", handlerA);
pi.on("message", handlerB); // If both run, A might be dead if B always replaces

// DEAD: cleanup handler never called
commitCleanup = () => {
	ctx.events.off("message", handler);
};
// commitCleanup saved but never called — handler leaks
```

### False Positive Check

- Event names that match pi internal events — check pi docs for valid events.
- Tool registration without immediate prompt reference — the tool may be used by external integrations or LLM auto-discovery. If the tool is registered but never used in any prompt template, it's likely dead, but check if the extension README documents it for external use.
- Duplicate handlers may be intentional for independent side effects (e.g. one logs, one transforms).

---

## 10. Redundant / Dead Code Paths

### Search Strategy

Read each function body for assignments never read, returns discarded, dead computation.

### Patterns

```typescript
// DEAD: local variable assigned but never read
function process(items: string[]) {
	const count = items.length; // assigned but never read
	return items.map((i) => i.trim());
}

// DEAD: overwritten before first read
function getConfig(path: string) {
	let config = defaultConfig; // ← dead assignment
	config = loadConfig(path); // ← real assignment
	return config;
}

// DEAD: unused return value
function init() {
	const result = setupLogger(); // return value never checked
}

// DEAD: dead computation
function format(text: string) {
	const upper = text.toUpperCase(); // computed but never used
	const lower = text.toLowerCase();
	return lower;
}

// DEAD: useless comparison
function isReady(status: string) {
	if (status === "ready" || status === "READY") {
		// OR with same result — status could be both, but both do same thing
	}
}

// DEAD: noop statement
function run() {
	doWork();
	true; // expression statement with no effect
	return;
}

// DEAD: dead mutation on local copy
function processUser(user: User) {
	const copy = { ...user };
	copy.name = copy.name.trim(); // mutation on local copy, never persisted
	// If copy is only returned, mutation is fine. But if copy is discarded...
}

// DEAD: conditional that always matches first branch
function handle(value: string) {
	if (value.length > 0) return value;
	if (value.length === 0) return "empty"; // covered by first branch's else
	// Actually, if value.length > 0 returned, this second if only runs
	// when value.length === 0, so condition is always true — redundant condition
}
```

### False Positive Check

- Accumulator patterns (e.g. `let total = 0; items.forEach(i => total += i)`) — the variable IS read via closure, not direct reference. Skip these.
- `void` expressions intentionally discard promise results — skip if commented.
- Return value intentionally ignored for fire-and-forget behavior.
- Property setters that mutate `this` — the assignment has side effects beyond the variable itself.

---

## 11. Zombie Dependencies

### Search Strategy

Compare packages listed in `package.json` against actual import statements across all extension files. A package declared but never imported anywhere is a zombie dependency.

```bash
# Step 1: Extract dependency names from package.json (non-dev)
grep -E '"@?[a-zA-Z]' .pi/extensions/<name>/package.json |\
  grep -v 'devDependencies' |\
  grep -o '"[a-z@][^"]*"' |\
  tr -d '"'

# Step 2: Check each package for any import across all files
ripgrep_search "from 'package-name'" .pi/extensions/<name>/
ripgrep_search "require('package-name')" .pi/extensions/<name>/

# Also check dynamic imports
ripgrep_search "import('package-name')" .pi/extensions/<name>/
```

### Patterns

```typescript
// ZOMBIE: declared but never imported
// package.json has: "lodash": "^4.17.21"
// But no: import _ from 'lodash' or require('lodash') anywhere

// ZOMBIE: devDependency with no usage in any script
// "mocha": "^10.0.0" in devDependencies but no scripts use mocha
// AND no test files import mocha

// ZOMBIE: tool that should be npx/global
// "typescript": "^5.0.0" in dependencies when only used as CLI
// Could be installed globally or run via npx

// ZOMBIE: duplicate transitive dependency
// Both "react" and "react-dom" declared, but react-dom includes react

// ALIVE: @types/* packages — type packages, skip
// ALIVE: Packages used in npm scripts (build, test, lint)
// ALIVE: Packages used in config files (eslint, prettier, webpack)
// ALIVE: Peer dependencies that the consumer must provide
```

### Special Cases

| Package type      | Example                  | Verdict                              |
| ----------------- | ------------------------ | ------------------------------------ |
| Type package      | `@types/node`            | Skip — type information only         |
| Build tool        | `webpack`, `vite`, `tsc` | Skip only if used in scripts         |
| CLI tool          | `rimraf`, `cross-env`    | Skip if used in package.json scripts |
| Config peer       | `eslint-config-*`        | Skip if referenced in .eslintrc      |
| Runtime dep       | `express`, `axios`       | Zombie if not imported — do NOT skip |
| Monorepo internal | `@myorg/shared`          | Check if actually imported           |

### False Positive Check

- Packages used only in `package.json` scripts section (e.g. `rimraf`, `concurrently`). These are build tools, not import deps. Skip.
- `@types/*` packages — they provide types only, no runtime import. Skip.
- Monorepo workspace packages — may be imported via workspace protocol. Check actual import.
- Packages imported dynamically via `import()` — harder to detect. Check `ripgrep_search` for the package name in template literals.
- Packages used only in config files (`.eslintrc.js`, `jest.config.ts`, `webpack.config.js`). These are valid config dependencies. Skip if only used there.
- Packages pulled in by framework (e.g. pi framework auto-installs certain packages). Check pi docs.

---

## General Search Cookbook

### Find All Function Definitions

```bash
structural_search 'function $NAME($$$PARAMS) { $$$BODY }' --language ts
```

### Find All Arrow Functions

```bash
structural_search 'const $NAME = ($$$PARAMS) => { $$$BODY }' --language ts
```

### Find All Export Statements

```bash
structural_search 'export $$$CONTENT' --language ts
```

### Find All Try/Catch Blocks

```bash
structural_search 'try { $$$TRY } catch ($$$ERR) { $$$CATCH }' --language ts
```

### Find All If/Else Structures

```bash
structural_search 'if ($COND) { $$$THEN } else { $$$ELSE }' --language ts
```

### Find All Switch/Case

```bash
structural_search 'switch ($VAL) { $$$BODY }' --language ts
```

### Find Code After Return (Potential Unreachable)

```bash
structural_search '{ $$$PREV; return $VAL; $$$AFTER }' --language ts
```

### Find Empty Block

```bash
structural_search '{ }' --language ts
```

### Find Catch Without Body

```bash
structural_search 'catch { }' --language ts
```

### Find All pi.on Registrations

```bash
structural_search 'pi.on($EVENT, $HANDLER)' --language ts
```

### Find All pi.registerTool Calls

```bash
structural_search 'pi.registerTool($TOOL)' --language ts
```
