# Driver Contract

This skill is driver-agnostic.

## Principle

The skill does not care who clicks the page. It cares whether the runtime evidence loop is complete.

Possible drivers:

- Playwright
- Codex `computer use`
- IDE browser agents
- Generic browser-driving agents
- WeChat DevTools-based Miniapp drivers
- External AI / IDE Miniapp bridges

## Contract

Any external driver must satisfy all of the following:

1. A `run` exists before meaningful runtime actions begin.
2. A `step` exists for each important action or transition.
3. The relay is bound to the current `runId` and `stepId`.
4. Runtime signals are collected through the SDK, not by scraping console UI.
5. The agent checks `collection` before claiming evidence quality.
6. The agent checks `closure` before claiming success.
7. If unresolved or halted, the agent emits `handoff`.

## Miniapp Contract

Miniapp now has a dedicated executable closure contract. The implementation path is different from Web, but the closure vocabulary is aligned.

Miniapp executable drivers may be:

- `devtools-automator`
- `computer-use`
- `generic-miniapp-driver`

`devtools-automator` has a built-in runtime driver backed by `miniprogram-automator`. A supplied `--driverModule` or `DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE` overrides it, and Computer Use remains a ledger bridge. Bootstrap, sidecar health, service-port readiness, generic screenshot-captured messages, or traces are setup/diagnostic signals only; closure still requires action boundary, explicit visible evidence, emitted runtime event, scenario validation, verified controlled profile isolation for the built-in driver, and release decision.

`external-agent` is contract-only in production CLI paths. It can be inspected through `agent contract`, but it must feed evidence through a real bridge/driver module before `miniapp run` can claim executable closure evidence.

Required Miniapp behavior:

1. Create a `run` before action execution.
2. Create a `step` for each meaningful action boundary.
3. Bind all emitted events to `runId` and `stepId`.
4. Emit or feed back evidence for:
   - route / page stack change
   - lifecycle hooks
   - request start/finish
   - `setData` or state signature
   - scenario assertion evidence
5. Validate at least one blocking Miniapp scenario before claiming `user_flow_closed`.
6. Query `closure` and `release-decision` before claiming Miniapp closure.
7. Emit `handoff` when driver execution is unavailable, incomplete, or blocked.
8. Preserve action execution metadata such as `actionId`, completion status, retry count, timeout, and bridge-required outcomes when feeding results back.
9. Use the built-in `devtools-automator` driver for `miniapp run` when available, or provide a real driver module through `--driverModule` / `DEV_LOG_RELAY_MINIAPP_DRIVER_MODULE` to override it.
10. For Codex `computer-use`, provide `DEV_LOG_RELAY_COMPUTER_USE_LEDGER` and ensure `targetProjectRoot`, `planNonce`, `caseNonce`, visible evidence, and action ledger match the invocation workspace and generated blackbox plan.
11. When a driver can provide trace-like evidence, include explicit action boundaries, visible text or screenshot descriptions, and locator/action metadata so the relay can persist an auditable blackbox action trace.

Miniapp closure flow:

1. `relay miniapp verify`
2. `relay miniapp run`
3. `relay miniapp scenario`
4. `relay miniapp closure`

`miniapp verify` is readiness evidence only. It is not a closure claim.

## Machine-Readable Version

Use:

- `scripts/agent-contract.sh web computer-use`
- `scripts/agent-contract.sh miniapp computer-use`
- `scripts/agent-contract.sh miniapp external-agent`

or call:

- `GET /ai/driver/contract?target=web&driver=computer-use`
- `GET /ai/driver/contract?target=miniapp&driver=computer-use`
- `GET /ai/driver/contract?target=miniapp&driver=external-agent`

Related inspection endpoints:

- `GET /ai/scenario/inspect?templateName=<name>&target=miniapp`
- `GET /ai/project/baselines?target=miniapp`
- `GET /ai/diff/regression?baselineRunId=<a>&currentRunId=<b>`

That output is the authoritative structured contract for external agents.
