// Alpha 8.5 real deployed-panel readiness checks. No API mocks.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
const soft = JSON.parse(readFileSync(process.env.SOFT_HUB_FILE || "", "utf8"));
const softTag = soft.inbound_tag;
if (!panel || !user || !pass || !softTag) throw new Error("alpha85 runtime environment is incomplete");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

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

  const [hubs, routingSources, ordinarySources, outbounds, cores] = await Promise.all([
    api("/zagros/cores/softether/policy-hubs"),
    api("/zagros/routing/sources"),
    api("/zagros/inbounds"),
    api("/zagros/outbounds"),
    api("/zagros/cores"),
  ]);
  const managed = hubs.hubs.find((row) => row.inbound_tag === softTag);
  assert(managed?.live, "managed disposable hub is not live");
  assert(managed.hub !== "DEFAULT", "managed source aliases DEFAULT");
  assert(JSON.stringify(routingSources).includes(softTag), "managed hub missing from routing sources");
  assert(!JSON.stringify(ordinarySources).includes(softTag), "routing-only hub leaked into user grants");
  assert(outbounds.outbounds.some((row) => row.name === "a85-sub-ss-xray" && row.settings.policy_core === "xray"), "Xray policy outbound absent");
  assert(outbounds.outbounds.some((row) => row.name === "a85-sub-hy2-singbox"), "sing-box policy outbound absent");
  assert(outbounds.outbounds.some((row) => row.name === "a85-ssh-target"), "SSH application target absent");
  for (const kind of ["softether_l2tp", "softether_l2tp_raw", "softether_sstp", "softether_pptp", "softether_native"])
    assert(outbounds.capabilities[kind]?.state === "unsupported" && outbounds.capabilities[kind]?.selectable === false,
      `${kind} does not remain honestly unsupported`);
  assert(cores.cores.length === 6 && cores.cores.every((row) => row.state === "running" && row.health === "healthy"), "not all six cores are healthy");

  await page.goto(panel + "#/routing", { waitUntil: "networkidle" });
  const routingText = await page.locator("main").innerText();
  assert(!routingText.includes("SoftEther architecture: L2TP"), "obsolete SoftEther warning remains");
  assert(!routingText.includes("Application-only outbounds are excluded"), "obsolete SSH warning remains");
  await page.getByRole("button", { name: /^rule$/i }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator('input[placeholder="iran-via-warp"]').fill("a85-browser-context");
  let inbound = dialog.locator('input[placeholder="reality-in"]');
  await inbound.fill(softTag);
  await inbound.press("Enter");
  await dialog.locator("label").filter({ hasText: /^network/ }).locator("select").selectOption("tcp");
  await dialog.locator("label").filter({ hasText: /^action/ }).locator("select").selectOption("route_to");
  const target = dialog.locator("label").filter({ hasText: /target outbound/ }).locator("select");
  let options = await target.locator("option").evaluateAll((rows) => rows.map((row) => row.value));
  for (const expected of ["a85-sub-ss-xray", "a85-sub-hy2-singbox", "Open", "wireguard-31434"])
    assert(options.includes(expected), `SoftEther source lacks TUN target ${expected}`);
  assert(!options.includes("a85-ssh-target"), "SoftEther source falsely offers application-only SSH target");

  await dialog.getByRole("button", { name: /^cancel$/i }).click();
  await page.getByRole("button", { name: /^rule$/i }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator('input[placeholder="iran-via-warp"]').fill("a85-browser-app-context");
  inbound = dialog.locator('input[placeholder="reality-in"]');
  await inbound.fill("Shadowsocks TCP");
  await inbound.press("Enter");
  await dialog.locator("label").filter({ hasText: /^network/ }).locator("select").selectOption("tcp");
  await dialog.locator("label").filter({ hasText: /^action/ }).locator("select").selectOption("route_to");
  const appTarget = dialog.locator("label").filter({ hasText: /target outbound/ }).locator("select");
  options = await appTarget.locator("option").evaluateAll((rows) => rows.map((row) => row.value));
  assert(options.includes("a85-ssh-target"), "native Xray TCP context lacks SSH target");
  await dialog.getByRole("button", { name: /^cancel$/i }).click();

  await page.goto(panel + "#/outbounds", { waitUntil: "networkidle" });
  await page.getByText("a85-sub-ss-xray", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByText("a85-sub-hy2-singbox", { exact: true }).waitFor({ timeout: 20000 });
  const outboundText = await page.locator("main").innerText();
  assert(outboundText.includes("a85-sub-ss-xray") && outboundText.includes("a85-sub-hy2-singbox"), "runtime outbounds missing in UI");
  await page.getByRole("button", { name: /^outbound$/i }).click();
  const outboundDialog = page.getByRole("dialog");
  const kindSelect = outboundDialog.locator("select").first();
  for (const kind of ["softether_l2tp", "softether_l2tp_raw", "softether_sstp", "softether_pptp", "softether_native"])
    assert(await kindSelect.locator(`option[value="${kind}"]`).evaluate((option) => option.disabled),
      `${kind} is not disabled in the real UI`);
  await outboundDialog.getByRole("button", { name: /^cancel$/i }).click();

  await page.goto(panel + "#/capabilities", { waitUntil: "networkidle" });
  const capabilityText = await page.locator("main").innerText();
  assert(capabilityText.trim().length > 20, "capability matrix rendered empty");

  await page.goto(panel + "#/cores", { waitUntil: "networkidle" });
  const coreText = await page.locator("main").innerText();
  assert(!/snapshot is stale|collector is not active|accounting failed/i.test(coreText), "stale SSH host-agent warning remains");

  for (const route of ["/subscriptions", "/hosts", "/nodes", "/settings"]) {
    await page.goto(panel + `#${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const text = (await page.locator("main").innerText()).trim();
    assert(page.url().includes(`#${route}`) && text.length > 5, `${route} rendered empty or wrong page (len=${text.length}, url=${page.url()}, errors=${errors.slice(-3).join(" | ")})`);
  }
  await page.goto(panel + "#/settings", { waitUntil: "networkidle" });
  assert(await page.getByRole("button", { name: /apply with rollback/i }).count() === 1,
    "Apply with rollback control is absent");

  assert(errors.length === 0, `browser errors: ${errors.slice(0, 5).join(" | ")}`);
  console.log("ALPHA.8.5 BROWSER RUNTIME: PASS — managed SoftEther source, contextual targets, core/subscription/host/node/settings surfaces");
} finally {
  await browser.close();
}
