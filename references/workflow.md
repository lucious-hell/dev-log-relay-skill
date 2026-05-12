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
4. Start a run or orchestration.
5. Create steps around meaningful user actions.
6. Bind the Web relay to the active `runId` and `stepId`.
7. Drive the page with the current agent driver.
8. Query:
   - `collection`
   - `diagnosis`
   - `closure`
9. If unresolved, inspect `repair-brief`, `failure-chain`, and `repair-strategy`.
10. If the loop stops or confidence drops, query `handoff`.

### Miniapp

1. Run target check and trigger check.
2. Run project verification.
3. If wrapper/patch/lifecycle/route/network readiness is insufficient, stop and fix integration first.
4. Start a run or orchestration when there is enough signal coverage.
5. Bind the Miniapp relay to the active `runId` and `stepId`.
6. Drive or observe the Miniapp flow.
7. Query:
   - `collection`
   - `diagnosis`
   - `miniapp-signals`
   - `scenario` / `state-report`
   - `closure`
   - `release-decision`
8. If unresolved or incomplete, emit `handoff`.

## Evidence Order

Always read evidence in this order:

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

1. `target / support`
2. `trigger decision`
3. `project verify`
4. `runtime readiness`
5. `collection`
6. `diagnosis`
7. `closure`
8. `handoff` if unresolved or halted

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
