# Workflow

This skill is a runtime-evidence protocol for browser Web and WeChat Miniapp projects.

It should be considered active for both English and Chinese task phrasing. Typical Chinese requests include:

- 测一下
- 跑一下流程
- 自测
- 复测
- 回归验证
- 看看还有没有问题
- 排查报错
- 白屏排查
- 修完后验证

## Operating Sequence

### Web

1. Run target check and trigger check.
2. Run project verification.
3. If the project is not ready, stop and fix integration first.
4. Resolve the real target project URL from `--url`, `DEV_LOG_RELAY_TARGET_URL`, or the target project's own start script; stop if no URL can be resolved.
5. Start a run or orchestration.
6. Create steps around meaningful user actions.
7. Bind the Web relay to the active `runId` and `stepId`.
8. Drive the target project page with the current agent driver. Built-in demo flows are forbidden as production evidence.
9. Query:
   - `collection`
   - `diagnosis`
   - `closure`
10. If unresolved, inspect `repair-brief`, `failure-chain`, and `repair-strategy`.
11. If the loop stops or confidence drops, query `handoff`.

### Harness / Blackbox

1. Default to `relay harness verify` when the executing AI needs completion proof for the target project.
2. Treat `HarnessGate.status === "pass"` as the only harness-level pass signal; any hold/manual-review/failure means the executing AI cannot claim completion.
3. Use `relay harness report` for the short handoff and `relay harness evidence` for refs listed in the harness evidence index.
4. Drop to `relay blackbox discover/plan/run/report` only when debugging or composing a lower-level flow.
5. Use Computer Use only by producing a nonce-matched target-project ledger, then replaying it through blackbox/harness with `--driver computer-use --ledger <path>`.
6. Treat only `visible_evidence` / `blackbox_assertion` as pass/fail evidence. Runtime logs, traces, visual/a11y, and locator repair are diagnostics.
7. Use `--storageState` or a runtime auth profile when the target project requires login; do not reuse auth profiles across workspace or origin mismatches.
8. Use `relay blackbox export --runId <runId> --format playwright` to reuse passed Web cases as artifact-backed Playwright specs. Do not write into the target project unless `--out` is explicitly requested.

### Miniapp

1. Run target check and trigger check.
2. Run project verification.
3. If wrapper/patch/lifecycle/route/network readiness is insufficient, stop and fix integration first.
4. Run `relay harness verify --target miniapp` first; it auto-prepares the managed WeChat DevTools profile, checks/starts the sidecar, resolves the built-in `devtools-automator` driver or an external override, and only returns `forExecutingAI.userActionRequest` when a real system/account boundary needs minimal user action. Use `relay miniapp bootstrap --fix --pretty`, `relay miniapp doctor --fix --pretty`, and `relay miniapp sidecar install --start --pretty` only as lower-level diagnostics. `external-agent` alone is contract-only. For Codex Computer Use closure, use the `computer-use` driver module with a target-project ledger.
5. Start a run or orchestration when there is enough signal coverage.
6. Bind the Miniapp relay to the active `runId` and `stepId`.
7. Drive or observe the Miniapp flow.
8. Query:
   - `collection`
   - `diagnosis`
   - `miniapp-signals`
   - `scenario` / `state-report`
   - `closure`
   - `release-decision`
9. If unresolved or incomplete, emit `handoff`.

## Evidence Order

For completion-proof tasks, read harness evidence first:

1. `HarnessGate`
2. `targetProject`
3. `validatedUserFlows` / `blockedUserFlows`
4. `visible evidence summary`
5. `evidence capsule`, `trace`, and registered artifact refs
6. `regression seed` when blocked

When debugging a held harness run, read lower-level evidence in this order:

1. evidence layer
   - `project_structure`
   - `instrumentation_attached`
   - `runtime_events_observed`
   - `user_flow_closed`
2. `collection`
3. `integrity` / `readiness`
   - project-only readiness is not enough for closure
   - prefer run-scoped readiness from a real `runId`
4. `scenario` / `state-report` / `baseline`
   - if project-local assets exist, inspect `project scenarios` / `project baselines` first
5. `timeline`
6. `diagnosis`
7. `repair-brief`
8. `closure`
9. `handoff` if needed

## Default Report Template

For runtime validation tasks, the default final report should be structured before any prose:

1. `targetProject`
2. `HarnessGate`
3. `validatedUserFlows`
4. `blockedUserFlows`
5. `visible evidence summary`
6. `runtime diagnostic clues`
7. `evidence refs / capsule / trace`
8. `regression seed` when blocked
9. `handoff` if unresolved or halted

Natural-language explanation is secondary. Do not replace the evidence block with a prose-only summary.

## Scenario Preference

If a scenario template or explicit `ScenarioSpec` is available, prefer it over ad hoc log reading.

- Web: scenario validation is the preferred proof of `user_flow_closed`
- Miniapp: scenario validation is observation-first and should be treated as stronger than raw signal presence, but weaker than a fully driven web loop

## Stop Conditions

- `closure.decision.status === resolved`
- `collection.status === incomplete`
- integrity/readiness too low
- regressions appear
- blocking baseline diff or release decision says `hold`
- repeated no-progress loop
- maximum attempts reached
