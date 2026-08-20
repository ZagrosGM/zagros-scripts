// Real deployed-panel PPTP gate. No route/API mocks.
import { chromium } from "playwright";
import fs from "node:fs";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
let user = process.env.PANEL_USER || "";
let pass = process.env.PANEL_PASS || "";
if (process.env.PANEL_CREDENTIAL_FILE) {
  const protectedCredentials = JSON.parse(fs.readFileSync(process.env.PANEL_CREDENTIAL_FILE, "utf8"));
  user = protectedCredentials.username || "";
  pass = protectedCredentials.password || "";
}
if (!panel || !user || !pass) throw new Error("PANEL_URL/PANEL_USER/PANEL_PASS required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

  await page.goto(panel + "#/cores", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^Cores$/i }).waitFor();
  const existing = page.locator(".card").filter({ hasText: /pptp/i }).first();
  let alreadyInstalled = true;
  try { await existing.waitFor({ timeout: 10000 }); }
  catch { alreadyInstalled = false; }
  if (!alreadyInstalled) {
    await page.getByRole("tab", { name: /catalog/i }).click();
    const card = page.locator(".card").filter({ hasText: /Independent PPTP Server/i });
    await card.waitFor();
    assert((await card.innerText()).includes("Legacy / Insecure"), "catalog lacks legacy warning");
    await card.getByRole("button", { name: /install/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Legacy / Insecure", { exact: true }).waitFor();
    const checks = dialog.locator('input[type="checkbox"]');
    assert(await checks.count() >= 2, "two confirmations are not present");
    const install = dialog.getByRole("button", { name: /^install$/i });
    assert(await install.isDisabled(), "install allowed without confirmations");
    await checks.nth(0).check();
    assert(await install.isDisabled(), "install allowed with only one confirmation");
    await checks.nth(1).check();
    assert(!(await install.isDisabled()), "install blocked after both confirmations");
    await install.click();
    await page.getByText(/pptp installed \(disabled\)/i).waitFor({ timeout: 120000 });
    await page.getByRole("tab", { name: /^Cores/i }).click();
  }

  await page.goto(panel + "#/cores", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^Cores$/i }).waitFor();
  const installed = page.locator(".card").filter({ hasText: /pptp/i }).first();
  await installed.waitFor();
  const installedText = await installed.innerText();
  assert(installedText.includes("Legacy / Insecure"), "installed core lacks warning");
  assert(["installed", "stopped", "running"].some((state) => installedText.toLowerCase().includes(state)), "provider state missing");
  const enabledSwitch = installed.getByRole("switch", { name: "enabled" });
  if (!alreadyInstalled && await enabledSwitch.count())
    assert((await enabledSwitch.getAttribute("aria-checked")) === "false", "PPTP did not remain disabled after install");

  await page.goto(panel + "#/inbounds", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Inbounds/i }).waitFor();
  await page.locator("select").first().selectOption("pptp");
  await page.waitForTimeout(1500);
  if ((await page.locator(".card").filter({ hasText: "pptp-browser" }).count()) === 0) {
    await page.getByRole("button", { name: /add inbound/i }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /PPTP — Legacy \/ Insecure/i }).click();
    await dialog.getByRole("button", { name: /continue/i }).click();
    await dialog.getByRole("button", { name: /TCP\/1723 control/i }).click();
    await dialog.getByRole("button", { name: /continue/i }).click();
    await dialog.getByRole("button", { name: /^None$/i }).click();
    await dialog.getByRole("button", { name: /continue/i }).click();
    await dialog.locator('input[placeholder^="pptp"]').first().fill("pptp-browser").catch(() => {});
    const port = dialog.locator('input[type="number"][value="1723"]');
    assert(await port.count() === 1 && await port.isDisabled(), "TCP/1723 is not fixed");
    const selects = dialog.locator("select");
    const options = await selects.evaluateAll((nodes) => nodes.flatMap((node) => [...node.options].map((option) => option.text)));
    for (const forbidden of ["PAP", "CHAP-MD5", "MS-CHAPv1", "MPPE40", "IPv6"])
      assert(!options.includes(forbidden), `forbidden wizard option visible: ${forbidden}`);
    for (const label of [
      "I accept that PPTP is Legacy / Insecure",
      "I explicitly allow Internet exposure on TCP/1723 and GRE/47",
    ]) {
      const field = dialog.locator("label").filter({ hasText: label }).locator("select");
      await field.selectOption("true");
    }
    await dialog.getByRole("button", { name: /create inbound/i }).click();
    await page.getByText(/created on pptp|saved on pptp/i).waitFor({ timeout: 60000 });
  }

  // Enabling and starting are separate from installation. The server-side
  // confirmations persisted at install/inbound time are validated again.
  await page.goto(panel + "#/cores", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /^Cores$/i }).waitFor();
  const pptpCard = page.locator(".card").filter({ hasText: /pptp/i }).first();
  await pptpCard.waitFor();
  const liveSwitch = pptpCard.getByRole("switch", { name: "enabled" });
  if ((await liveSwitch.getAttribute("aria-checked")) === "false") {
    await liveSwitch.click();
    await page.getByText(/pptp: enable/i).waitFor({ timeout: 30000 });
  }
  const startButton = pptpCard.getByRole("button", { name: /^start$/i });
  if (await startButton.count()) {
    await startButton.click();
    await page.getByText(/pptp: start/i).waitFor({ timeout: 60000 });
  }

  await page.goto(panel + "#/routing", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Routing/i }).waitFor();
  await page.getByRole("button", { name: /^rule$/i }).click();
  const routing = page.getByRole("dialog").getByTestId("inbound-tag-selector");
  await routing.waitFor();
  assert(await routing.locator('input[data-inbound-tag="pptp-browser"]').count() === 1,
    "live routing inventory does not see PPTP inbound");
  assert((await routing.innerText()).includes("inventory only"), "routing UI implies unsupported behavior");
  await page.getByRole("dialog").getByRole("button", { name: /cancel/i }).click();

  await page.goto(panel + "#/capabilities", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Capabilities/i }).waitFor();
  await page.getByText("Independent provider capabilities", { exact: true }).waitFor({ timeout: 30000 });
  const text = await page.locator("main").innerText();
  assert(text.includes("Independent provider capabilities"), "independent provider capability missing");
  assert(text.includes("Legacy / Insecure") && text.includes("accel-ppp"), "PPTP identity missing");
  assert(text.includes("SoftEther transport capabilities"), "SoftEther matrix missing");
  assert(errors.length === 0, `browser errors: ${errors.slice(0, 5).join(" | ")}`);
  console.log("PPTP BROWSER: PASS — independent legacy provider, dual confirmation, fixed wizard, live inventory");
} finally {
  await browser.close();
}
