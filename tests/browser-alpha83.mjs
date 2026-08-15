// alpha.8.3 production-bundle browser regressions. Backend/runtime behavior is
// covered by real Python/TLS integrations; these fixtures verify the actual SPA
// consumes those contracts without inventing capability or redirect behavior.
import { chromium } from "playwright";

const base = (process.env.PANEL_URL || "http://127.0.0.1:4173/").replace(/\/+$/, "/");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
await context.addInitScript(() => {
  localStorage.setItem("zagros.token", "alpha83-browser-token");
  localStorage.setItem("zagros.ui", JSON.stringify({ locale: "en", theme: "dark" }));
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const results = [];
const check = (name, condition, detail = "") => {
  results.push([name, Boolean(condition), detail]);
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};
const fulfill = (route, body, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(body),
});
const featureNames = [
  "inbound", "outbound", "routing_source", "routing_destination", "tun",
  "traffic_accounting", "host_settings", "subscription", "tls",
  "version_probe", "node_support",
];
const cell = (state, detail) => ({ state, detail });
const coreCells = (installed, overrides = {}) => Object.fromEntries(featureNames.map((feature) => [
  feature,
  overrides[feature] || cell(installed ? "supported" : "not_installed", `${feature} implementation evidence`),
]));
const capabilityPayload = {
  features: featureNames,
  installed: ["xray", "softether"],
  cores: {
    xray: coreCells(true, { tun: cell("not_applicable", "native in-process routing") }),
    "sing-box": coreCells(false),
    openvpn: coreCells(false),
    wireguard: coreCells(false, { tls: cell("not_applicable", "NoiseIK, not TLS") }),
    ssh: coreCells(false, { tun: cell("unsupported", "no SSH policy TUN") }),
    softether: coreCells(true, {
      outbound: cell("unsupported", "server runtime has no client dataplane"),
      tun: cell("unsupported", "no client policy domain"),
    }),
  },
  all: {},
};
const softetherSchema = {
  core_id: "softether",
  protocols: [
    { id: "sstp", label: "Microsoft SSTP compatibility", default_port: 443,
      availability: "supported", transports: [{ id: "tcp", label: "HTTPS/TCP", securities: [{ id: "none", label: "None", fields: [] }] }] },
    { id: "pptp", label: "PPTP", default_port: 1723, fixed_port: true,
      availability: "unsupported", reason: "PptpGet/PptpEnable are not commands in this SoftEther runtime.", transports: [] },
  ],
};
const schemas = {
  direct: { type: "object", properties: {}, "x-supported": true,
    "x-availability": "supported", "x-capability": { state: "supported", selectable: true } },
  softether_pptp: { type: "object", properties: {}, "x-supported": false,
    "x-availability": "unsupported", "x-disabled-reason": "PPTP is unavailable in the real SoftEther server runtime.",
    "x-capability": { state: "unsupported", selectable: false } },
};
const user = {
  username: "canonical-user", status: "active", used_traffic: 0,
  lifetime_used_traffic: 0, data_limit: 0, expire: null, admin: "admin",
  online_at: null, note: null, proxies: { vless: {} }, inbounds: { vless: [] },
  core_access: {}, subscription_url: "/sub/obsolete-origin-token",
  device_limit: null, telegram_id: null,
};
let statusReads = 0;

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api/, "");
  if (path === "/zagros/cores/capability-matrix") return fulfill(route, capabilityPayload);
  if (path === "/zagros/cores") return fulfill(route, { cores: [
    { id: "softether", name: "SoftEther", state: "running", health: "healthy", enabled: true,
      protocols: ["sstp"], capabilities: [], studio_inbounds_path: "/inbounds" },
  ] });
  if (path === "/zagros/studio/softether/raw") return fulfill(route, { core_id: "softether", json: "{\"inbounds\":[]}" });
  if (path === "/zagros/cores/softether/wizard-schema") return fulfill(route, softetherSchema);
  if (path === "/zagros/certificates") return fulfill(route, { certificates: [] });
  if (path === "/zagros/outbounds") return fulfill(route, { outbounds: [], capabilities: {} });
  if (path === "/zagros/outbounds/schema") return fulfill(route, { schemas });
  if (path === "/users") return fulfill(route, { users: [user], total: 1 });
  if (path === "/zagros/users/online") return fulfill(route, { states: { "canonical-user": "unknown" }, failed_cores: [] });
  if (path === "/user_template") return fulfill(route, []);
  if (path === "/zagros/inbounds") return fulfill(route, { groups: [] });
  if (path === "/zagros/users/by-username/canonical-user/subscription-url") {
    return fulfill(route, {
      path: "/clients/canonical-token",
      url: "https://subscriptions.example.test:8443/clients/canonical-token",
      listener_mode: "dedicated",
    });
  }
  if (path === "/zagros/nodes") return fulfill(route, { nodes: [{
    id: 7, name: "edge-a", address: "node.example.test", port: 62050,
    status: "connected", agent_type: "zagros_native", agent_identity: "abcdef0123456789abcdef",
    certificate_fingerprint: "a".repeat(64), last_seen: new Date().toISOString(),
    health: { healthy: true, resources: { cpu_percent: 2, memory_used: 1024 } },
    cores: { installed: { xray: { core_id: "xray", state: "stopped", core_version: null } },
      available: ["xray", "sing-box", "openvpn", "wireguard", "ssh", "softether"] },
  }] });
  if (path === "/zagros/panel/info") return fulfill(route, {
    version: "1.0.0-alpha.8.3", app_name: "Zagros", domain: "old.example.test",
    panel_base_url: base, app_base_url: base, client_auth_mode: "subscription",
    subscription_path: "clients", tls_mode: "off", uptime_seconds: 10,
    database_driver: "sqlite",
  });
  if (path === "/zagros/settings/panel-network" && request.method() === "GET") return fulfill(route, {
    domain: null, port: 4173, scheme: "http", bind_address: "0.0.0.0",
    trusted_proxies: [], hsts: false, redirect_http_to_https: false,
    tls_certificate_id: null,
  });
  if (path === "/zagros/settings/panel-network/apply" && request.method() === "POST") return fulfill(route, {
    accepted: true, operation_id: "c".repeat(32), status: "pending",
    public_url: "http://new-origin.example.test:8080",
  });
  if (path === "/zagros/settings/panel-network/apply-status") {
    statusReads += 1;
    return fulfill(route, { status: "failed", rolled_back: true,
      message: "apply failed; previous .env restored" });
  }
  return fulfill(route, {});
});

