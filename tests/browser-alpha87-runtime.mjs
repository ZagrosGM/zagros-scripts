// alpha.8.7 real deployed-panel browser gate: backend-fed inbound inventory,
// persisted multi-select routing, strict backend identity checks, and native
// SoftEther capability honesty. No API, route, or capability mocks.
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
if (!panel || !user || !pass) throw new Error("PANEL_URL/PANEL_USER/PANEL_PASS required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1500, height: 1100 },
  ignoreHTTPSErrors: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let originalRules = null;

async function api(path, init = {}, expected = 200) {
  return page.evaluate(async ({ path, init, expected }) => {
    const token = localStorage.getItem("zagros.token") || "";
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    if (response.status !== expected)
      throw new Error(`${path}: expected ${expected}, got ${response.status} ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }, { path, init, expected });
}

function field(dialog, label) {
  const xpath = `.//label[span[normalize-space(string(.))="${label}" or normalize-space(string(.))="${label}*"]]`;
  return dialog.locator(`xpath=${xpath}`).locator("input,textarea,select").first();
}

try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

  originalRules = await api("/zagros/routing/rules");
  const sources = await api("/zagros/routing/sources");
  const sourceRows = sources.groups.flatMap((group) =>
    group.inbounds.map((inbound) => ({ ...inbound, core: group.core_id })));
  const wanted = ["a87-xray-socks", "a87-sb-socks"];
  for (const tag of wanted) assert(sourceRows.some((row) => row.tag === tag), `live source missing: ${tag}`);

  // Capability/API facts: native is the only enabled SoftEther client family,
  // uses the real vpnclient policy dataplane, and exposes exact accounting.
  const matrix = await api("/zagros/cores/capability-matrix");
  const native = matrix.softether_transports.native.client;
  assert(native.state === "supported", `native client state=${native.state}`);
  assert(native.canonical_outbound_kind === "softether_native", "wrong native canonical kind");
  assert(native.tun === true && native.accounting === true, "native TUN/accounting facts missing");
  for (const transport of ["l2tp_ipsec", "l2tp_raw", "sstp", "pptp"])
    assert(matrix.softether_transports[transport].client.state === "unsupported",
      `${transport} fabricated a client provider`);
  const openvpn = matrix.softether_transports.openvpn.client;
  assert(openvpn.canonical_outbound_kind === "openvpn" && openvpn.tun === true,
    "OpenVPN compatibility did not map to the standard OpenVPN client");

  await page.goto(panel + "#/outbounds", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^outbound$/i }).click();
  let dialog = page.getByRole("dialog");
  const protocol = field(dialog, "protocol");
  await protocol.locator('option[value="softether_native"]').waitFor({ state: "attached", timeout: 15000 });
  const options = await protocol.locator("option").evaluateAll((rows) =>
    rows.map((row) => ({ value: row.value, disabled: row.disabled })));
  const nativeOption = options.find((row) => row.value === "softether_native");
  assert(nativeOption && !nativeOption.disabled,
    `native SoftEther UI option is not enabled: ${JSON.stringify(options.filter((row) => row.value.includes("softether")))}`);
  for (const kind of ["softether_l2tp", "softether_l2tp_raw", "softether_sstp", "softether_pptp"])
    assert(options.some((row) => row.value === kind && row.disabled), `${kind} not visible + disabled`);
  await dialog.getByRole("button", { name: /^cancel$/i }).click();

  // The rule editor must use the backend inventory as checkboxes, never the
  // removed free-form/chip input. Select two cores, save, deploy, reload, edit.
  await page.goto(panel + "#/routing", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^rule$/i }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator('input[placeholder="iran-via-warp"]').fill("a87-browser-multiselect");
  const selector = dialog.getByTestId("inbound-tag-selector");
  await selector.waitFor();
  assert(await dialog.locator('input[placeholder="reality-in"]').count() === 0,
    "free-form inbound-tag editor still exists");
  const checks = selector.locator('input[type="checkbox"][data-inbound-tag]');
  assert(await checks.count() === sourceRows.length,
    `checkbox inventory mismatch UI=${await checks.count()} API=${sourceRows.length}`);
  for (const tag of wanted) await selector.locator(`input[data-inbound-tag="${tag}"]`).check();
  const summary = await dialog.getByTestId("selected-inbound-tags").innerText();
  for (const tag of wanted) assert(summary.includes(tag), `selection summary lost ${tag}`);
  await field(dialog, "network").selectOption("tcp");
  await field(dialog, "action").selectOption("route_to");
  await field(dialog, "target outbound").selectOption("a87-target-softether");
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await page.getByText("a87-browser-multiselect", { exact: true }).waitFor();
  await page.getByRole("button", { name: /deploy/i }).click();
  await page.getByText(/deployed to all routing-capable cores/i).waitFor({ timeout: 60000 });

  const persisted = await api("/zagros/routing/rules");
  const saved = persisted.rules.find((rule) => rule.name === "a87-browser-multiselect");
  assert(saved, "browser-saved rule missing from backend");
  assert(JSON.stringify(saved.matcher.inbounds) === JSON.stringify(wanted),
    `backend selection mismatch: ${JSON.stringify(saved.matcher.inbounds)}`);

  await page.reload({ waitUntil: "networkidle" });
  const card = page.locator(".card").filter({ hasText: "a87-browser-multiselect" });
  await card.getByRole("button", { name: /^edit$/i }).click();
  dialog = page.getByRole("dialog");
  for (const tag of wanted)
    assert(await dialog.locator(`input[data-inbound-tag="${tag}"]`).isChecked(),
      `edit/reload did not persist ${tag}`);
  await dialog.getByRole("button", { name: /^cancel$/i }).click();

  // Backend does not trust the UI: duplicate and deleted tags fail closed and
  // leave the deployed rule untouched.
  const duplicate = structuredClone(saved);
  duplicate.name = "a87-browser-duplicate";
  duplicate.matcher.inbounds = [wanted[0], wanted[0]];
  await api("/zagros/routing/rules", {
    method: "PUT", body: JSON.stringify({ rules: [duplicate] }),
  }, 422);
  const unknown = structuredClone(saved);
  unknown.name = "a87-browser-unknown";
  unknown.matcher.inbounds = ["a87-deleted-inbound"];
  await api("/zagros/routing/rules", {
    method: "PUT", body: JSON.stringify({ rules: [unknown] }),
  }, 422);
  const afterReject = await api("/zagros/routing/rules");
  assert(afterReject.rules.some((rule) => rule.name === "a87-browser-multiselect"),
    "rejected payload mutated persisted rules");

  await page.goto(panel + "#/capabilities", { waitUntil: "networkidle" });
  await page.getByText("SoftEther transport capabilities", { exact: true }).waitFor({ timeout: 30000 });
  const text = await page.locator("main").innerText();
  assert(text.includes("native") && text.includes("vpnclient"), "native capability evidence not rendered");
  const unexpectedErrors = errors.filter((error) =>
    !error.includes("422 (Unprocessable Entity)"));
  assert(unexpectedErrors.length === 0,
    `browser errors: ${unexpectedErrors.slice(0, 5).join(" | ")}`);
  console.log("ALPHA.8.7 BROWSER: PASS — native SoftEther + backend-fed persisted inbound multi-select");
} finally {
  if (originalRules) {
    try {
      await api("/zagros/routing/deploy", {
        method: "POST", body: JSON.stringify({ rules: originalRules.rules }),
      });
    } catch (error) {
      console.error("alpha.8.7 browser cleanup failed", error);
      process.exitCode = 1;
    }
  }
  await browser.close();
}
