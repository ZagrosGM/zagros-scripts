// Alpha 8.4 real deployed-panel regressions: no API mocks.
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
const sshOutbound = process.env.SSH_OUTBOUND || "";
const tunOutbound = process.env.TUN_OUTBOUND || "";
const appSource = process.env.APP_SOURCE || "";
const serviceSource = process.env.SERVICE_SOURCE || "";
const hostTag = process.env.XRAY_HOST_TAG || "";
if (![panel, user, pass, sshOutbound, tunOutbound, appSource, serviceSource, hostTag].every(Boolean))
  throw new Error("alpha84 runtime browser environment is incomplete");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1500, height: 1050 },
  ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === "1",
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

async function api(path, init = {}) {
  return page.evaluate(async ({ path, init }) => {
    const token = localStorage.getItem("zagros.token") || "";
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }, { path, init });
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };
let originalHosts = null;
try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

  const inventory = await api("/zagros/routing/targets");
  const sshTarget = inventory.targets.find((row) => row.name === sshOutbound);
  assert(sshTarget, "SSH outbound absent from routing target inventory");
  assert(sshTarget.contexts.includes("native_application_tcp"), "SSH missing native TCP context");
  assert(!sshTarget.contexts.includes("policy_tun"), "SSH falsely claims policy TUN");

  await page.goto(panel + "#/routing", { waitUntil: "networkidle" });
  const routingText = await page.locator("main").innerText();
  assert(!routingText.includes("SoftEther architecture: L2TP"), "obsolete SoftEther banner remains");
  assert(!routingText.includes("Application-only outbounds are excluded"), "obsolete SSH banner remains");
  if (routingText.includes("Hbh")) {
    assert(routingText.includes("priority 10"), "persisted Hbh rule priority is unexplained");
    assert(!routingText.includes("#10"), "legacy #10 priority label remains");
  }

  await page.getByRole("button", { name: /^rule$/i }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator('input[placeholder="iran-via-warp"]').fill("alpha84-context-check");
  const inboundInput = dialog.locator('input[placeholder="reality-in"]');
  await inboundInput.fill(appSource);
  await inboundInput.press("Enter");
  await dialog.locator("label").filter({ hasText: /^network/ }).locator("select").selectOption("tcp");
  await dialog.locator("label").filter({ hasText: /^action/ }).locator("select").selectOption("route_to");
  const targetSelect = dialog.locator("label").filter({ hasText: /target outbound/ }).locator("select");
  let options = await targetSelect.locator("option").evaluateAll((rows) => rows.map((row) => row.value));
  assert(options.includes(sshOutbound), "SSH missing for native Xray/sing-box TCP context");
  assert(options.includes(tunOutbound), "TUN target missing for native TCP context");

  await dialog.getByRole("button", { name: `remove ${appSource}` }).click();
  await inboundInput.fill(serviceSource);
  await inboundInput.press("Enter");
  options = await targetSelect.locator("option").evaluateAll((rows) => rows.map((row) => row.value));
  assert(!options.includes(sshOutbound), "SSH shown for service-source policy context");
  assert(options.includes(tunOutbound), "TUN target missing for service-source context");
  await dialog.getByRole("button", { name: /^cancel$/i }).click();

  // Exercise the actual Host Settings form serialization, not only direct API.
  originalHosts = await api("/zagros/cores/xray/hosts");
  await page.goto(panel + "#/hosts", { waitUntil: "networkidle" });
  await page.locator('select[aria-label="core"]').selectOption("xray");
  await page.getByText(hostTag, { exact: true }).waitFor({ timeout: 20000 });
  const hostCard = page.locator(".card").filter({ hasText: hostTag });
  if ((originalHosts[hostTag] || []).length === 0)
    await hostCard.getByRole("button", { name: /Add host/i }).click();
  const row = hostCard.locator("div.rounded-xl.border").first();
  const address = row.locator('input[placeholder*="SERVER_IP"]').first();
  if (!(await address.inputValue())) await address.fill("{SERVER_IP}");
  const selects = row.locator("select");
  assert(await selects.count() >= 3, "Xray Host row lacks security/ALPN/fingerprint controls");

  const saveAndRead = async (security, alpn, fingerprint) => {
    await selects.nth(0).selectOption(security);
    await selects.nth(1).selectOption(alpn);
    await selects.nth(2).selectOption(fingerprint);
    const persisted = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && response.url().includes("/api/zagros/cores/xray/hosts"),
    { timeout: 15000 });
    await hostCard.getByRole("button", { name: /^save$/i }).click();
    const response = await persisted;
    assert(response.ok(), `Host Settings save returned ${response.status()}`);
    const hosts = await api("/zagros/cores/xray/hosts");
    const saved = hosts[hostTag][0];
    assert(saved.security === security, `security persisted as ${saved.security}`);
    assert(saved.alpn === alpn, `ALPN persisted as ${saved.alpn}`);
    assert(saved.fingerprint === fingerprint, `fingerprint persisted as ${saved.fingerprint}`);
  };
  await saveAndRead("none", "", "");
  await saveAndRead("tls", "h2", "chrome");
  await saveAndRead("none", "", "");

  assert(errors.length === 0, `browser errors: ${errors.slice(0, 5).join(" | ")}`);
  console.log("ALPHA.8.4 BROWSER RUNTIME: PASS — SSH contexts, warning cleanup, Xray None→TLS→None");
} finally {
  if (originalHosts) {
    try {
      await api("/zagros/cores/xray/hosts", {
        method: "PUT", body: JSON.stringify({ hosts: { [hostTag]: originalHosts[hostTag] || [] } }),
      });
    } catch (error) {
      console.error("failed to restore Xray hosts", error);
    }
  }
  await browser.close();
}
