// Real Chromium UI regressions for the post-alpha.7.5 bug-fix cycle.
// API responses are deterministic browser fixtures; backend/runtime behavior
// is covered by the Python integration and real-core gates.
import { chromium } from "playwright";

const base = (process.env.PANEL_URL || "http://127.0.0.1:4173/").replace(/\/+$/, "/");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
await context.addInitScript(() => {
  localStorage.setItem("zagros.token", "browser-test-token");
  localStorage.setItem("zagros.ui", JSON.stringify({ locale: "en", theme: "light" }));
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const results = [];
const ok = (name, condition, detail = "") => {
  results.push([name, !!condition, detail]);
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};
const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const users = Array.from({ length: 10 }, (_, index) => ({
  username: index === 9 ? "a-very-long-username-that-must-never-overlap-the-next-row" : `user-${index + 1}`,
  status: "active",
  used_traffic: index * 1024,
  lifetime_used_traffic: index * 1024,
  data_limit: 1024 * 1024,
  expire: null,
  admin: "admin",
  online_at: null,
  note: index % 2 ? "long user information that wraps independently inside this measured virtual row" : null,
  proxies: { vless: {} },
  inbounds: { vless: [] },
  core_access: index % 2 ? { wireguard: ["wg-main", "wg-backup"], openvpn: ["ovpn-main"] } : {},
  subscription_url: `/sub/token-${index + 1}`,
  device_limit: null,
  telegram_id: null,
}));
const states = Object.fromEntries(users.map((user, index) => [
  user.username, index === 0 ? "online" : index === 1 ? "offline" : "unknown",
]));
const catalog = { groups: [
  { core_id: "xray", name: "Xray", enabled: true,
    inbounds: [{ tag: "vless-ws", protocol: "vless", port: 443 }] },
  { core_id: "wireguard", name: "WireGuard", enabled: true,
    inbounds: [{ tag: "wg-main", protocol: "wireguard", port: 51820 }] },
] };
const coreRows = [
  { id: "xray", name: "Xray", state: "running", enabled: true,
    protocols: ["vless"], capabilities: [], studio_inbounds_path: "/inbounds" },
  { id: "softether", name: "SoftEther", state: "installed", enabled: true,
    protocols: ["softether", "l2tp", "l2tp_raw", "sstp", "ovpn"],
    capabilities: ["self_install"], studio_inbounds_path: "/inbounds" },
];
const xraySchema = {
  core_id: "xray",
  protocols: [{ id: "vless", label: "VLESS", default_port: 443, transports: [
    { id: "ws", label: "WebSocket", securities: [
      { id: "none", label: "None", fields: [{ key: "path", label: "WebSocket path", type: "string", default: "/ws", section: "transport" }] },
      { id: "tls", label: "TLS", fields: [
        { key: "sni", label: "SNI / certificate name", type: "string", required: true, section: "tls" },
        { key: "certificate", label: "certificate (PEM)", type: "file", section: "certificate" },
        { key: "certificate_key", label: "private key (PEM)", type: "file", section: "certificate" },
      ] },
    ] },
    { id: "grpc", label: "gRPC", securities: [
      { id: "none", label: "None", fields: [
        { key: "service_name", label: "gRPC service name", type: "string", required: true, section: "transport" },
      ] },
    ] },
  ] }],
};
const softetherSchema = {
  core_id: "softether",
  protocols: [
    { id: "softether", label: "Native SoftEther VPN", default_port: 5555,
      transports: [{ id: "tcp", label: "TCP", securities: [{ id: "none", label: "None", fields: [] }] }] },
    { id: "l2tp", label: "L2TP/IPsec", default_port: 1701,
      transports: [{ id: "udp", label: "UDP 500/4500/1701", securities: [{ id: "none", label: "None", fields: [
        { key: "ipsec_psk", label: "IPsec pre-shared key", type: "string", required: true,
          default: "A7sK2pQ9_", section: "general" },
      ] }] }] },
    { id: "sstp", label: "Microsoft SSTP compatibility", default_port: 443,
      transports: [{ id: "tcp", label: "HTTPS/TCP", securities: [{ id: "none", label: "None", fields: [] }] }] },
  ],
};
let createdUserPayload = null;
let previewPayload = null;

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api/, "");
  if (request.method() === "GET" && path === "/users") return json(route, { users, total: users.length });
  if (request.method() === "GET" && path === "/zagros/users/online") return json(route, { states, failed_cores: [] });
  if (request.method() === "GET" && path === "/user_template") return json(route, [{
    id: 1, name: "WireGuard template", data_limit: 5 * 1024 ** 3, expire_duration: 86400,
    username_prefix: "tpl-", username_suffix: "-z", inbounds: {}, core_access: { wireguard: ["wg-main"] },
  }]);
  if (request.method() === "GET" && path === "/zagros/inbounds") return json(route, catalog);
  if (request.method() === "POST" && path === "/user") {
    createdUserPayload = request.postDataJSON();
    return json(route, { ...users[0], ...createdUserPayload, subscription_url: "/sub/new-token" });
  }
  if (request.method() === "GET" && path === "/zagros/cores") return json(route, { cores: coreRows });
  if (request.method() === "GET" && path === "/zagros/studio/xray/raw") return json(route, { core_id: "xray", json: "{\"inbounds\":[]}" });
  if (request.method() === "GET" && path === "/zagros/studio/softether/raw") return json(route, { core_id: "softether", json: "{\"inbounds\":[]}" });
  if (request.method() === "GET" && path === "/zagros/cores/xray/wizard-schema") return json(route, xraySchema);
  if (request.method() === "GET" && path === "/zagros/cores/softether/wizard-schema") return json(route, softetherSchema);
  if (request.method() === "GET" && path.endsWith("/suggest-port")) return json(route, { port: 38472 });
  if (request.method() === "GET" && path === "/zagros/certificates") return json(route, { certificates: [] });
  if (request.method() === "GET" && path === "/zagros/cores/xray/hosts") return json(route, {
    "vless-ws": [{ remark: "🛸 Zagros ({USERNAME}) [{PROTOCOL} - {TRANSPORT}]", address: "{SERVER_IP}", port: null,
      sni: "", host: "", path: "", security: "inbound_default", alpn: "", fingerprint: "", is_disabled: false }],
  });
  if (request.method() === "GET" && path === "/zagros/cores/wireguard/hosts") return json(route, {
    "wg-main": [{ remark: "🛸 Zagros ({USERNAME}) [{PROTOCOL} - {TRANSPORT}]", address: "{SERVER_IP}", port: null, is_disabled: false }],
  });
  if (request.method() === "GET" && path === "/zagros/cores/wireguard/hosts/schema") return json(route, {
    engine: "WireGuard", inbounds: [{ tag: "wg-main", protocol: "wireguard", fields: ["remark", "address", "port", "is_disabled"] }],
  });
  if (request.method() === "POST" && path.includes("/wizard/preview")) {
    previewPayload = request.postDataJSON();
    return json(route, { valid: true, errors: [], diff: "+ valid" });
  }
  if (request.method() === "POST" && path.endsWith("/wizard/inbound")) return json(route, { changed: true, materialized: true });
  if (request.method() === "GET" && path.startsWith("/user/")) return json(route, {}, 404);
  return json(route, {});
});

