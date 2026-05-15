import type { BlackboxDiscoverSummary, BlackboxLocatorCandidate } from "../types.js";

export const WEB_MUTATION_KEYWORDS = [
  "delete",
  "remove",
  "create",
  "submit order",
  "pay",
  "payment",
  "checkout",
  "password",
  "account settings",
  "账号",
  "删除",
  "支付",
  "下单",
  "创建",
  "提交订单",
];

function htmlAttribute(source: string, name: string): string {
  const match = source.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return String(match?.[2] || match?.[3] || match?.[4] || "").trim();
}

function cleanHtmlText(value: string): string {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cssAttributeValue(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function locatorsForHtml(tag: string, attrs: string, selector: string, role: string, text: string): BlackboxLocatorCandidate[] {
  const testId = htmlAttribute(attrs, "data-testid") || htmlAttribute(attrs, "data-test");
  const aria = htmlAttribute(attrs, "aria-label");
  const placeholder = htmlAttribute(attrs, "placeholder");
  const candidates: BlackboxLocatorCandidate[] = [];
  if (testId) candidates.push({ strategy: "testid", value: testId, selector, score: 100, stabilityScore: 100, reason: "data-testid/data-test is the most stable blackbox locator." });
  if ((role === "button" || role === "link" || role === "navigation") && (aria || text)) {
    candidates.push({ strategy: "role", value: role === "navigation" ? "link" : role, name: aria || text, selector, score: 90, stabilityScore: 90, reason: "ARIA role/name is stable and user-visible." });
  }
  if (placeholder) candidates.push({ strategy: "placeholder", value: placeholder, selector, score: 80, stabilityScore: 80, reason: "Placeholder identifies an input from the user perspective." });
  if (text && text.length <= 80) candidates.push({ strategy: "text", value: text, selector, score: tag === "a" || tag === "button" ? 70 : 50, stabilityScore: tag === "a" || tag === "button" ? 70 : 50, reason: "Visible text is user-facing but may change with copy." });
  candidates.push({ strategy: "css", value: selector, selector, score: selector.includes("nth-of-type") ? 20 : 60, stabilityScore: selector.includes("nth-of-type") ? 15 : 55, reason: selector.includes("nth-of-type") ? "nth fallback is fragile and should be reviewed." : "CSS fallback is less semantic than testid/role/label." });
  return candidates.sort((left, right) => right.score - left.score);
}

function inferHtmlRegion(html: string, elementIndex: number, role: string): "nav" | "form" | "list" | "main" {
  const prefix = html.slice(0, elementIndex).toLowerCase();
  const lastNavOpen = prefix.lastIndexOf("<nav");
  const lastNavClose = prefix.lastIndexOf("</nav>");
  if (lastNavOpen > lastNavClose) return "nav";
  const lastFormOpen = prefix.lastIndexOf("<form");
  const lastFormClose = prefix.lastIndexOf("</form>");
  if (lastFormOpen > lastFormClose || role === "input") return "form";
  if (role === "list") return "list";
  return "main";
}

function buildIntentCandidates(actionCandidates: any[], visibleText: string, errorTokens: string[] = [], emptyTokens: string[] = []) {
  const intents: any[] = [];
  const addIntent = (kind: string, candidates: any[], reason: string, assertionHints: any[], confidenceBoost = 0) => {
    if (candidates.length === 0) return;
    const confidence = Math.min(100, Math.max(25, Math.round(candidates.reduce((sum, item) => sum + Number(item.confidence || 50), 0) / candidates.length) + confidenceBoost));
    intents.push({
      id: `intent_${kind}_${intents.length + 1}`,
      kind,
      confidence,
      reason,
      actionCandidateIds: candidates.map((item) => item.id).filter(Boolean),
      assertionHints,
      risk: candidates.some((item) => item.risk === "mutation") ? "mutation" : "safe",
    });
  };
  addIntent(
    "nav",
    actionCandidates.filter((item) => item.region === "nav" || item.role === "navigation" || item.role === "link"),
    "Visible navigation or link controls can drive user route exploration.",
    [{ id: "navigation_visible_result", kind: "selector_visible", selector: "body" }]
  );
  addIntent(
    "form",
    actionCandidates.filter((item) => item.region === "form" || item.role === "input"),
    "Visible form/search/filter controls can drive user input flows.",
    [{ id: "visible_after_input", kind: "selector_visible", selector: "body" }]
  );
  addIntent(
    "list",
    actionCandidates.filter((item) => item.region === "list" || item.role === "list"),
    "Visible list/table-like content can support list/detail or pagination checks.",
    [{ id: "list_visible", kind: "selector_visible", selector: "body" }]
  );
  addIntent(
    "modal",
    actionCandidates.filter((item) => item.region === "modal"),
    "Modal-like controls were visible and may require scoped assertions.",
    [{ id: "modal_visible", kind: "selector_visible", selector: "body" }]
  );
  if (errorTokens.length > 0) {
    addIntent("error", [{ id: "visible_error_state", confidence: 90, risk: "safe" }], `Visible error tokens detected: ${errorTokens.join(", ")}`, [{ id: "no_visible_error", kind: "no_visible_error" }], 10);
  }
  if (emptyTokens.length > 0 || /empty|no data|暂无|无数据/i.test(visibleText)) {
    addIntent("empty", [{ id: "visible_empty_state", confidence: 75, risk: "safe" }], "Visible empty-state copy was detected.", [{ id: "empty_state_visible", kind: "selector_visible", selector: "body" }]);
  }
  if (/loading|spinner|加载中/i.test(visibleText)) {
    addIntent("loading", [{ id: "visible_loading_state", confidence: 70, risk: "safe" }], "Visible loading-state copy was detected.", [{ id: "loading_state_visible", kind: "selector_visible", selector: "body" }]);
  }
  return intents;
}

export function collectWebObserveInventory() {
  const host = globalThis as any;
  const doc = host.document;
  const mutationKeywords = [
    "delete",
    "remove",
    "create",
    "submit order",
    "pay",
    "payment",
    "checkout",
    "password",
    "account settings",
    "账号",
    "删除",
    "支付",
    "下单",
    "创建",
    "提交订单",
  ];
  const clean = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
  const cssString = (value: string) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const selectorFor = (element: any, index: number) => {
    const id = element.getAttribute("id");
    if (id) return `#${String(id).replace(/[^a-zA-Z0-9_-]/g, "\\$&")}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid="${cssString(testId)}"]`;
    const dataTest = element.getAttribute("data-test");
    if (dataTest) return `[data-test="${cssString(dataTest)}"]`;
    const aria = element.getAttribute("aria-label");
    if (aria) return `[aria-label="${cssString(aria)}"]`;
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return `[placeholder="${cssString(placeholder)}"]`;
    const tag = element.tagName.toLowerCase();
    return `${tag}:nth-of-type(${index + 1})`;
  };
  const locatorsFor = (element: any, role: string, selector: string, text: string) => {
    const tag = element.tagName.toLowerCase();
    const testId = clean(element.getAttribute("data-testid") || element.getAttribute("data-test") || "");
    const aria = clean(element.getAttribute("aria-label") || "");
    const placeholder = clean(element.getAttribute("placeholder") || "");
    const labelText = element.id ? clean(doc.querySelector(`label[for="${cssString(element.id)}"]`)?.textContent || "") : "";
    const candidates: any[] = [];
    if (testId) candidates.push({ strategy: "testid", value: testId, selector, score: 100, stabilityScore: 100, reason: "data-testid/data-test is the most stable blackbox locator." });
    if ((role === "button" || role === "link" || role === "navigation") && (aria || text)) {
      candidates.push({ strategy: "role", value: role === "navigation" ? "link" : role, name: aria || text, selector, score: 90, stabilityScore: 90, reason: "ARIA role/name is stable and user-visible." });
    }
    if (labelText) candidates.push({ strategy: "label", value: labelText, selector, score: 85, stabilityScore: 85, reason: "Associated label is stable and user-facing." });
    if (placeholder) candidates.push({ strategy: "placeholder", value: placeholder, selector, score: 80, stabilityScore: 80, reason: "Placeholder identifies an input from the user perspective." });
    if (text && text.length <= 80) candidates.push({ strategy: "text", value: text, selector, score: tag === "a" || tag === "button" ? 70 : 50, stabilityScore: tag === "a" || tag === "button" ? 70 : 50, reason: "Visible text is user-facing but may change with copy." });
    candidates.push({ strategy: "css", value: selector, selector, score: selector.includes("nth-of-type") ? 20 : 60, stabilityScore: selector.includes("nth-of-type") ? 15 : 55, reason: selector.includes("nth-of-type") ? "nth fallback is fragile and should be reviewed." : "CSS fallback is less semantic than testid/role/label." });
    return candidates.sort((left, right) => right.score - left.score);
  };
  const visible = (element: any) => {
    const style = host.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const controls = Array.from(doc.querySelectorAll("nav a[href],a[href],button,[role=button],input,textarea,select,[role=searchbox],ul,ol,[role=list]"))
    .filter((element: any) => visible(element))
    .slice(0, 40)
    .map((element: any, index) => {
      const tag = element.tagName.toLowerCase();
      const text = clean(element.getAttribute("aria-label") || element.placeholder || element.textContent || element.value || "");
      const role = tag === "input" || tag === "textarea" || tag === "select" || element.getAttribute("role") === "searchbox"
        ? "input"
        : tag === "ul" || tag === "ol" || element.getAttribute("role") === "list"
          ? "list"
          : element.closest("nav")
            ? "navigation"
            : tag === "a"
              ? "link"
              : "button";
      const selector = selectorFor(element, index);
      const nearby = clean(`${text} ${element.getAttribute("aria-label") || ""} ${element.href || ""} ${element.closest("form")?.getAttribute("method") || ""} ${element.parentElement?.textContent || ""}`).toLowerCase();
      const riskFlags = mutationKeywords.filter((keyword) => nearby.includes(keyword.toLowerCase())).map((keyword) => `mutation_keyword:${keyword}`);
      const rect = element.getBoundingClientRect();
      const locatorCandidates = locatorsFor(element, role, selector, text);
      const region = element.closest("[role=dialog],dialog,.modal") ? "modal" : element.closest("nav") ? "nav" : element.closest("form") || role === "input" ? "form" : element.closest("table,[role=table]") ? "table" : role === "list" ? "list" : "main";
      const mutationRiskScore = Math.min(100, riskFlags.length * 35);
      const stabilityScore = locatorCandidates[0]?.stabilityScore || locatorCandidates[0]?.score || 0;
      return {
        role,
        selector,
        text: text.slice(0, 160),
        href: element.href || "",
        visible: true,
        locatorCandidates,
        preferredLocator: locatorCandidates[0],
        risk: riskFlags.length > 0 ? "mutation" : "safe",
        riskFlags,
        region,
        confidence: Math.max(25, Math.min(100, stabilityScore - mutationRiskScore / 2)),
        reason: `${role} discovered in ${region} region with ${locatorCandidates[0]?.strategy || "css"} locator.`,
        stabilityScore,
        mutationRiskScore,
        geometry: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
  const bodyText = clean(doc.body?.innerText || "");
  const lower = bodyText.toLowerCase();
  const errorTokens = ["error", "failed", "uncaught", "500", "404", "403", "not found", "forbidden", "unauthorized", "application error"].filter((token) => lower.includes(token));
  const emptyTokens = ["empty", "no data", "暂无", "无数据"].filter((token) => lower.includes(token.toLowerCase()));
  const actionCandidates = controls.map((control: any, index: number) => ({
    id: `candidate_${index + 1}`,
    role: control.role,
    text: control.text,
    selector: control.selector,
    preferredLocator: control.preferredLocator,
    locatorCandidates: control.locatorCandidates,
    href: control.href,
    risk: control.risk,
    riskFlags: control.riskFlags,
    region: control.region || "unknown",
    confidence: control.confidence || 50,
    reason: control.reason || "Observed visible UI control.",
    stabilityScore: control.stabilityScore || control.preferredLocator?.stabilityScore || control.preferredLocator?.score || 0,
    mutationRiskScore: control.mutationRiskScore || 0,
  }));
  const intentCandidates = buildIntentCandidates(actionCandidates, bodyText, errorTokens, emptyTokens);
  const locatorCandidates = actionCandidates.flatMap((item: any) => item.locatorCandidates || []);
  const riskFlags = Array.from(new Set(actionCandidates.flatMap((item: any) => item.riskFlags || [])));
  const coverageHints = [
    controls.length === 0 ? "no_interactive_controls" : "",
    controls.some((control: any) => control.role === "input") ? "" : "no_input_controls",
    controls.some((control: any) => control.role === "navigation" || control.role === "link") ? "" : "no_navigation_controls",
    controls.some((control: any) => control.role === "list") ? "list_or_detail_candidate" : "",
  ].filter(Boolean);
  return { title: doc.title || "", visibleText: bodyText.slice(0, 1200), controls, actionCandidates, intentCandidates, locatorCandidates, riskFlags, coverageHints, errorTokens, emptyTokens };
}

export async function discoverWebUiFromHtml(fetchImpl: typeof fetch, url: string, reason: string): Promise<BlackboxDiscoverSummary> {
  const response = await fetchImpl(url);
  const html = await response.text();
  const title = cleanHtmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const visibleText = cleanHtmlText(html).slice(0, 1200);
  const controls: NonNullable<BlackboxDiscoverSummary["controls"]> = [];
  const tagCounts = new Map<string, number>();
  const elementPattern = /<(a|button|input|textarea|select|ul|ol)\b([^>]*)>([\s\S]*?<\/\1>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = elementPattern.exec(html)) && controls.length < 40) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || "";
    const inner = match[3] || "";
    const text = cleanHtmlText(htmlAttribute(attrs, "aria-label") || htmlAttribute(attrs, "placeholder") || htmlAttribute(attrs, "value") || inner).slice(0, 160);
    const count = (tagCounts.get(tag) || 0) + 1;
    tagCounts.set(tag, count);
    const testId = htmlAttribute(attrs, "data-testid") || htmlAttribute(attrs, "data-test");
    const selector = testId
      ? `[data-testid="${cssAttributeValue(testId)}"]`
      : htmlAttribute(attrs, "aria-label")
        ? `[aria-label="${cssAttributeValue(htmlAttribute(attrs, "aria-label"))}"]`
        : htmlAttribute(attrs, "placeholder")
          ? `[placeholder="${cssAttributeValue(htmlAttribute(attrs, "placeholder"))}"]`
          : `${tag}:nth-of-type(${count})`;
    const role =
      tag === "input" || tag === "textarea" || tag === "select"
        ? "input"
        : tag === "ul" || tag === "ol"
          ? "list"
          : tag === "a"
            ? "link"
            : "button";
    const nearby = `${attrs} ${text} ${inner}`.toLowerCase();
    const riskFlags = WEB_MUTATION_KEYWORDS.filter((keyword) => nearby.includes(keyword.toLowerCase())).map((keyword) => `mutation_keyword:${keyword}`);
    const locatorCandidates = locatorsForHtml(tag, attrs, selector, role, text);
    const region = inferHtmlRegion(html, match.index, role);
    controls.push({
      role,
      selector,
      text,
      href: htmlAttribute(attrs, "href"),
      visible: true,
      locatorCandidates,
      preferredLocator: locatorCandidates[0],
      risk: riskFlags.length > 0 ? "mutation" : "safe",
      riskFlags,
      region,
      confidence: Math.max(25, Math.min(100, (locatorCandidates[0]?.stabilityScore || locatorCandidates[0]?.score || 0) - riskFlags.length * 15)),
      reason: `HTML fallback discovered ${role} in ${region} region with ${locatorCandidates[0]?.strategy || "css"} locator.`,
      stabilityScore: locatorCandidates[0]?.stabilityScore || locatorCandidates[0]?.score || 0,
      mutationRiskScore: Math.min(100, riskFlags.length * 35),
    });
  }
  const actionCandidates = controls.map((control, index) => ({
    id: `candidate_${index + 1}`,
    role: control.role,
    text: control.text,
    selector: control.selector,
    preferredLocator: control.preferredLocator,
    locatorCandidates: control.locatorCandidates || [],
    href: control.href,
    risk: control.risk || "safe",
    riskFlags: control.riskFlags || [],
    region: control.region || "unknown",
    confidence: control.confidence || 50,
    reason: control.reason || "Observed visible UI control from HTML fallback.",
    stabilityScore: control.stabilityScore || control.preferredLocator?.stabilityScore || control.preferredLocator?.score || 0,
    mutationRiskScore: control.mutationRiskScore || 0,
  }));
  const lower = visibleText.toLowerCase();
  const errorTokens = ["error", "failed", "uncaught", "500", "404", "403", "not found", "forbidden", "unauthorized", "application error"].filter((token) => lower.includes(token));
  const emptyTokens = ["empty", "no data", "暂无", "无数据"].filter((token) => lower.includes(token.toLowerCase()));
  const intentCandidates = buildIntentCandidates(actionCandidates, visibleText, errorTokens, emptyTokens);
  const coverageHints = [
    controls.length === 0 ? "no_interactive_controls" : "",
    controls.some((control) => control.role === "input") ? "" : "no_input_controls",
    controls.some((control) => control.role === "navigation" || control.role === "link") ? "" : "no_navigation_controls",
    controls.some((control) => control.role === "list") ? "list_or_detail_candidate" : "",
    `html_fallback:${reason.slice(0, 80)}`,
  ].filter(Boolean);
  return {
    target: "web",
    targetUrl: url,
    title,
    visibleText,
    accessibilitySummary: "",
    controls,
    actionCandidates,
    intentCandidates,
    locatorCandidates: actionCandidates.flatMap((item) => item.locatorCandidates || []),
    riskFlags: Array.from(new Set(actionCandidates.flatMap((item) => item.riskFlags || []))),
    coverageHints,
    errorTokens,
    emptyTokens,
    generatedAt: new Date().toISOString(),
    evidenceRefs: {},
  };
}
