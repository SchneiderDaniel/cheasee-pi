# CodeFlow Analysis Report

**Repository:** SchneiderDaniel/cheasee-pi
**Analyzed:** 1/2/2026, 3:04:05 PM

## Summary

| Metric | Value |
|--------|-------|
| Health Score | 82/100 (B) |
| Files | 42 |
| Functions | 310 |
| Lines of Code | 12,345 |
| Dependencies | 180 |
| Unused Functions | 3 |
| Security Issues | 1 |

## Security Issues

### HIGH: Hardcoded secret
- **File:** `src/config.ts` (line 12)
- **Description:** Possible hardcoded API key.
- **Code:** `const KEY = "sk-live-abc"`

## Unused Functions (3)

These functions have zero calls (internal or external) and may be dead code:

### `legacyParse()`
- **File:** `src/parser/legacy.ts`
- **Line:** 44
- **Lines of code:** 18

### `oldHelper()`
- **File:** `src/util/helpers.ts`
- **Line:** 3
- **Lines of code:** 5

### `deadBranch()`
- **File:** `src/parser/legacy.ts`
- **Line:** 90
- **Lines of code:** 7

## Design Patterns

### Singleton
A single shared instance.

**Files:** `src/registry.ts`

## Architecture Issues

### High coupling in parser layer
Parser files depend on UI modules.

**Affected:** `src/parser/ast.ts`, `src/ui/render.ts`

### Circular dependency
A cycle between two modules.

**Affected:** `src/a.ts`, `src/b.ts`

## File Details

| File | Folder | Layer | Lines | Functions |
|------|--------|-------|-------|----------|
| `ast.ts` | src/parser | Parser | 220 | 12 |
| `render.ts` | src/ui | UI | 88 | 4 |