// Users: dynamic virtual-row measurement, long identity, three presence states.
await page.goto(base + "#/users", { waitUntil: "networkidle" });
await page.locator('[role="row"][data-index]').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(700);
async function rowsDoNotOverlap() {
  const boxes = await page.locator('[role="row"][data-index]').evaluateAll((rows) => rows
    .map((row) => row.getBoundingClientRect())
    .map((box) => ({ top: box.top, bottom: box.bottom, height: box.height }))
    .sort((a, b) => a.top - b.top));
  return boxes.length >= 2 && boxes.every((box, index) => index === boxes.length - 1 || box.bottom <= boxes[index + 1].top + 0.5);
}
ok("users desktop: measured virtual rows do not overlap", await rowsDoNotOverlap());
for (const state of ["online", "offline", "unknown"]) {
  ok(`presence ${state}: DOM element always exists`, await page.locator(`[data-presence="${state}"]`).count() >= 1);
}
await page.getByRole("button", { name: /Copy subscription/i }).first().click();
const copiedSubscription = await page.evaluate(() => navigator.clipboard.readText());
ok("subscription copy uses canonical /sub/<token>", /\/sub\/token-1$/.test(copiedSubscription) && !copiedSubscription.includes("/zagros/sub/"), copiedSubscription);
await page.setViewportSize({ width: 390, height: 820 });
await page.waitForTimeout(700);
ok("users mobile: rows do not overlap (horizontal scroll instead)", await rowsDoNotOverlap());
await page.setViewportSize({ width: 1400, height: 900 });

// Template user: selecting a non-Xray-only template generates a username,
// enables Save, and sends the real core_access payload.
await page.getByRole("button", { name: "New user" }).click();
const userDialog = page.getByRole("dialog");
await userDialog.waitFor();
await userDialog.locator("button").filter({ hasText: /From template/i }).click();
const templateSelect = userDialog.locator("select").filter({ has: page.locator('option[value="1"]') });
await templateSelect.selectOption("1");
const saveUser = userDialog.getByRole("button", { name: /^Save$/i });
ok("template user: Save enabled", !(await saveUser.isDisabled()));
await saveUser.click();
await page.waitForTimeout(300);
ok("template user: API payload grants selected core", createdUserPayload?.core_access?.wireguard?.[0] === "wg-main");
ok("template user: username policy applied", /^tpl-.+-z$/.test(createdUserPayload?.username || ""), createdUserPayload?.username || "");

// Old portal issuer UI is absent even in Edit User.
await page.locator('[role="row"][data-index="0"]').click();
await page.getByRole("dialog").waitFor();
const editText = await page.getByRole("dialog").innerText();
ok("edit user: old multi-core portal section absent", !/Multi-core subscription|Issue portal link/i.test(editText));
await page.keyboard.press("Escape");

