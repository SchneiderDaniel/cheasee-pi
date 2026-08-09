---
name: handover
description: Create a handover document in ignore/ from one agent to another. Should be used when the context window is displayed as red in the statusline (dump zone reached).
disable-model-invocation: true
---

# Handover

Write a concise handover document summarising the current conversation including the task so a fresh agent can continue the work. Save it to folder ignore and give it a name with <datetime>\_<topic>.md

Document the skills to be used, if any, by the next session.
Document what you next planned steps are.
Document what descisions failed, if any, in the current session.
Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.
