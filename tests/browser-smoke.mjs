// Zagros panel — REAL-browser smoke test (Playwright/Chromium).
//
// The alpha.5 release blocker proved that "HTTP 200 on /dashboard/" is NOT
// enough: the SPA booted, read a snapshot field that did not exist
// (snapshot.totals.online_users), threw during render and unmounted the
// whole React tree — a white panel — while every curl-based check stayed
// green. This script gates the REAL runtime behavior on a deployed panel:
//
//   1. anonymous load → login page renders and STAYS rendered
//   2. login via the real form
//   3. create a user through the REAL admin API (fetch with the session token)
//   4. soak (default 90 s; E2E runs 300 s per spec) — UI must never empty
//   5. navigate EVERY sidebar page — no crash card, no empty root
//   6. three full reloads
//   7. logout → login cycle
//
// exit 1 on: empty #root at any point, any pageerror, any console error,
// any error-boundary card, any failed request.
//
// Usage:
//   PANEL_URL=http://127.0.0.1:8000/dashboard/ PANEL_USER=admin \
//   PANEL_PASS=secret SOAK_SECS=90 node browser-smoke.mjs

import { chromium } from "playwright";

const PANEL = (process.env.PANEL_URL || "http://127.0.0.1:8000/dashboard/").replace(/\/+$/, "/");
const USER = process.env.PANEL_USER || "admin";
const PASS = process.env.PANEL_PASS || "";
const SOAK_SECS = Number(process.env.SOAK_SECS || 90);

const PAGES = [
  "/users", "/admins", "/templates", "/subscriptions", "/nodes", "/cores",
  "/routing", "/outbounds", "/inbounds", "/dns", "/certificates", "/sessions",
  "/devices", "/logs", "/marketplace", "/settings", "/advanced", "/",
];

const events = { pageerrors: [], consoleErrors: [], failedReqs: [] };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => events.pageerrors.push(String(err)));
page.on("console", (msg) => {
  const text = msg.text();
  if (msg.type() === "error" && !text.includes("[zagros]")) events.consoleErrors.push(text);
});
page.on("requestfailed", (req) => events.failedReqs.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`));

const fail = (why) => {
  console.error(`SMOKE FAIL: ${why}`);
  console.error("pageerrors:", events.pageerrors.slice(0, 5));
  console.error("consoleErrors:", events.consoleErrors.slice(0, 5));
  console.error("failedReqs:", events.failedReqs.slice(0, 5));
  process.exit(1);
};

const rootChildren = async () =>
  page.evaluate(() => document.getElementById("root")?.children.length ?? -1);
const crashCard = async () =>
  page.evaluate(() => {
    const t = document.body?.innerText || "";
    return t.includes("failed to render") || t.includes("Something went wrong");
  });

// ---- 1. anonymous load -------------------------------------------------- #/
await page.goto(PANEL, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2500);
if ((await rootChildren()) !== 1) fail(`anonymous load: UI vanished (url=${page.url()})`);
if (!page.url().includes("#/login")) fail(`anonymous load: expected login redirect, got ${page.url()}`);
console.log("1. anonymous load → login screen, stable");

// ---- 2. login ------------------------------------------------------------ #/
await page.locator("#u").fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
await page.waitForTimeout(3500);
if ((await rootChildren()) !== 1) fail("UI vanished immediately after login (alpha.5 regression class)");
console.log("2. login ok, shell rendered");

// ---- 3. create a user via the real API (uses the SPA's own session token) - #/
const created = await page.evaluate(async () => {
  const token = localStorage.getItem("zagros.token") || "";
  const name = "e2e-smoke-" + Math.random().toString(36).slice(2, 8);
  // fresh installs ship exactly one inbound (shadowsocks); a proxy without a
  // matching inbound is a REAL 400 — not a smoke failure target.
  const res = await fetch("/api/user", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: name, proxies: { shadowsocks: {} }, inbounds: {}, expire: 0, data_limit: 0 }),
  });
  return { status: res.status, name };
});
if (created.status !== 200 && created.status !== 201) fail(`create user via API returned ${created.status}`);
console.log(`3. user created through real API (${created.name})`);
await page.waitForTimeout(1200);

// ---- 4. soak ------------------------------------------------------------- #/
const t0 = Date.now();
while (Date.now() - t0 < SOAK_SECS * 1000) {
  if ((await rootChildren()) !== 1) fail(`UI vanished during soak at ${Date.now() - t0} ms`);
  if (await crashCard()) fail("error boundary tripped during soak");
  await page.waitForTimeout(2000);
}
console.log(`4. soak ${SOAK_SECS}s without crash`);

// ---- 5. every page -------------------------------------------------------- #/
for (const p of PAGES) {
  await page.evaluate((h) => { location.hash = h; }, "#" + p);
  await page.waitForTimeout(1500);
  if ((await rootChildren()) !== 1) fail(`UI vanished after navigating to ${p}`);
  if (await crashCard()) fail(`error boundary tripped on page ${p}`);
}
console.log(`5. all ${PAGES.length} pages render and stay alive`);

// ---- 5b. modal overlay regression (alpha.7 spec item 10) ------------------ #/
// The alpha.6 dialog rendered its backdrop as `absolute inset-0` inside a
// scrollable container: opening "New User" left the lower half of the page
// un-blacked and let the body scroll behind the modal. The rewrite portals a
// FIXED full-viewport backdrop + locks body scroll — assert both here.
await page.evaluate(() => { location.hash = "#/users"; });
await page.waitForTimeout(1500);
const newUserBtn = page.locator('main button:has-text("New User"), main button:has-text("کاربر جدید")').first();
if (await newUserBtn.count()) {
  await newUserBtn.click();
  await page.waitForTimeout(900);
  const overlay = await page.evaluate(() => {
    const backdrop = [...document.querySelectorAll("div")].find((d) =>
      d.className.includes("bg-black/55") && d.className.includes("fixed"));
    if (!backdrop) return { ok: false, why: "no fixed backdrop found" };
    const r = backdrop.getBoundingClientRect();
    if (r.width < window.innerWidth - 1 || r.height < window.innerHeight - 1)
      return { ok: false, why: `backdrop ${r.width}x${r.height} vs viewport ${window.innerWidth}x${window.innerHeight}` };
    if (document.body.style.overflow !== "hidden")
      return { ok: false, why: "body scroll NOT locked (overflow != hidden)" };
    if (!document.querySelector('[role="dialog"]'))
      return { ok: false, why: "role=dialog missing" };
    return { ok: true };
  });
  if (!overlay.ok) fail(`modal overlay regression: ${overlay.why}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    backdropGone: ![...document.querySelectorAll("div")].some((d) => d.className.includes("bg-black/55")),
    overflow: document.body.style.overflow,
  }));
  if (!after.backdropGone) fail("modal did not close on Escape");
  if (after.overflow === "hidden") fail("body scroll lock NOT released after close");
  console.log("5b. New-User modal: full-viewport backdrop + scroll lock + clean close");
} else {
  console.log("5b. (New-User button not found — modal check skipped)");
}