// Manual user creation still follows the independent manual selection path.
createdUserPayload = null;
await page.getByRole("button", { name: "New user" }).click();
const manualDialog = page.getByRole("dialog");
await manualDialog.locator("#username").fill("manual-browser-user");
const manualSave = manualDialog.getByRole("button", { name: /^Save$/i });
ok("manual user: Save enabled", !(await manualSave.isDisabled()));
await manualSave.click();
await page.waitForTimeout(250);
ok("manual user: xray proxy payload sent", !!createdUserPayload?.proxies?.vless);

// Host defaults and field identity are core-aware, not blind Xray copies.
await page.goto(base + "#/hosts", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
const hostValues = await page.locator("main input").evaluateAll((inputs) => inputs.map((input) => input.value));
const hostPageText = (await page.locator("main").innerText()).slice(0, 500);
ok("hosts: Zagros default remark present", hostValues.some((value) => value.includes("🛸 Zagros")), JSON.stringify(hostValues) + " / " + hostPageText);
ok("hosts: SERVER_IP default address present", hostValues.includes("{SERVER_IP}"), JSON.stringify(hostValues) + " / " + hostPageText);
const hostsCoreSelect = page.locator("main select").first();
await hostsCoreSelect.selectOption("wireguard");
await page.waitForTimeout(350);
const hostsBody = await page.locator("main").innerText();
ok("hosts: WireGuard hides Xray TLS identity fields", !/\bSNI\b|\bALPN\b|fingerprint|allowInsecure|Security/i.test(hostsBody));

// Inbound TLS certificate section follows security state exactly.
await page.goto(base + "#/inbounds", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /add inbound/i }).first().click();
let wizard = page.getByRole("dialog");
await wizard.getByRole("button", { name: /continue/i }).click(); // protocol
await wizard.getByRole("button", { name: /continue/i }).click(); // ws
await wizard.getByRole("button", { name: /^None$/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
ok("security none: Certificate section hidden", !(await wizard.locator('[data-wizard-section="certificate"]').count()));
await wizard.getByRole("button", { name: /back/i }).click();
await wizard.getByRole("button", { name: /^TLS$/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
const tlsCertificateCount = await wizard.locator('[data-wizard-section="certificate"]').count();
ok("security TLS: Certificate section visible", tlsCertificateCount >= 1,
  `count=${tlsCertificateCount} / ${(await wizard.innerText()).slice(0, 350)}`);
await wizard.getByRole("button", { name: /back/i }).click();
await wizard.getByRole("button", { name: /^None$/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
ok("TLS → None: Certificate state/section cleared", !(await wizard.locator('[data-wizard-section="certificate"]').count()));
await page.keyboard.press("Escape");

// gRPC service_name reaches the exact preview API payload.
await page.getByRole("button", { name: /add inbound/i }).first().click();
wizard = page.getByRole("dialog");
await wizard.getByRole("button", { name: /continue/i }).click();
await wizard.getByRole("button", { name: /^gRPC$/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
await wizard.getByRole("button", { name: /^None$/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
const serviceInput = wizard.locator("label").filter({ hasText: "gRPC service name" }).locator("input");
await serviceInput.fill("my-service");
await serviceInput.blur();
await page.waitForTimeout(600);
ok("gRPC UI → API: service_name preserved", previewPayload?.settings?.service_name === "my-service", JSON.stringify(previewPayload?.settings || {}));
await page.keyboard.press("Escape");

// SoftEther L2TP gets the visible/editable/copyable random key; SSTP does not.
const coreSelect = page.locator("main select").first();
await coreSelect.selectOption("softether");
await page.waitForTimeout(300);
await page.getByRole("button", { name: /add inbound/i }).first().click();
wizard = page.getByRole("dialog");
await wizard.getByRole("button", { name: /L2TP\/IPsec/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
await wizard.getByRole("button", { name: /^None$/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
const pskInput = wizard.locator('[data-generated-secret="ipsec_psk"] input');
const pskValue = await pskInput.inputValue();
ok("SoftEther L2TP: secure default PSK visible/editable", pskValue.length === 9, pskValue.replace(/./g, "*"));
ok("SoftEther L2TP: PSK copy control exists", await wizard.getByRole("button", { name: /copy IPsec/i }).count() === 1);
await page.keyboard.press("Escape");
await page.getByRole("button", { name: /add inbound/i }).first().click();
wizard = page.getByRole("dialog");
await wizard.getByRole("button", { name: /SSTP/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
await wizard.getByRole("button", { name: /^None$/i }).click();
await wizard.getByRole("button", { name: /continue/i }).click();
ok("SoftEther SSTP: no IPsec PSK field", !(await wizard.locator('[data-generated-secret="ipsec_psk"]').count()));

ok("browser console: no errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
await browser.close();
const failed = results.filter(([, passed]) => !passed);
console.log(`\nBUG-FIX BROWSER E2E: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
