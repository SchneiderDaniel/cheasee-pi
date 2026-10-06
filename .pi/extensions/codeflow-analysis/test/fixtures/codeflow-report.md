# CodeFlow Analysis Report

**Repository:** SchneiderDaniel/cheasee-pi
**Analyzed:** 10/6/2026, 9:38:18 PM

## Summary

| Metric | Value |
|--------|-------|
| Health Score | 70/100 (C) |
| Files | 9 |
| Functions | 14 |
| Lines of Code | 1,234 |
| Dependencies | 9 |
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
```
function legacyParse(){}
```

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

## Anti-Patterns

### God Object
Files with too many responsibilities.

**Affected files:** `src/god.ts`

## Architecture Issues

### High coupling in parser layer
Parser files depend on UI modules.

**Affected:** `src/parser/ast.ts`, `src/ui/render.ts`

### 1 Architecture Violations
Lower layers importing from higher layers

**Affected:** `domain → ui`

### Circular dependency
A cycle between two modules.

**Affected:** `src/cycle/a.ts`, `src/cycle/b.ts`

## File Details

| File | Folder | Layer | Lines | Functions |
|------|--------|-------|-------|----------|
| `ast.ts` | src/parser | Parser | 220 | 1 |
