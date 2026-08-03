# Session Report

| Field | Value |
|-------|-------|
| **Session** | `test-session-001` |
| **Start** | `2025-06-01T10:00:00Z` |
| **CWD** | `/tmp/project` |
| **Version** | 1.0 |
| **Entries** | 2 |


| | |
|---|---|
| **Input tokens** | 100 |
| **Output tokens** | 50 |
| **Cache read** | 10 |
| **Cache write** | 5 |
| **Total tokens** | 165 |
| **Total cost** | $0.0010 |

## File Access

| Action | File |
|--------|------|
| 📖 read | `a.ts` |
| ✏️ write | `b.ts` |
| 📖 read | `a.ts` |

## Conversation

### Turn 1 — Assistant

*tokens=165, cost=$0.0010, stop=`end_turn`*

Multiple edits

- 🔧 `read(path=`a.ts`)`
- 🔧 `read(path=`a.ts`)`
- 🔧 `write(path=`b.ts`, content=`x`)`
- 🔧 `read(path=`a.ts`)`

