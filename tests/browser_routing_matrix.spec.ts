import { expect, test } from "@playwright/test";

// CI-friendly companion to browser-routing-matrix.mjs. The standalone MJS
// owns the destructive create/edit/deploy/restore flow used against the real
// VPS; this spec keeps the non-mutating capability/settings assertions usable
// by a conventional Playwright runner.
test("routing capabilities and settings surfaces are honest", async ({ page }) => {
  const panel = (process.env.PANEL_URL || "").replace(/\/+$/, "/");
  const user = process.env.PANEL_USER || "";
  const pass = process.env.PANEL_PASS || "";
  test.skip(!panel || !user || !pass, "real panel credentials are required");

  await page.goto(panel + "#/login", { waitUntil: "networkidle" });
  await page.locator("#u").fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.hash.includes("login"));

  await page.goto(panel + "#/outbounds", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /outbound/i }).last().click();
  const options = page.getByRole("dialog").locator("select").first().locator("option");
  for (const kind of [
    "softether_l2tp", "softether_l2tp_raw", "softether_sstp",
    "softether_pptp", "softether_native",
  ]) {
    await expect(options.locator(`[value="${kind}"]`)).toBeDisabled();
  }

  await page.getByRole("dialog").getByRole("button", { name: /cancel/i }).click();
  await page.goto(panel + "#/settings", { waitUntil: "networkidle" });
  await expect(page.getByText("Panel Network", { exact: true })).toBeVisible();
  await page.goto(panel + "#/subscriptions", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: /test configuration/i })).toBeVisible();
});
