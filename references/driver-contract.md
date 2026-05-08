# Driver Contract

This skill is driver-agnostic.

## Principle

The skill does not care who clicks the page. It cares whether the runtime evidence loop is complete.

Possible drivers:

- Playwright
- Codex `computer use`
- IDE browser agents
- Generic browser-driving agents

## Contract

Any external driver must satisfy all of the following:

1. A `run` exists before meaningful runtime actions begin.
2. A `step` exists for each important action or transition.
3. The relay is bound to the current `runId` and `stepId`.
4. Runtime signals are collected through the SDK, not by scraping console UI.
5. The agent checks `collection` before claiming evidence quality.
6. The agent checks `closure` before claiming success.
7. If unresolved or halted, the agent emits `handoff`.

## Machine-Readable Version

Use:

- `scripts/agent-contract.sh web computer-use`

or call:

- `GET /ai/driver/contract?target=web&driver=computer-use`

That output is the authoritative structured contract for external agents.
