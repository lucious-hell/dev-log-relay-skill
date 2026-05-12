export async function executeMiniappScenario(input) {
  const pagePath = input.scenario?.pagePath || input.scenario?.entry?.page || "/pages/home/index";
  return [
    {
      actionId: "enter-home",
      type: "enter_page",
      pagePath,
      success: true,
      reason: "mock_driver_entered_page",
      emittedEvents: [
        {
          source: "miniapp",
          level: "info",
          message: `navigateTo ${pagePath}`,
          phase: "navigation",
          route: pagePath,
          tags: ["route_transition"],
          context: { destinationRoute: pagePath, pageStackRoutes: [pagePath] },
        },
        {
          source: "miniapp",
          level: "info",
          message: "HomePage.onLoad",
          phase: "lifecycle",
          route: pagePath,
          tags: ["lifecycle_hook", "ready"],
          context: { hookName: "onLoad" },
        },
        {
          source: "miniapp",
          level: "info",
          message: "wx.request GET /home",
          phase: "network",
          route: pagePath,
          requestId: "mock-req-1",
          network: { url: "/home", method: "GET", stage: "success", ok: true },
        },
        {
          source: "miniapp",
          level: "info",
          message: "HomePage.setData ready",
          phase: "lifecycle",
          route: pagePath,
          tags: ["setData", "state_update", "state_signature", "ready"],
          context: { hookName: "onLoad", keys: ["list", "ready"], stateSignature: "list|ready" },
        },
      ],
    },
  ];
}
