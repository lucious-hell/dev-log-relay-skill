---
name: dev-log-relay
description: Use this skill when the task involves testing, retesting, regression-checking, debugging, runtime validation, or closure verification for a browser Web project or a WeChat Miniapp project. Also use it for Chinese requests such as 测一下、跑一下流程、自测、复测、回归验证、看看还有没有问题、排查报错、白屏、修复后验证、闭环确认. This skill verifies target suitability, checks project integration readiness, starts or inspects relay runs, gathers runtime evidence, and decides closure or handoff. Do not use it for unsupported targets such as Electron, React Native, native mobile, desktop GUI, server batch jobs, or purely non-runtime edits.
---

# Dev Log Relay

This skill turns Web and WeChat Miniapp runtime validation into a repeatable evidence loop.

## Use This Skill When

- Runtime code changed in a Web or Miniapp project
- The user asks to test a flow, retest, regression-check, or see whether fixes really landed
- You observed runtime errors, white screens, broken requests, missing lifecycle continuation, or unresolved closure

Common Chinese trigger phrases:

- “测一下这个页面/项目/流程”
- “跑一下完整流程”
- “自测一下”
- “复测一下刚修的 bug”
- “回归验证一下”
- “看看还有没有问题”
- “排查一下为什么白屏/报错”
- “修完后再验证一下”
- “确认这轮是不是闭环了”

## Do Not Use This Skill When

- The task is documentation-only, mechanical rename-only, or otherwise has no runtime impact
- The target is not browser Web or WeChat Miniapp

## Default Flow

1. Detect target and trigger need
2. Verify project integration readiness
3. Separate evidence level:
   - `project_structure`
   - `instrumentation_attached`
   - `runtime_events_observed`
   - `user_flow_closed`
4. Start or inspect a run
5. Bind relay to the active run/step and drive or observe the target flow
6. Prefer scenario/template validation when it is available
7. Check `collection`, then `diagnosis`, then `closure`
8. Read `release decision`
9. If closure fails or release is blocked, produce `handoff`

## Default Evidence Report

When this skill is triggered for runtime work, the default final answer should be evidence-first, in this order:

1. `target / support`
2. `trigger decision`
3. `project verify`
4. `runtime readiness`
5. `collection`
6. `diagnosis`
7. `closure`
8. `handoff` when unresolved or halted

Short explanation is allowed, but only after the evidence block.

## Command Surface

Prefer the bundled wrapper scripts in `scripts/` instead of typing raw runtime commands:

- `scripts/doctor.sh`
- `scripts/project-verify.sh`
- `scripts/agent-contract.sh`
- `scripts/web-autoloop.sh`
- `scripts/miniapp-verify.sh`
- `scripts/miniapp-run.sh`
- `scripts/miniapp-scenario.sh`
- `scripts/miniapp-closure.sh`
- `scripts/handoff.sh`

If you need deeper protocol endpoints, prefer:

- `relay scenario list`
- `relay scenario inspect`
- `relay project scenarios`
- `relay project baselines`
- `relay ai release-decision --runId <runId>`
- `relay ai verification-report --runId <runId>`
- `relay ci readiness|scenario-smoke|closure|report|regression --runId <runId>`

These wrappers now auto-start the local relay backend when needed. Treat them as the execution surface behind the skill, not as user-facing ceremony.

If you need the detailed policy, read:

- `references/workflow.md` for the operational sequence
- `references/target-matrix.md` for supported and unsupported targets
- `references/driver-contract.md` for driver-agnostic external agent rules

## Required Rules

- For Web runtime work, verify the project first, then run the closed loop
- For Miniapp runtime work, verify first, then run the executable closure chain: `miniapp run -> miniapp scenario -> miniapp closure`
- Treat `project verify` without a real `runId` as project inspection only, not runtime proof
- Only treat `/ai/run/:runId/readiness`, `collection`, and `closure` as runtime-grade evidence
- Treat `scenario`, `state-report`, and `baseline` as stronger proof than raw log presence when available
- Treat `project scenarios`, `scenario inspect`, and `project baselines` as the preferred discovery path before inventing an ad hoc flow spec
- Treat `actions`, `state-snapshots`, and `request-attribution` as run-scoped proof, not optional decoration
- For Miniapp, `miniapp verify` is never a closure claim; only `miniapp run/scenario/closure` can reach `user_flow_closed`
- Distinguish “runtime observed” from “user flow closed”; they are different evidence layers
- Do not end with free-form narrative when a runtime report is available; prefer the evidence report
- Do not claim “verified” or “done” if `closure` is not resolved
- Do not claim “ship” unless the release decision says `ship`
- If `project_only` or `runtime_unverified`, say that explicitly instead of soft-claiming success
- Never use DevTools console UI scraping as the primary evidence chain
- Never claim “done” without checking `closure`
- If the loop halts or confidence is too low, produce `handoff`
