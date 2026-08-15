// Real deployed-panel outbound UI gate. No route or API mocks.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
const testId = process.env.TEST_ID || "runtime-test";
const secretsFile = process.env.SUB_SECRET_FILE || "";
if (!panel || !user || !pass || !secretsFile) throw new Error("runtime browser environment is incomplete");
const shareUrl = JSON.parse(readFileSync(secretsFile, "utf8")).links.ss;
const name = `${testId}-browser-ss`.slice(0, 64);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1500, height: 1050 },
  ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === "1",
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
let original = null;

async function api(path, init = {}) {
  return page.evaluate(async ({ path, init }) => {
    const token = localStorage.getItem("zagros.token") || "";
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 240)}`);
    return text ? JSON.parse(text) : null;
  }, { path, init });
}

try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });
  original = await api("/zagros/outbounds");

  await page.goto(panel + "#/outbounds", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^outbound$/i }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("select").first().selectOption("shadowsocks");
  const importer = dialog.locator("textarea").first();
  await importer.fill(shareUrl);
  await dialog.getByRole("button", { name: /^import$/i }).click();
  await dialog.getByText(/imported/i).waitFor({ timeout: 15000 });
  await dialog.locator('input[placeholder="Warp-EU"]').fill(name);
  await dialog.getByRole("button", { name: /^save$/i }).click();

  const card = page.locator(".card").filter({ hasText: name });
  await card.getByText(name, { exact: true }).waitFor();
  await card.getByRole("button", { name: /^test$/i }).click();
  await card.getByText(/healthy/i).waitFor({ timeout: 15000 });
  await page.locator("main").getByRole("button", { name: /^save$/i }).click();
  await page.getByText(/^saved$/i).waitFor({ timeout: 15000 });
  await page.locator("main").getByRole("button", { name: /^deploy$/i }).click();
  await page.getByText(/deployed to running cores/i).waitFor({ timeout: 60000 });
  const runtime = await api("/zagros/routing/runtime");
  const domain = runtime.domains.find((row) => row.outbound === name);
  if (!domain?.ready || domain.mode !== "proxy") throw new Error("browser-created outbound has no ready runtime domain");

  // Invalid form must be rejected client-side, with zero mutation.
  await page.getByRole("button", { name: /^outbound$/i }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("select").first().selectOption("vless");
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await dialog.getByText(/name: 2–64 chars/i).waitFor();
  await dialog.getByRole("button", { name: /^cancel$/i }).click();

  // Unsupported SoftEther visibility/disabled-state is covered by the real
  // routing browser gate in the same release cycle.
  if (errors.length) throw new Error(`browser errors: ${errors.slice(0, 5).join(" | ")}`);
  console.log(`BROWSER OUTBOUND RUNTIME: PASS (runtime proxy port ${domain.proxy_port})`);
} finally {
  if (original?.outbounds) {
    try {
      await api("/zagros/outbounds/deploy", { method: "POST", body: JSON.stringify({ outbounds: original.outbounds }) });
    } catch (error) {
      console.error("failed to restore original outbounds", error);
    }
  }
  await browser.close();
}
