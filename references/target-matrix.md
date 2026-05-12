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
- Scenario validation: yes
- Baseline diff: yes
- Required closure signals:
  - console/error
  - route or network
  - render
  - step boundary

### WeChat Miniapp

- Status: partial
- Full automatic driving: driver-dependent
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
