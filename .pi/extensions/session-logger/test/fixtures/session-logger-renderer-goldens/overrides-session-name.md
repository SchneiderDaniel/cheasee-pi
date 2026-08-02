# Session Report

| Field | Value |
|-------|-------|
| **Session** | `test-session-001` |
| **Start** | `2025-06-01T10:00:00Z` |
| **Name** | `My Session` |
| **CWD** | `/tmp/project` |
| **Version** | 1.0 |
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

