// Domain: brace counting over the structural view of a Go file.
//
// The structural view comes from `inventory-go-literals.ts`, where comments and
// literals are already blanked, so a `}` inside a string cannot truncate a slice.
// The matcher itself is shared with the Rust enumerator (`inventory-braces.ts`).

export { bodyEndLine } from "./inventory-braces.ts";
