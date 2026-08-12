// Real deployed-panel gate for alpha.8.1 runtime/UI blockers (no route mocks).
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
const wgFile = process.env.WG_FILE || "";
const l2tpTag = process.env.SOFT_L2TP_TAG || "";
const sstpTag = process.env.SOFT_SSTP_TAG || "";
const sstpPort = String(process.env.SOFT_SSTP_PORT || "");
const wgPort = String(process.env.WG_PORT || "");
if (!panel || !user || !pass || !wgFile || !l2tpTag || !sstpTag || !sstpPort || !wgPort)
  throw new Error("PANEL_URL/PANEL_USER/PANEL_PASS/WG_FILE/SOFT_L2TP_TAG/SOFT_SSTP_TAG/SOFT_SSTP_PORT/WG_PORT required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const check = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

  await page.goto(panel + "#/inbounds", { waitUntil: "networkidle" });
  await page.locator("main label").filter({ hasText: "core" }).locator("select").selectOption("softether");
  await page.getByText(l2tpTag, { exact: true }).waitFor();
  await page.getByRole("button", { name: `edit ${l2tpTag}` }).click();
  let dialog = page.getByRole("dialog");
  let portLabel = dialog.locator("label").filter({ hasText: /^port/ });
  let port = portLabel.locator("input");
  check(await port.inputValue() === "1701", "L2TP port not normalized to 1701");
  check(await port.isDisabled(), "L2TP fixed port remains editable");
  check((await portLabel.innerText()).includes("not configurable"), "fixed-port explanation missing");
  await dialog.getByRole("button", { name: /cancel/i }).click();

  await page.getByRole("button", { name: `edit ${sstpTag}` }).click();
  dialog = page.getByRole("dialog");
  portLabel = dialog.locator("label").filter({ hasText: /^port/ });
  port = portLabel.locator("input");
  check(await port.inputValue() === sstpPort, "SSTP custom port lost");
  check(!(await port.isDisabled()), "SSTP custom port incorrectly fixed");
  await dialog.getByRole("button", { name: /cancel/i }).click();

  await page.goto(panel + "#/outbounds", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /outbound/i }).last().click();
  dialog = page.getByRole("dialog");
  await dialog.locator("label").filter({ hasText: "protocol" }).locator("select").selectOption("wireguard");
  const upload = dialog.locator('input[type="file"][accept=".conf,.txt"]');
  check(await upload.count() === 1, "WireGuard .conf upload control missing");
  await upload.setInputFiles(wgFile);
  await dialog.getByText(/imported .*review the endpoint/i).waitFor({ timeout: 15000 });
  check((await dialog.getByRole("textbox", { name: /^name/ }).inputValue()).includes(wgPort), "import name hint missing");
  const values = await dialog.locator("input").evaluateAll((inputs) => inputs.map((input) => input.value));
  check(values.includes(wgPort), "WireGuard Endpoint port was not imported");
  await dialog.getByRole("button", { name: /save/i }).click();
  await page.getByRole("button", { name: /test/i }).last().click();
  await page.getByText(/healthy ·/i).waitFor({ timeout: 15000 });
  check(!(await page.locator("main").innerText()).includes("ConnectionRefused"), "UDP Test still used TCP");
  check(errors.length === 0, `browser errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log("UI BLOCKERS BROWSER: PASS — fixed L2TP, custom SSTP, WireGuard upload and UDP Test");
} finally {
  await browser.close();
}
