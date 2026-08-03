# Session Report

| Field | Value |
|-------|-------|
| **Session** | `test-session-001` |
| **Start** | `2025-06-01T10:00:00Z` |
| **Name** | `A\|B\`C` |
| **Mode** | x\|y\`z |
| **CWD** | `/tmp/project` |
| **Version** | 3 |
| **Entries** | 4 |


| | |
|---|---|
| **Input tokens** | 100 |
| **Output tokens** | 50 |
| **Cache read** | 10 |
| **Cache write** | 5 |
| **Total tokens** | 165 |
| **Total cost** | $0.0010 |

## Tool Usage

| Tool | Calls | Errors |
|------|-------|--------|
| `bash\|pipe` | 1 | — |
| `edit` | 1 | — |

## File Access

| Action | File |
|--------|------|
| 📖 read | `src/weird\|file\`x.ts` |

## Conversation

### Turn 1 — Assistant

*tokens=165, cost=$0.0010, stop=`end_turn`*

Escaping check

- 🔧 `read(path=`src/weird\|file\`x.ts`)`

  📥 `bash|pipe` — 2
  `ok`

  📥 `edit` — 14
  `single line ok`

