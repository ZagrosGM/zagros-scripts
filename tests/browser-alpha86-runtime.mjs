// alpha.8.6 regression gate: real panel/API, no route or capability mocks.
import { chromium } from "playwright";

const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
const user = process.env.PANEL_USER || "";
const pass = process.env.PANEL_PASS || "";
const sshHost = process.env.SSH_OUTBOUND_HOST || "127.0.0.1";
const sshPort = process.env.SSH_OUTBOUND_PORT || "22";
const sshUser = process.env.SSH_OUTBOUND_USER || "";
const sshPass = process.env.SSH_OUTBOUND_PASS || "";
const appSource = process.env.APP_SOURCE || "";
const serviceSource = process.env.SERVICE_SOURCE || "";
const name = process.env.SSH_OUTBOUND_NAME || "a86-browser-ssh";
if (!panel || !user || !pass || !sshUser || !sshPass || !appSource || !serviceSource)
  throw new Error("PANEL_URL/PANEL_USER/PANEL_PASS/SSH_OUTBOUND_USER/SSH_OUTBOUND_PASS/APP_SOURCE/SERVICE_SOURCE are required");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let originalOutbounds = null;
let originalRules = null;

async function api(path, init = {}) {
  return page.evaluate(async ({ path, init }) => {
    const token = localStorage.getItem("zagros.token") || "";
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }, { path, init });
}

function field(dialog, label) {
  // Field headings are direct spans; XPath string(.) includes the required
  // asterisk child without being confused by "port" inside "protocol".
  const xpath = `.//label[span[normalize-space(string(.))="${label}" or normalize-space(string(.))="${label}*"]]`;
  return dialog.locator(`xpath=${xpath}`).locator("input,textarea,select").first();
}

