---
name: draft-agent
description: "Draft learned skill candidate. Promote after repeated evidence or explicit user correction."
origin: skill-learning
confidence: 0.55
evolved_from: ["when-the-user-asks-for-agent-reuse-the-workflow--e1627ab55e"]
---

# Draft Agent

## Trigger

- When the user asks for 分析当前项目 开子 agent

## Action

- Reuse the workflow learned from this prompt: 分析当前项目 开子 agent.

## Evidence

- Skill gap prompt: 分析当前项目 开子 agent
- No high-confidence active skill was auto-loaded.
- Observed 2 time(s).

## Promotion Rule

Do not move this draft into active skills until the same gap repeats or the user explicitly confirms this should become reusable.
