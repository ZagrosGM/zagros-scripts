// alpha.7.5 item-specific REAL-browser checks against the live e2e panel.
// Covers: item 15 (presence dot, no status lamp), item 16 (default host
// remark hint), item 17 (sing-box visible in Host Settings), ACME section
// (Certificates), item 3/port-suggester in the inbound wizard, Cores table.
import { chromium } from "playwright";

const PANEL = (process.env.PANEL_URL || "http://127.0.0.1:8000/dashboard/").replace(/\/+$/, "/");
const USER = process.env.PANEL_USER || "admin";
const PASS = process.env.PANEL_PASS || "";
const results = [];
const ok = (name, cond, extra = "") => {
  results.push([name, !!cond, extra]);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// login
await page.goto(PANEL + "#/login", { waitUntil: "networkidle", timeout: 45000 });
await page.locator('input[id="u"]').fill(USER);
await page.locator('input[type="password"]').fill(PASS);
await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

// ---- item 15: Users page — presence dot, no status lamp
await page.goto(PANEL + "#/users", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const presence = await page.locator('[aria-label^="presence "]').count();
ok("users: presence dot rendered", presence >= 1, `${presence} dot(s)`);
const titles = await page.locator('[aria-label^="presence "]').allInnerTexts().catch(() => []);
const firstTitle = await page.locator('[aria-label^="presence "]').first().getAttribute("title").catch(() => null);
ok("users: presence dot carries an honest title", !!firstTitle && firstTitle.length > 5, firstTitle || "");
const oldLamp = await page.locator('[aria-label^="status "], [title^="account status"]').count();
ok("users: old status lamp removed", oldLamp === 0, `${oldLamp} remnant(s)`);

// ---- item 17 + 16: Hosts page — sing-box visible; default remark hint
await page.goto(PANEL + "#/hosts", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const hostBody = await page.locator("body").innerText();
ok("hosts: sing-box core section visible", /sing-?box/i.test(hostBody));
// sing-box lives behind its OWN core tab — switch to it (item 17: the tab
// itself was missing before the fix)
await page.locator("select").first().selectOption({ value: "sing-box" });
await page.waitForTimeout(1200);
const hostSb = await page.locator("body").innerText();
ok("hosts: created sing-box inbound listed", hostSb.includes("vless-ws-e2e"), hostSb.includes("vless-ws-e2e") ? "" : hostSb.slice(0, 300));
ok("hosts: default remark template hint present (item 16)", hostBody.includes("🛸 Zagros ({USERNAME})"));
ok("hosts: SERVER_IP hint present (item 16)", hostBody.includes("{SERVER_IP}"));

// ---- Certificates: ACME section
await page.goto(PANEL + "#/certificates", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const certBody = await page.locator("body").innerText();
ok("certificates: ACME section rendered", /ACME/.test(certBody));
ok("certificates: ACME honesty (providers or unavailable state)", /certbot|acme\.sh|lego|not available|unavailable|no ACME/i.test(certBody));

// ---- Cores page: sing-box running
await page.goto(PANEL + "#/cores", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const coresBody = await page.locator("body").innerText();
ok("cores: sing-box listed", /sing-?box/i.test(coresBody));
ok("cores: a running state is shown", /running/i.test(coresBody));

// ---- item 3: Inbounds wizard suggests a fresh random port
await page.goto(PANEL + "#/inbounds", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
// pick the sing-box core in the core selector
const coreSelect = page.locator("select").first();
try {
  await coreSelect.selectOption({ value: "sing-box" });
} catch {
  await coreSelect.selectOption({ label: /sing-?box/i });
}
await page.waitForTimeout(800);
await page.locator('button:has-text("add inbound")').first().click();
const wiz = page.locator("text=inbound wizard — sing-box");
await wiz.waitFor({ timeout: 10000 });
// walk the 4 steps: protocol (default vless) → transport ws → security none
// → details, where the suggested port lives
await page.locator('button:has-text("continue")').first().click();
await page.waitForTimeout(400);
const transports = page.locator("button", { hasText: /web\s*socket|\bws\b/i });
if (await transports.count()) await transports.first().click();
await page.locator('button:has-text("continue")').first().click();
await page.waitForTimeout(400);
const secNone = page.locator("button", { hasText: /none|plaintext/i });
if (await secNone.count()) await secNone.first().click();
await page.locator('button:has-text("continue")').first().click();
await page.waitForTimeout(800);
console.log("  [step-check] details visible:", await page.locator("text=details & review").count());
// port must fill from the suggest endpoint (item 3) — wait for a numeric value
let portVal = "";
for (let i = 0; i < 20; i++) {
  portVal = await page.evaluate(() => {
    // Field = <label><span>port*</span><input/>… — the input is INSIDE the label
    const labels = [...document.querySelectorAll("label")];
    const lf = labels.find((l) => /^\s*port\b/i.test(l.textContent || "") && l.querySelector("input"));
    const inp = lf ? lf.querySelector("input") : null;
    return inp && inp.value ? inp.value : "";
  });
  if (portVal) break;
  await page.waitForTimeout(400);
}
const portNum = Number(portVal);
ok("wizard: port auto-suggested (item 3)", Number.isInteger(portNum) && portNum > 1024 && portNum < 65536, `port=${portVal || "EMPTY"}`);
await page.keyboard.press("Escape");

ok("no console errors during item checks", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter(([, c]) => !c);
console.log(`\nALPHA.7.5 E2E: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
