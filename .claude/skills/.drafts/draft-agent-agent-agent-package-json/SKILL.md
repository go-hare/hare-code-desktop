---
name: draft-agent-agent-agent-package-json
description: "Draft learned skill candidate. Promote after repeated evidence or explicit user correction."
origin: skill-learning
confidence: 0.55
evolved_from: ["when-the-user-asks-for-agent-agent-agent-package-3d143cbfea"]
---

# Draft Agent Agent Agent Package Json

## Trigger

- When the user asks for 请调用一次 Agent 子 agent。要求子 agent 只读取当前项目 package.json 并返回 package name。主 agent 不要自己读文件。

## Action

- Reuse the workflow learned from this prompt: 请调用一次 Agent 子 agent。要求子 agent 只读取当前项目 package.json 并返回 package name。主 agent 不要自己读文件。.

## Evidence

- Skill gap prompt: 请调用一次 Agent 子 agent。要求子 agent 只读取当前项目 package.json 并返回 package name。主 agent 不要自己读文件。
- No high-confidence active skill was auto-loaded.
- Observed 2 time(s).

## Promotion Rule

Do not move this draft into active skills until the same gap repeats or the user explicitly confirms this should become reusable.
