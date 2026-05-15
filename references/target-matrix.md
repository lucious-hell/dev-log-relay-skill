# Target Matrix

## Supported Targets

All supported targets must be reported against the same evidence ladder:

1. `project_structure`
2. `instrumentation_attached`
3. `runtime_events_observed`
4. `user_flow_closed`

Only the fourth layer is strong enough to support a default closure claim.

### Browser Web

- Status: supported
- Full runtime loop: yes
- Reference driver: Playwright
- External drivers: Codex `computer use`, IDE browser agents, generic browser-driving agents
- Runtime target: the invocation workspace project only; built-in demo flows are forbidden in production CLI paths
- Harness: first-class through `relay harness verify`; gate pass requires real target resolution, blackbox visible assertion pass, valid evidence refs, and no blocking runtime failure
- Blackbox loop: supported through Playwright or nonce-matched Computer Use ledger; pass/fail is visible UI evidence only, with persisted evidence refs, evidence capsules, action traces, Playwright trace refs, optional auth profiles, optional visual/a11y quality signals, and optional Playwright export artifacts
- Scenario validation: yes
- Baseline diff: yes
- Required closure signals:
  - console/error
  - route or network
  - render
  - step boundary

### WeChat Miniapp

- Status: automated harness with guarded external boundaries
- Full automatic driving: attempted by the built-in `devtools-automator` driver after managed DevTools profile/bootstrap/sidecar preparation; hard system/account boundaries surface as `forExecutingAI.userActionRequest`
- External drivers: external driverModule override, or Codex `computer use` through `runtime/driver-modules/computer-use-miniapp-driver.mjs` and a target-project action ledger
- Harness: supported through built-in driver, driverModule, or nonce-matched Computer Use ledger; missing action ledger / explicit visible evidence / runtime event returns hold/failure and cannot claim completion. Built-in DevTools automation also requires verified controlled profile isolation before automatic pass
- Blackbox loop: supported with built-in driver, a real driver module, or nonce-matched Computer Use ledger after verify-first; `miniapp bootstrap/doctor` prepares and diagnoses the managed DevTools profile/port/project-path setup, `miniapp sidecar` manages persistent local DevTools lifecycle, while `miniapp driver check` diagnoses driver readiness. None of these diagnostic commands claims closure by itself
- Verify-first flow: required
- Scenario validation: observation-first
- Baseline diff: yes, but depends on run-scoped action/state evidence quality
- Required readiness signals:
  - wrapper or safe patch path
  - lifecycle
  - route or network
  - step boundary

## Auxiliary Only

### Backend

- Status: inapplicable as a standalone target
- Role: auxiliary signal source only

## Unsupported

- Electron
- React Native
- Native mobile
- Desktop GUI
- Non-browser graphical apps
- Server batch or non-interactive jobs

## Consequences

- Unsupported targets must return `unsupported` or `inapplicable`
- Miniapp without verify-readiness must not enter business-fix closure claims
- Web without project readiness must not enter full autoloop claims
- Runtime observation must not be reported as `user_flow_closed`
- Scenario/baseline evidence should be preferred over raw log presence when available
