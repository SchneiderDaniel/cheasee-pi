# Session Report

| Field | Value |
|-------|-------|
| **Session** | `test-session-001` |
| **Start** | `2025-06-01T10:00:00Z` |
| **CWD** | `/tmp/project` |
| **Version** | 1.0 |
| **Entries** | 6 |


| | |
|---|---|
| **Input tokens** | 110 |
| **Output tokens** | 55 |
| **Cache read** | 10 |
| **Cache write** | 5 |
| **Total tokens** | 180 |
| **Total cost** | $0.0010 |

## Tool Usage

| Tool | Calls | Errors |
|------|-------|--------|
| `read` | 1 | — |

## File Access

| Action | File |
|--------|------|
| 📖 read | `src/main.py` |

## Conversation

### Turn 1 — User

First user question

*tokens=165, cost=$0.0010, stop=`end_turn`*

> 💭 Let me think about this.

I'll check the file.

- 🔧 `read(path=`src/main.py`)`

  📥 `read` — 20
  ```
  def main():
      pass
  ```

---

### Turn 2 — User

Follow up question

*tokens=15, stop=`end_turn`*

Done.

