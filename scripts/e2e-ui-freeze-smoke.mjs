#!/usr/bin/env node

const baseUrl = process.env.ALAYA_E2E_BASE_URL ?? "http://127.0.0.1:5001";
const headless = process.env.ALAYA_E2E_HEADLESS !== "false";
const timeoutMs = Number(process.env.ALAYA_E2E_TIMEOUT_MS ?? 20_000);
const maxStepMs = Number(process.env.ALAYA_UI_FREEZE_MAX_STEP_MS ?? 1_200);
const maxLongTaskMs = Number(process.env.ALAYA_UI_FREEZE_MAX_LONG_TASK_MS ?? 250);

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, message, ...details }, null, 2));
  process.exit(1);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    fail("Playwright is not installed", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function installFreezeProbe(page) {
  await page.addInitScript(() => {
    window.__alayaFreezeProbe = {
      maxLagMs: 0,
      samples: 0,
      longTasks: [],
    };

    const sampleEveryMs = 50;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - last - sampleEveryMs);
      window.__alayaFreezeProbe.maxLagMs = Math.max(window.__alayaFreezeProbe.maxLagMs, lag);
      window.__alayaFreezeProbe.samples += 1;
      last = now;
    }, sampleEveryMs);

    if ("PerformanceObserver" in window) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__alayaFreezeProbe.longTasks.push({
              name: entry.name,
              duration: entry.duration,
              startTime: entry.startTime,
            });
          }
        });
        observer.observe({ type: "longtask", buffered: true });
      } catch {
        // Long task observation is unavailable in some browser builds.
      }
    }
  });
}

async function step(results, name, action) {
  const started = Date.now();
  try {
    await action();
    const elapsedMs = Date.now() - started;
    results.push({ name, ok: true, elapsedMs });
    return elapsedMs;
  } catch (error) {
    const elapsedMs = Date.now() - started;
    results.push({
      name,
      ok: false,
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
    });
    return elapsedMs;
  }
}

async function clickAndWait(page, linkTestId, pageTestId) {
  await page.getByTestId(linkTestId).click();
  await page.getByTestId(pageTestId).waitFor({ state: "visible", timeout: timeoutMs });
}

async function clickFirst(page, selector, waitSelector) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible", timeout: timeoutMs });
  await target.click();
  await page.locator(waitSelector).first().waitFor({ state: "visible", timeout: timeoutMs });
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const consoleIssues = [];
  const failedRequests = [];
  const results = [];

  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleIssues.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({ url: request.url(), failure: request.failure()?.errorText ?? "unknown" });
  });

  await installFreezeProbe(page);

  await step(results, "open dashboard", async () => {
    await page.goto(`${baseUrl}/#/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByTestId("page-dashboard").waitFor({ state: "visible", timeout: timeoutMs });
  });

  await step(results, "dashboard to gates", () => clickAndWait(page, "link-nav-human-gates", "page-gates"));
  await step(results, "gates filters", async () => {
    for (const testId of ["filter-direction", "filter-meaning", "filter-risk", "filter-all"]) {
      const filter = page.getByTestId(testId);
      if (await filter.count()) await filter.click();
    }
  });
  await step(results, "gates to ledger", () => clickAndWait(page, "link-nav-prediction-ledger", "page-ledger"));
  await step(results, "ledger to knowledge", () => clickAndWait(page, "link-nav-knowledge-base", "page-knowledge"));
  await step(results, "knowledge search", async () => {
    await page.getByTestId("input-knowledge-search").fill("预览");
    await page.getByTestId("button-knowledge-search").click();
    await page.getByTestId("text-search-status").waitFor({ state: "visible", timeout: timeoutMs });
  });
  await step(results, "knowledge clear search", async () => {
    const clear = page.getByTestId("button-knowledge-clear");
    if (await clear.count()) await clear.click();
  });
  await step(results, "knowledge detail first", () => clickFirst(page, '[data-testid^="card-knowledge-"]', '[data-testid="detail-knowledge"]'));
  await step(results, "knowledge detail second", async () => {
    const cards = page.locator('[data-testid^="card-knowledge-"]');
    if (await cards.count() > 1) {
      await cards.nth(1).click();
      await page.getByTestId("detail-knowledge").waitFor({ state: "visible", timeout: timeoutMs });
    }
  });
  await step(results, "knowledge to review", () => clickAndWait(page, "link-nav-cycle-review", "page-review"));
  await step(results, "review cycle select", async () => {
    const select = page.getByTestId("select-cycle");
    const options = await select.locator("option").evaluateAll((nodes) => nodes.map((node) => node.value));
    if (options.length > 1) {
      await select.selectOption(options[options.length - 1]);
      await page.getByTestId("text-cycle-goal").waitFor({ state: "visible", timeout: timeoutMs });
    }
  });
  await step(results, "review to setup", () => clickAndWait(page, "link-nav-project-setup", "page-project-setup"));
  await step(results, "setup to new project", () => clickAndWait(page, "link-new-project", "page-new-project"));
  await step(results, "back to dashboard", () => clickAndWait(page, "link-nav-dashboard", "page-dashboard"));

  const probe = await page.evaluate(() => window.__alayaFreezeProbe ?? null);
  await browser.close();

  const slowSteps = results.filter((item) => item.ok && item.elapsedMs > maxStepMs);
  const failedSteps = results.filter((item) => !item.ok);
  const longTasks = Array.isArray(probe?.longTasks)
    ? probe.longTasks.filter((item) => item.duration > maxLongTaskMs)
    : [];

  const report = {
    ok: failedSteps.length === 0 && slowSteps.length === 0 && consoleIssues.length === 0 && failedRequests.length === 0 && longTasks.length === 0,
    baseUrl,
    thresholds: { maxStepMs, maxLongTaskMs },
    results,
    probe,
    slowSteps,
    longTasks,
    consoleIssues,
    failedRequests,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  fail("UI freeze smoke failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
});
