---
name: dev-log-relay
description: Use this skill when the task involves testing, retesting, regression-checking, debugging, runtime validation, or closure verification for a browser Web project or a WeChat Miniapp project. Also use it for Chinese requests such as 测一下、跑一下流程、自测、复测、回归验证、看看还有没有问题、排查报错、白屏、修复后验证、闭环确认. This skill verifies target suitability, checks project integration readiness, starts or inspects relay runs, gathers runtime evidence, and decides closure or handoff. Do not use it for unsupported targets such as Electron, React Native, native mobile, desktop GUI, server batch jobs, or purely non-runtime edits.
---

# Dev Log Relay

This skill is a target-project verification harness for executing AI. It resolves the real Web or WeChat Miniapp project, starts or attaches to the real environment, runs user-visible blackbox flows, persists evidence, seeds regressions when blocked, and returns a release gate that prevents self-certified completion.

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

1. Detect whether the task needs target-project runtime proof.
2. Run the harness entrypoint against the invocation workspace:
   - Web: `scripts/harness-verify.sh --target web ...`
   - Miniapp: `scripts/harness-verify.sh --target miniapp ...`
3. For Web, provide `--url`, `DEV_LOG_RELAY_TARGET_URL`, or let the harness auto-start the target project. Never fall back to a built-in demo.
4. For Miniapp, run the harness directly first. It auto-prepares the Dev Log Relay managed WeChat DevTools profile, sidecar, service port, and built-in `devtools-automator` driver when possible. Use `--driverModule` / `DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE` only to override the built-in driver, or use a nonce-matched Computer Use ledger with `--driver computer-use --ledger <path>`.
5. Read the returned `HarnessGate`.
6. If `HarnessGate.status === "pass"`, use `scripts/harness-report.sh` and `scripts/harness-evidence.sh` for handoff-grade proof.
7. If the harness holds, use the linked blackbox report, capsule, trace, regression seed, and low-level commands only for diagnosis or repair.

## Default Evidence Report

When this skill is triggered for runtime work, the default final answer should be evidence-first, in this order:

1. `targetProject`
2. `HarnessGate`
3. `validatedUserFlows`
4. `blockedUserFlows`
5. `visible evidence summary`
6. `runtime diagnostic clues`
7. `evidence refs / capsule / trace`
8. `regression seed` when blocked
9. `next action / handoff`

Short explanation is allowed, but only after the evidence block.

## Command Surface

Prefer the bundled wrapper scripts in `scripts/` instead of typing raw runtime commands:

- `scripts/doctor.sh`
- `scripts/harness-verify.sh`
- `scripts/harness-report.sh`
- `scripts/harness-evidence.sh`
- `scripts/miniapp-bootstrap.sh`
- `scripts/miniapp-doctor.sh`
- `scripts/miniapp-sidecar.sh`
- `scripts/project-verify.sh`
- `scripts/agent-contract.sh`
- `scripts/web-autoloop.sh`
- `scripts/miniapp-verify.sh`
- `scripts/miniapp-run.sh`
- `scripts/miniapp-scenario.sh`
- `scripts/miniapp-closure.sh`
- `scripts/handoff.sh`

Use these lower-level commands only for debugging, repair, or fallback when the harness report points to a specific missing layer:

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

