# Target Matrix

## Supported Targets

### Browser Web

- Status: supported
- Full runtime loop: yes
- Reference driver: Playwright
- External drivers: Codex `computer use`, IDE browser agents, generic browser-driving agents
- Required closure signals:
  - console/error
  - route or network
  - render
  - step boundary

### WeChat Miniapp

- Status: partial
- Full automatic driving: no
- Verify-first flow: required
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
