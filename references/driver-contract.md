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

Miniapp drivers may be:

- `devtools-automator`
- `external-agent`
- `generic-miniapp-driver`

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

Miniapp closure flow:

1. `relay miniapp verify`
2. `relay miniapp run`
3. `relay miniapp scenario`
4. `relay miniapp closure`

`miniapp verify` is readiness evidence only. It is not a closure claim.

## Machine-Readable Version

Use:

- `scripts/agent-contract.sh web computer-use`
- `scripts/agent-contract.sh miniapp external-agent`

or call:

- `GET /ai/driver/contract?target=web&driver=computer-use`
- `GET /ai/driver/contract?target=miniapp&driver=external-agent`

Related inspection endpoints:

- `GET /ai/scenario/inspect?templateName=<name>&target=miniapp`
- `GET /ai/project/baselines?target=miniapp`
- `GET /ai/diff/regression?baselineRunId=<a>&currentRunId=<b>`

That output is the authoritative structured contract for external agents.
