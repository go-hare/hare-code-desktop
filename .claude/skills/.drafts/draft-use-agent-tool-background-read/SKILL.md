---
name: draft-use-agent-tool-background-read
description: "Draft learned skill candidate. Promote after repeated evidence or explicit user correction."
origin: skill-learning
confidence: 0.55
evolved_from: ["when-the-user-asks-for-use-the-agent-tool-in-bac-789e2f74ba"]
---

# Draft Use Agent Tool Background Read

## Trigger

- When the user asks for Use the Agent tool in background to read /Users/apple/work-py/hare-code/hare-code-desktop/package.json. Wait for that su

## Action

- Reuse the workflow learned from this prompt: Use the Agent tool in background to read /Users/apple/work-py/hare-code/hare-code-desktop/package.json. Wait for that subagent task to finish, then reply with exactly SUBAGENT_UI_O.

## Evidence

- Skill gap prompt: Use the Agent tool in background to read /Users/apple/work-py/hare-code/hare-code-desktop/package.json. Wait for that subagent task to finish, then reply with exactly SUBAGENT_UI_O
- No high-confidence active skill was auto-loaded.
- Observed 2 time(s).

## Promotion Rule

Do not move this draft into active skills until the same gap repeats or the user explicitly confirms this should become reusable.