- For Web runtime work, default to `scripts/harness-verify.sh --target web`; use `project verify`, `blackbox`, or `autoloop` only as lower-level diagnostics.
- For Miniapp runtime work, default to `scripts/harness-verify.sh --target miniapp`; it runs auto-prepare, Miniapp bootstrap diagnostics, sidecar health checks, driver resolution, and the built-in `devtools-automator` driver before falling back to structured failure. If the result contains `forExecutingAI.userActionRequest.required === true`, relay only those minimal user steps and then retry the returned command. Use `miniapp bootstrap/doctor/sidecar/verify/run/scenario/closure` only as lower-level diagnostics.
- Web closed-loop commands must target the invocation workspace project; use `--url`, `DEV_LOG_RELAY_TARGET_URL`, or the target project's own start script. Never use a built-in demo as runtime evidence.
- Default to `relay harness verify` when the executing AI needs proof of completion. Treat it as the target-project verification harness: real environment start/attach, blackbox user flow, evidence index, regression seed, and release gate in one report.
- Only `HarnessGate.status === "pass"` can be interpreted as target-project verification passed. A hold/manual-review/failed blackbox gate means the executing AI must not claim completion.
- For Miniapp built-in `devtools-automator`, a generic screenshot-captured message is diagnostic only, not visible proof. Harness pass requires explicit user-visible UI evidence and verified controlled profile isolation.
- For user-perspective validation, use `relay blackbox discover/plan/run/report`; blackbox pass/fail must be based on visible UI evidence, not internal API calls, mocks, component state, or runtime logs alone.
- Use `relay harness report --harnessRunId <id>` and `relay harness evidence --harnessRunId <id> --ref <artifactRef>` for harness-grade handoff; artifact refs must come from the harness evidence index.
- Use `relay store inspect --runId <runId>` or `relay store inspect --harnessRunId <id>` when an executing AI needs the persisted artifact manifest; use `relay store cleanup --dryRun` before any cleanup, and require `--confirm` for deletion.
- Use `relay blackbox capsule --runId <runId>` for short handoff evidence, `relay blackbox trace --runId <runId> --format summary|relay|playwright` for auditable traces, and `relay blackbox export --runId <runId> --format playwright` only to reuse passed blackbox cases. Default exports stay in the runtime artifact store; write into a project only when the caller explicitly supplies `--out`.
- For authenticated Web targets, use `--storageState`, `DEV_LOG_RELAY_WEB_STORAGE_STATE`, or a runtime auth profile via `--authProfile`; profiles must match the invocation workspace and target URL origin.
- Treat visual/a11y signals as auxiliary release clues only. Blank screens and unnamed key controls can block release, but screenshots, accessibility summaries, Playwright traces, and locator repair suggestions never replace visible blackbox assertions.
- Locator repair results are audit candidates. A repaired case may become `manual_review_required`, but it must not auto-ship or be exported as a stable passing test.
- Miniapp `run` uses the built-in `devtools-automator` driver when available; a real executable driver module via `--driverModule` or `DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE` has priority when supplied. `external-agent` is contract-only and cannot produce closure evidence.
- Use `relay miniapp bootstrap --fix --pretty` or `relay miniapp doctor --fix --pretty` only when diagnosing the lower-level setup path; the default harness already attempts this automatically. Use `relay miniapp driver check --pretty` to diagnose built-in driver, external driver module, DevTools CLI, service port, automator version, launch/connect mode, profile isolation, and project path issues without claiming closure.
- Use `relay miniapp sidecar install --start --pretty` when the executing AI needs a persistent local helper for WeChat DevTools lifecycle. The sidecar manages health checks and controlled DevTools launch, but it never replaces driverModule/Computer Use ledger evidence or HarnessGate.
- Use `relay miniapp bootstrap --driver computer-use --pretty` only as a first-time pairing contract for Codex Computer Use. Computer Use can operate the DevTools UI after app approval, but its setup ledger is not closure evidence.
- Codex Computer Use may drive Miniapp only through a real driver module such as `runtime/driver-modules/computer-use-miniapp-driver.mjs` plus a target-project action ledger in `DEV_LOG_RELAY_COMPUTER_USE_LEDGER`.
- Codex Computer Use may drive Web or Miniapp blackbox flows only by producing a target-project ledger with `planNonce`, `caseNonce`, visible evidence, and action ledger, then replaying it through `relay blackbox run --driver computer-use --ledger <path>`.
- Blackbox reports, evidence capsules, action traces, Playwright traces, exports, auth profiles, and evidence refs are persisted by the relay runtime store; use `relay blackbox report --runId <runId>`, `relay blackbox capsule --runId <runId>`, `relay blackbox trace --runId <runId>`, and `/ai/run/:runId/evidence-refs` for handoff-grade proof.
- Treat `project verify` without a real `runId` as project inspection only, not runtime proof
- Only treat `/ai/run/:runId/readiness`, `collection`, and `closure` as runtime-grade evidence
- Treat `scenario`, `state-report`, and `baseline` as stronger proof than raw log presence when available
- Treat `project scenarios`, `scenario inspect`, and `project baselines` as the preferred discovery path before inventing an ad hoc flow spec
- Treat `actions`, `state-snapshots`, and `request-attribution` as run-scoped proof, not optional decoration
- For Miniapp, `miniapp verify` is never a closure claim; harness pass or a real `miniapp run/scenario/closure` chain with action ledger can reach `user_flow_closed`
- Distinguish “runtime observed” from “user flow closed”; they are different evidence layers
- Do not end with free-form narrative when a runtime report is available; prefer the evidence report
- Do not claim “verified” or “done” if `closure` is not resolved
- Do not claim “ship” unless the release decision says `ship`
- If `project_only` or `runtime_unverified`, say that explicitly instead of soft-claiming success
- Never use DevTools console UI scraping as the primary evidence chain
- Never claim “done” without checking `closure`
- If the loop halts or confidence is too low, produce `handoff`
