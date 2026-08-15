// Real P0 blocker browser gate against a deployed Zagros VPS (no route mocks).
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
// The original fixture hard-coded a disposable `p0user` and its one-off
// inbound names, so the real-runtime gate became unusable immediately after
// that fixture was cleaned up. Keep historical defaults, but let each isolated
// runtime name the real user/inbounds/protocols it actually provisioned.
const runtimeUser = process.env.RUNTIME_USER || "p0user";
const expectedInbounds = (process.env.EXPECTED_INBOUNDS || "sb-vless-p0,sb-hy2-p0,sb-tuic-p0,ovpn-p0,wireguard").split(",").filter(Boolean);
const expectedProtocols = (process.env.EXPECTED_PROTOCOLS || "hysteria2,tuic,OpenVPN,WireGuard,VLESS").split(",").filter(Boolean);
// A real subscription listener may intentionally be firewall-restricted. The
// optional origin is a secured test tunnel only; its path and live token still
// come from the server-returned canonical subscription URL.
const subscriptionOrigin = process.env.SUBSCRIPTION_ORIGIN || "";
if (!panel || !user || !pass) throw new Error("PANEL_URL/PANEL_USER/PANEL_PASS required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === "1",
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const check = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

  const result = await page.evaluate(async ({ runtimeUser, subscriptionOrigin }) => {
    const token = localStorage.getItem("zagros.token") || "";
    const headers = { Authorization: `Bearer ${token}` };
    const [coresRes, catalogRes, userRes] = await Promise.all([
      fetch("/api/zagros/cores", { headers }),
      fetch("/api/zagros/inbounds", { headers }),
      fetch(`/api/user/${encodeURIComponent(runtimeUser)}`, { headers }),
    ]);
    const cores = await coresRes.json();
    const catalog = await catalogRes.json();
    const account = await userRes.json();
    const canonicalSubUrl = new URL(account.subscription_url);
    const subUrl = subscriptionOrigin
      ? new URL(canonicalSubUrl.pathname.replace(/^\/+/, "") + canonicalSubUrl.search,
          subscriptionOrigin.endsWith("/") ? subscriptionOrigin : subscriptionOrigin + "/").toString()
      : canonicalSubUrl.toString();
    const subRes = await fetch(subUrl, {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
    });
    return {
      statuses: [coresRes.status, catalogRes.status, userRes.status, subRes.status],
      cores: cores.cores,
      groups: catalog.groups,
      subscription: await subRes.text(),
    };
  }, { runtimeUser, subscriptionOrigin });

  check(result.statuses.every((s) => s === 200), `API/sub statuses ${result.statuses}`);
  const byCore = Object.fromEntries(result.cores.map((c) => [c.id, c]));
  for (const id of ["sing-box", "openvpn", "wireguard", "xray"])
    check(byCore[id]?.state === "running", `${id} is not running: ${JSON.stringify(byCore[id])}`);

  const tags = new Set(result.groups.flatMap((g) => (g.inbounds || []).map((i) => i.tag)));
  for (const tag of expectedInbounds)
    check(tags.has(tag), `missing live inbound ${tag}`);
  check(!/Temporarily unavailable/i.test(result.subscription), "subscription contains unavailable");
  for (const protocol of expectedProtocols)
    check(new RegExp(protocol, "i").test(result.subscription), `subscription missing ${protocol}`);

  await page.goto(panel + "#/cores", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const coreText = await page.locator("main").innerText();
  check(/sing-?box/i.test(coreText) && /wireguard/i.test(coreText) && /openvpn/i.test(coreText),
        `Cores UI missing managed cores: ${coreText.slice(0, 500)}`);
  check(errors.length === 0, `browser errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log("P0 BROWSER RUNTIME: PASS — live cores, inbounds and old subscription are healthy");
} finally {
  await browser.close();
}