try {
  await page.goto(panel + "#/login", { waitUntil: "networkidle", timeout: 45000 });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"), null, { timeout: 20000 });

  originalOutbounds = await api("/zagros/outbounds");
  originalRules = await api("/zagros/routing/rules");
  assert(!originalOutbounds.outbounds.some((row) => row.name === name), `${name} already exists`);

  // Browser create + save of an actual SSH outbound.
  await page.goto(panel + "#/outbounds", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^outbound$/i }).click();
  let dialog = page.getByRole("dialog");
  await field(dialog, "name").fill(name);
  await field(dialog, "protocol").selectOption("ssh");
  await field(dialog, "server / address").fill(sshHost);
  await field(dialog, "port").fill(sshPort);
  await field(dialog, "username").fill(sshUser);
  await field(dialog, "password").fill(sshPass);
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await page.getByText(name, { exact: true }).waitFor();
  await page.getByRole("button", { name: /^save$/i }).click();
  await page.getByText(/saved/i).waitFor({ timeout: 15000 });

  // API inventory must retain structured application-TCP facts.
  const targets = await api("/zagros/routing/targets");
  const ssh = targets.targets.find((row) => row.name === name);
  assert(ssh, "SSH outbound missing from API routing target inventory");
  assert(ssh.state === "supported" && ssh.selectable === true, "SSH target is not supported/selectable");
  assert(ssh.dataplane === "application_tcp", `wrong SSH dataplane: ${ssh.dataplane}`);
  assert(JSON.stringify(ssh.source_cores) === JSON.stringify(["sing-box", "xray"]), "wrong SSH source cores");
  assert(JSON.stringify(ssh.traffic_networks) === JSON.stringify(["tcp"]), "SSH must be payload-TCP only");
  assert(ssh.tun === false && !ssh.contexts.includes("policy_tun"), "SSH was falsely promoted to a TUN");

  // Browser context: Xray/sing-box + any network shows SSH disabled with a
  // useful reason, then explicit TCP makes it selectable.
  await page.goto(panel + "#/routing", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^rule$/i }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator('input[placeholder="iran-via-warp"]').fill("a86-browser-app-rule");
  let source = dialog.locator('input[placeholder="reality-in"]');
  await source.fill(appSource);
  await source.press("Enter");
  await field(dialog, "action").selectOption("route_to");
  let target = field(dialog, "target outbound");
  let option = target.locator(`option[value="${name}"]`);
  assert(await option.count() === 1, "SSH target was hidden from compatible application source discovery");
  const beforeTcp = { disabled: await option.evaluate((node) => node.disabled), text: await option.textContent(), network: await field(dialog, "network").inputValue() };
  assert(beforeTcp.disabled, `SSH target must be disabled while network includes UDP: ${JSON.stringify(beforeTcp)}`);
  assert((beforeTcp.text || "").includes("set network to tcp"), "disabled SSH target has no actionable reason");
  await field(dialog, "network").selectOption("tcp");
  option = target.locator(`option[value="${name}"]`);
  assert(!(await option.evaluate((node) => node.disabled)), "SSH target did not become selectable for native TCP");
  await target.selectOption(name);
  await dialog.getByRole("button", { name: /^save$/i }).click();
  await page.getByText("a86-browser-app-rule", { exact: true }).waitFor();

  // TUN/service source: SSH is not applicable and must not be offered.
  await page.getByRole("button", { name: /^rule$/i }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator('input[placeholder="iran-via-warp"]').fill("a86-browser-service-rule");
  source = dialog.locator('input[placeholder="reality-in"]');
  await source.fill(serviceSource);
  await source.press("Enter");
  await field(dialog, "network").selectOption("tcp");
  await field(dialog, "action").selectOption("route_to");
  target = field(dialog, "target outbound");
  assert(await target.locator(`option[value="${name}"]`).count() === 0,
    "TUN-only service source falsely offers application-only SSH target");
  await dialog.getByRole("button", { name: /^cancel$/i }).click();

  // Live SoftEther matrix: exact binary evidence and no fake PPTP.
  const capabilities = await api("/zagros/cores/capability-matrix");
  const pptp = capabilities.softether_transports.pptp.server;
  assert(pptp.state === "unsupported", `PPTP state is ${pptp.state}`);
  assert((pptp.runtime_version || "").includes("4.44"), "SoftEther binary version evidence missing");
  assert(pptp.required_commands.includes("PptpGet") && pptp.observed_commands.length === 0,
    "PPTP command-inventory evidence is wrong");
  const openvpn = capabilities.softether_transports.openvpn.client;
  assert(openvpn.canonical_outbound_kind === "openvpn" && openvpn.tun === true,
    "SoftEther OpenVPN compatibility did not map to the real OpenVPN client");
  for (const transport of ["native", "l2tp_ipsec", "l2tp_raw", "sstp", "pptp"])
    assert(capabilities.softether_transports[transport].client.state === "unsupported",
      `${transport} fabricated a SoftEther client implementation`);

  await page.goto(panel + "#/capabilities", { waitUntil: "networkidle" });
  await page.getByText("SoftEther transport capabilities", { exact: true }).waitFor({ timeout: 30000 });
  const capabilityText = await page.locator("main").innerText();
  assert(capabilityText.includes("SoftEther transport capabilities"), `granular SoftEther matrix not rendered: ${capabilityText.slice(0, 800)} errors=${errors.slice(-3).join(" | ")}`);
  assert(capabilityText.includes("Routing source → target core"), "routing pair matrix not rendered");

  await page.goto(panel + "#/cores", { waitUntil: "networkidle" });
  const coreText = await page.locator("main").innerText();
  assert(!/snapshot is stale|collector is not active|run zagros install-host-agent|accounting failed/i.test(coreText),
    "healthy SSH host accounting is still rendered as unavailable/stale");

  assert(errors.length === 0, `browser errors: ${errors.slice(0, 5).join(" | ")}`);
  console.log("ALPHA.8.6 BROWSER: PASS — SSH create/inventory/context + live SoftEther/PPTP matrix");
} finally {
  try {
    if (originalRules)
      await api("/zagros/routing/deploy", { method: "POST", body: JSON.stringify({ rules: originalRules.rules }) });
    if (originalOutbounds)
      await api("/zagros/outbounds/deploy", { method: "POST", body: JSON.stringify({ outbounds: originalOutbounds.outbounds }) });
  } catch (error) {
    console.error("alpha.8.6 browser cleanup failed", error);
    process.exitCode = 1;
  }
  await browser.close();
}
