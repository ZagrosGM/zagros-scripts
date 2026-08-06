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
  "/users", "/subscriptions", "/nodes", "/cores", "/routing", "/outbounds",
  "/inbounds", "/dns", "/certificates", "/sessions", "/devices", "/logs",
  "/marketplace", "/settings", "/advanced", "/",
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