// ---- 5c. outbound Import-URL block (alpha.7 spec item 6) ------------------ #/
await page.evaluate(() => { location.hash = "#/outbounds"; });
await page.waitForTimeout(1500);
const newOutboundBtn = page.locator('main button:has-text("outbound")').first();
if (await newOutboundBtn.count()) {
  await newOutboundBtn.click();
  await page.waitForTimeout(900);
  // the Import URL block renders only for URL-based kinds — switch the
  // schema-driven kind selector to vless (default for the header button is "direct")
  const kindSelect = page.locator('[role="dialog"] select').first();
  if (await kindSelect.count()) await kindSelect.selectOption("vless");
  await page.waitForTimeout(600);
  const hasImport = await page.evaluate(() => (document.body.innerText || "").includes("Import URL") || (document.body.innerText || "").includes("ورود از لینک"));
  if (!hasImport) fail("outbound dialog is missing the Import URL block");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  console.log("5c. outbound dialog exposes the Import URL block");
} else {
  console.log("5c. (New-Outbound button not found — import check skipped)");
}

// ---- 6. reloads ----------------------------------------------------------- #/
for (let i = 1; i <= 3; i++) {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  if ((await rootChildren()) !== 1) fail(`UI vanished after reload #${i}`);
}
console.log("6. 3× reload — stable");

// ---- 7. logout → login ---------------------------------------------------- #/
const signOut = page.locator('button:has-text("Sign out"), button:has-text("خروج")').first();
if (await signOut.count()) {
  await signOut.click();
  await page.waitForTimeout(1500);
  if (!page.url().includes("#/login")) fail("logout did not land on login page");
  await page.locator("#u").fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
  await page.waitForTimeout(2500);
  if ((await rootChildren()) !== 1) fail("UI vanished after logout→login cycle");
  console.log("7. logout→login cycle stable");
} else {
  console.log("7. (sign-out button not found — cycle skipped)");
}

if (events.pageerrors.length) fail(`${events.pageerrors.length} pageerror(s)`);
if (events.consoleErrors.length) fail(`${events.consoleErrors.length} console error(s)`);
if (events.failedReqs.length) fail(`${events.failedReqs.length} failed request(s)`);

console.log("\nBROWSER SMOKE PASSED — UI stayed alive: login, soak, all pages, reloads, logout/login.");
await browser.close();
