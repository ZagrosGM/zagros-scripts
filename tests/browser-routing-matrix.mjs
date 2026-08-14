// Real deployed-panel routing/settings gate. No route mocks or fake APIs.
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
const target = process.env.ROUTING_TARGET || "wireguard-31434";
if (!panel || !user || !pass) throw new Error("PANEL_URL/PANEL_USER/PANEL_PASS required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
let originalRules = null;

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

try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

  originalRules = await api("/zagros/routing/rules");

  // SoftEther client families are visible but disabled, never silently absent.
  await page.goto(panel + "#/outbounds", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /outbound/i }).last().click();
  let dialog = page.getByRole("dialog");
  const protocol = dialog.locator("select").first();
  await protocol.waitFor();
  const options = await protocol.locator("option").evaluateAll((rows) => rows.map((row) => ({ value: row.value, disabled: row.disabled })));
  for (const kind of ["softether_l2tp", "softether_l2tp_raw", "softether_sstp", "softether_pptp", "softether_native"]) {
    const option = options.find((row) => row.value === kind);
    if (!option || !option.disabled) throw new Error(`${kind} must be visible + disabled`);
  }
  await dialog.getByRole("button", { name: /cancel/i }).click();

  // Create → deploy → edit → disable/enable → reload. The real backend owns it.
  await page.goto(panel + "#/routing", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /rule/i }).last().click();
  dialog = page.getByRole("dialog");
  await dialog.locator('input[placeholder="iran-via-warp"]').fill("browser-matrix-rule");
  await dialog.locator('input[placeholder="reality-in"]').fill("wireguard-59129");
  await dialog.locator('input[placeholder="reality-in"]').press("Enter");
  await dialog.locator("label").filter({ hasText: /^action/ }).locator("select").selectOption("route_to");
  await dialog.locator("label").filter({ hasText: /target outbound/ }).locator("select").selectOption(target);
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await page.getByText("browser-matrix-rule", { exact: true }).waitFor();
  await page.getByRole("button", { name: /deploy/i }).click();
  await page.getByText(/deployed to all routing-capable cores/i).waitFor({ timeout: 30000 });

  const card = page.locator(".card").filter({ hasText: "browser-matrix-rule" });
  await card.getByRole("button", { name: /^edit$/i }).click();
  dialog = page.getByRole("dialog");
  const priority = dialog.locator('input[type="number"]');
  await priority.fill("20");
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await page.getByRole("button", { name: /deploy/i }).click();
  await page.getByText(/deployed to all routing-capable cores/i).waitFor({ timeout: 30000 });
  const toggle = card.locator('button[role="switch"]');
  await toggle.click();
  await page.getByRole("button", { name: /save/i }).click();
  await toggle.click();
  await page.getByRole("button", { name: /deploy/i }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("browser-matrix-rule", { exact: true }).waitFor();

  // Settings → Panel Network test is real and non-mutating.
  await page.goto(panel + "#/settings", { waitUntil: "networkidle" });
  await page.getByText("Panel Network", { exact: true }).waitFor();
  await page.getByRole("button", { name: /test configuration/i }).click();
  await page.getByText(/panel network configuration is valid/i).waitFor({ timeout: 15000 });

  // Subscription URL generation uses the same backend schema/base URL.
  await page.goto(panel + "#/subscriptions", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /test configuration/i }).click();
  await page.getByText(/URL generation is valid/i).waitFor({ timeout: 15000 });
  await page.getByText(/"ok": true/).waitFor();

  if (errors.length) throw new Error(`browser errors: ${errors.slice(0, 5).join(" | ")}`);
  console.log("BROWSER ROUTING MATRIX UI: PASS");
} finally {
  if (originalRules) {
    try {
      await api("/zagros/routing/deploy", { method: "POST", body: JSON.stringify({ rules: originalRules.rules }) });
    } catch (error) {
      console.error("failed to restore original rules", error);
    }
  }
  await browser.close();
}
