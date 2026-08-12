// Real alpha.7.9 WireGuard multi-inbound browser gate (no route mocks).
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
const runtimeUser = process.env.RUNTIME_USER || "";
const secondTag = process.env.WG_SECOND_TAG || "";
if (!panel || !user || !pass || !runtimeUser || !secondTag)
  throw new Error("PANEL_URL/PANEL_USER/PANEL_PASS/RUNTIME_USER/WG_SECOND_TAG required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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

  const result = await page.evaluate(async ({ runtimeUser }) => {
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
    const subRes = await fetch(account.subscription_url, {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
    });
    const subscription = await subRes.text();
    const doc = new DOMParser().parseFromString(subscription, "text/html");
    const profiles = [...doc.querySelectorAll('a[download][href^="data:"]')]
      .map((anchor) => {
        const href = anchor.getAttribute("href") || "";
        const comma = href.indexOf(",");
        if (comma < 0 || !href.slice(0, comma).includes(";base64")) return null;
        let text = "";
        try { text = atob(href.slice(comma + 1)); } catch { return null; }
        if (!text.startsWith("[Interface]") || !text.includes("PersistentKeepalive")) return null;
        const field = (name) => text.split("\n")
          .find((line) => line.startsWith(`${name} =`))?.split("=").slice(1).join("=").trim() || "";
        return { filename: anchor.getAttribute("download") || "", address: field("Address"), endpoint: field("Endpoint") };
      })
      .filter(Boolean);
    return {
      statuses: [coresRes.status, catalogRes.status, userRes.status, subRes.status],
      cores: cores.cores,
      groups: catalog.groups,
      profiles,
      unavailable: /Temporarily unavailable/i.test(subscription),
    };
  }, { runtimeUser });

  check(result.statuses.every((status) => status === 200), `API/sub statuses ${result.statuses}`);
  const wireguard = result.cores.find((core) => core.id === "wireguard");
  check(wireguard?.state === "running" && wireguard?.health === "healthy",
        `wireguard unhealthy: ${JSON.stringify(wireguard)}`);
  const tags = new Set(result.groups.flatMap((group) => (group.inbounds || []).map((inbound) => inbound.tag)));
  check(tags.has("wireguard") && tags.has(secondTag), `catalog tags missing: ${[...tags].join(",")}`);
  check(!result.unavailable, "subscription contains unavailable");
  check(result.profiles.length === 2, `expected 2 WireGuard profiles, got ${JSON.stringify(result.profiles)}`);
  check(new Set(result.profiles.map((profile) => profile.filename)).size === 2,
        `download filenames collide: ${JSON.stringify(result.profiles)}`);
  check(new Set(result.profiles.map((profile) => profile.endpoint.split(":").at(-1))).size === 2,
        `endpoints are not independent: ${JSON.stringify(result.profiles)}`);
  check(new Set(result.profiles.map((profile) => profile.address.split(".").slice(0, 2).join("."))).size === 2,
        `profile subnets are not independent: ${JSON.stringify(result.profiles)}`);
  check(errors.length === 0, `browser errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log("WIREGUARD MULTI-INBOUND BROWSER: PASS — two unique live profiles");
} finally {
  await browser.close();
}