// Canonical five-state capability matrix is a real dashboard consumer.
await page.goto(base + "#/capabilities", { waitUntil: "networkidle" });
const matrixText = await page.locator("main").innerText();
check("capability page renders canonical API matrix", /Capabilities/.test(matrixText) && /routing destination/i.test(matrixText), matrixText.slice(0, 350));
check("capability page preserves Supported", /Supported/.test(matrixText));
check("capability page preserves Unsupported", /Unsupported/.test(matrixText));
check("capability page preserves Not-installed", /Not-installed/.test(matrixText));
check("capability page preserves Not-applicable", /Not-applicable/.test(matrixText));

// PPTP is visible but not selectable, with the runtime reason.
await page.goto(base + "#/inbounds", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /add inbound/i }).click();
const pptp = page.getByRole("button", { name: /PPTP/i });
await pptp.waitFor();
check("SoftEther PPTP remains visible", await pptp.count() === 1);
check("SoftEther PPTP is disabled", await pptp.isDisabled());
check("SoftEther PPTP shows capability reason", /PptpGet\/PptpEnable/.test(await pptp.innerText()));
await page.keyboard.press("Escape");

// Unsupported outbound options are derived from schema capability metadata.
await page.goto(base + "#/outbounds", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /create outbound/i }).click();
const protocolSelect = page.getByRole("dialog").locator("select").first();
const pptpOption = protocolSelect.locator('option[value="softether_pptp"]');
const optionText = await protocolSelect.locator("option").allInnerTexts();
check("SoftEther PPTP outbound option is visible", await pptpOption.count() === 1, JSON.stringify(optionText));
check("SoftEther PPTP outbound option is disabled", await pptpOption.count() === 1 && await pptpOption.evaluate((option) => option.disabled), JSON.stringify(optionText));
check("Outbound option preserves unsupported state", optionText.some((text) => /softether_pptp.*unsupported/.test(text)), JSON.stringify(optionText));
await page.keyboard.press("Escape");

// Copy/QR source uses backend canonical origin/path, never window.origin.
await page.goto(base + "#/users", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Copy subscription/i }).click();
await page.waitForTimeout(250);
const copied = await page.evaluate(() => navigator.clipboard.readText());
check("subscription copy uses configured domain/port/path",
  copied === "https://subscriptions.example.test:8443/clients/canonical-token", copied);

// Native node UI consumes real agent type/health/inventory.
await page.goto(base + "#/nodes", { waitUntil: "networkidle" });
await page.locator("main").getByRole("heading", { name: "Nodes" }).waitFor();
await page.getByText("edge-a", { exact: true }).waitFor();
const nodesText = await page.locator("main").innerText();
check("native node card is rendered", /edge-a/.test(nodesText) && /Zagros Node/.test(nodesText), nodesText.slice(0, 500));
check("native node security contract is visible", /certificate-pinned HTTPS/.test(nodesText) && /No Docker socket/.test(nodesText), nodesText.slice(0, 500));

// Failed/rolled-back host apply never redirects to the candidate origin.
await page.goto(base + "#/settings", { waitUntil: "networkidle" });
const before = page.url();
await page.getByRole("button", { name: /apply with rollback/i }).click();
await page.getByRole("status").filter({ hasText: /rolled back/i }).waitFor({ timeout: 5000 });
check("failed apply status was polled", statusReads >= 1);
check("failure/rollback never redirects", page.url() === before, page.url());
check("rollback is explicit in browser", /rolled back/i.test(await page.getByRole("status").innerText()));

check("browser emitted no render/console errors", errors.length === 0, errors.slice(0, 4).join(" | "));
await browser.close();
const failed = results.filter(([, passed]) => !passed);
console.log(`\nALPHA.8.3 BROWSER E2E: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
