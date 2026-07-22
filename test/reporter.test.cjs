const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeCypressResults } = require("../core.cjs");
const {
  buildTrends,
  buildQualityAnalytics,
  compareRuns,
  enrichRunTests,
  loadAnnotationAudit,
  loadAnnotations,
  loadRunResults,
  loadTestHistory,
  mergeCucumber,
  openDatabase,
  persistAnnotation,
  persistRun,
} = require("../finalize.cjs");
const { registerElmuloReporter } = require("../plugin.cjs");
const { buildExecutivePdf } = require("../executive-pdf.cjs");
const { redactSecrets, sanitizeLogEntry } = require("../security.cjs");

function buildRun() {
  return normalizeCypressResults(
    {
      startedTestsAt: "2026-07-17T10:00:00.000Z",
      endedTestsAt: "2026-07-17T10:00:03.000Z",
      totalDuration: 3000,
      browserName: "chrome",
      browserVersion: "150",
      cypressVersion: "14.5.4",
      runs: [
        {
          spec: {
            relative: "cypress/e2e/example.feature",
            name: "example.feature",
          },
          stats: { duration: 3000 },
          screenshots: [
            {
              name: "Scenario name (failed)",
              path: path.join(
                process.cwd(),
                "cypress",
                "screenshots",
                "Scenario name (failed).png",
              ),
              takenAt: "2026-07-17T10:00:02.000Z",
              width: 1280,
              height: 720,
            },
          ],
          tests: [
            {
              title: ["Feature name", "Scenario name"],
              state: "passed",
              attempts: [
                {
                  state: "failed",
                  duration: 1000,
                  error: { message: "first attempt failed" },
                  screenshots: [],
                },
                {
                  state: "passed",
                  duration: 2000,
                  screenshots: [],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      projectRoot: process.cwd(),
      runId: "run-test",
      environment: "sandbox",
      tagExpression: "@smoke",
    },
  );
}

test("normaliza reintentos y detecta una prueba inestable", () => {
  const run = buildRun();
  assert.equal(run.tests.length, 1);
  assert.equal(run.tests[0].status, "passed");
  assert.equal(run.tests[0].retries, 1);
  assert.equal(run.tests[0].flaky, true);
  assert.equal(run.counts.flaky, 1);
  assert.equal(run.durationMs, 3000);
  assert.equal(run.tests[0].attempts[1].screenshots.length, 1);
});

test("habilita Elmulo solo en la configuración donde se registra", () => {
  const events = [];
  const config = {
    projectRoot: process.cwd(),
    env: { ENVIRONMENT: "sandbox" },
  };
  registerElmuloReporter(
    (eventName) => events.push(eventName),
    config,
    { outputDir: "elmulo-results-test" },
  );

  assert.equal(config.env.elmulo, true);
  assert.equal(config.env.elmuloCaptureHttp, true);
  assert.deepEqual(events, ["before:run", "after:run", "task"]);
});

test("conserva requests y respuestas sin ofuscar al consolidar la corrida", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elmulo-http-"));
  const handlers = {};
  registerElmuloReporter(
    (eventName, handler) => {
      handlers[eventName] = handler;
    },
    { projectRoot, env: { ENVIRONMENT: "sandbox" } },
  );

  handlers["before:run"]({ startedTestsAt: "2026-07-17T10:00:00.000Z" });
  handlers.task["elmulo:recordHttp"]({
    testKey: "Feature name â€º Scenario name",
    exchanges: [{
      request: {
        method: "POST",
        url: "https://api.example.test/payments",
        headers: { authorization: "Bearer exact-secret" },
        body: { account: "00123456789" },
      },
      response: { status: 402, body: { code: "PAY-009" } },
    }],
  });
  handlers["after:run"]({
    startedTestsAt: "2026-07-17T10:00:00.000Z",
    endedTestsAt: "2026-07-17T10:00:01.000Z",
    totalDuration: 1000,
    runs: [{
      spec: { relative: "cypress/e2e/example.feature", name: "example.feature" },
      stats: { duration: 1000 },
      tests: [{
        title: ["Feature name", "Scenario name"],
        state: "failed",
        attempts: [{
          state: "failed",
          duration: 1000,
          error: { message: "AssertionError: expected 402 to equal 201" },
        }],
      }],
    }],
  });

  const runId = fs.readFileSync(path.join(projectRoot, "elmulo-results", "latest-run.txt"), "utf8");
  const persistedRun = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "elmulo-results", "runs", runId, "run.json"),
    "utf8",
  ));
  assert.equal(
    persistedRun.tests[0].http[0].request.headers.authorization,
    "Bearer exact-secret",
  );
  assert.equal(persistedRun.tests[0].http[0].request.body.account, "00123456789");
  assert.equal(persistedRun.tests[0].http[0].response.status, 402);
});

test("expone una integración reutilizable para Cypress", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );

  assert.equal(packageJson.exports["./cypress"], "./plugin.cjs");
  assert.equal(packageJson.exports["./support"], "./support.ts");
  assert.equal(packageJson.bin.elmulo, "cli.cjs");
  assert.equal(
    fs.existsSync(path.join(__dirname, "..", "assets", "app.js")),
    true,
  );
});

test("combina pasos y tags de Cucumber por nombre de escenario", () => {
  const run = buildRun();
  run.tests[0].title = "Scenario name (example #1)";
  mergeCucumber(run, [
    {
      feature: "Feature name",
      uri: "cypress/e2e/example.feature",
      name: "Scenario name",
      tags: ["@smoke"],
      steps: [
        {
          keyword: "Given",
          name: "a precondition",
          status: "passed",
          durationMs: 12,
        },
      ],
    },
  ]);
  assert.equal(run.tests[0].feature, "Feature name");
  assert.deepEqual(run.tests[0].tags, ["@smoke"]);
  assert.equal(run.tests[0].steps[0].name, "a precondition");
  assert.equal(run.tests[0].steps[0].startedAt, "2026-07-17T10:00:00.000Z");
  assert.equal(run.tests[0].steps[0].finishedAt, "2026-07-17T10:00:00.012Z");
});

test("agrupa examples y calcula duración usando la línea de tiempo", () => {
  const run = buildRun();
  const firstExample = run.tests[0];
  firstExample.title = "Scenario outline (example #1)";
  firstExample.logs = [
    { timestamp: "2026-07-17T10:00:00.100Z" },
    { timestamp: "2026-07-17T10:00:01.300Z" },
  ];
  firstExample.steps = [
    {
      startedAt: "2026-07-17T10:00:00.200Z",
      finishedAt: "2026-07-17T10:00:02.600Z",
    },
  ];
  const secondExample = JSON.parse(JSON.stringify(firstExample));
  secondExample.id = "second-example";
  secondExample.title = "Scenario outline (example #2)";
  run.tests = [firstExample, secondExample];

  enrichRunTests(run);

  assert.equal(firstExample.originalTitle, "Scenario outline");
  assert.equal(firstExample.exampleIndex, 1);
  assert.equal(firstExample.isExample, true);
  assert.equal(firstExample.durationMs, 2500);
  assert.equal(firstExample.caseId, secondExample.caseId);
  assert.equal(run.counts.testCases, 1);
  assert.equal(run.counts.executions, 2);
});

test("persiste historial real en un archivo SQLite", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elmulo-test-"));
  const databasePath = path.join(tempDir, "history.sqlite");
  const run = buildRun();
  run.tests[0].tags = ["@FONLP06-9999", "@smoke"];
  run.tests[0].http = [{
    request: {
      method: "POST",
      url: "https://api.example.test/payments",
      headers: { authorization: "Bearer developer-secret" },
      body: { cardNumber: "4111111111111111" },
    },
    response: {
      status: 402,
      body: { reason: "insufficient_funds", internalCode: "PAY-009" },
    },
  }];
  const database = await openDatabase(databasePath);
  persistRun(database, run);
  const trends = buildTrends(database, run);

  assert.equal(trends.runs.length, 1);
  assert.equal(trends.totalRuns, 1);
  assert.equal(Number(trends.runs[0].total), 1);
  assert.equal(trends.flakyTests.length, 1);

  persistAnnotation(database, {
    runId: run.id,
    testId: run.tests[0].id,
    status: "reported",
    comment: "BUG-1234",
    ticket: "https://tracker.example/BUG-1234",
  });
  const annotatedTrends = buildTrends(database, run);
  const annotations = loadAnnotations(database, run.id);
  const historicalRun = loadRunResults(database, run.id);
  const jiraHistory = loadTestHistory(database, "FONLP06-9999");
  assert.equal(Number(annotatedTrends.runs[0].failed), 0);
  assert.equal(Number(annotatedTrends.runs[0].reported), 1);
  assert.equal(annotations[run.tests[0].id].status, "reported");
  assert.equal(historicalRun.tests[0].status, "reported");
  assert.equal(historicalRun.tests[0].ticket, "https://tracker.example/BUG-1234");
  assert.equal(
    historicalRun.tests[0].http[0].request.headers.authorization,
    "Bearer developer-secret",
  );
  assert.equal(
    historicalRun.tests[0].http[0].request.body.cardNumber,
    "4111111111111111",
  );
  assert.equal(historicalRun.tests[0].http[0].response.status, 402);
  assert.equal(jiraHistory.length, 1);
  assert.equal(jiraHistory[0].jira_id, "FONLP06-9999");

  persistAnnotation(database, {
    runId: run.id,
    testId: run.tests[0].id,
    status: "passed",
    comment: "Estado reutilizado",
    ticket: "BUG-RESOLVED",
  });
  const reusedState = loadRunResults(database, run.id).tests[0];
  assert.equal(reusedState.status, "passed");
  assert.equal(reusedState.comment, "Estado reutilizado");
  assert.equal(reusedState.ticket, "BUG-RESOLVED");

  fs.writeFileSync(databasePath, Buffer.from(database.export()));
  database.close();
  assert.equal(fs.readFileSync(databasePath, "utf8", 0, 16).slice(0, 6), "SQLite");
});

test("consolida la calidad histórica usando la identidad canónica de Jira", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elmulo-v2-identity-"));
  const database = await openDatabase(path.join(tempDir, "history.sqlite"));
  const firstRun = buildRun();
  firstRun.id = "identity-old";
  firstRun.startedAt = "2026-07-17T10:00:00.000Z";
  firstRun.tests[0].id = "old-test-id";
  firstRun.tests[0].status = "failed";
  firstRun.tests[0].tags = ["@FONLP06-9999"];
  firstRun.tests[0].logicalId = "";
  firstRun.tests[0].caseId = "";
  persistRun(database, firstRun);
  database.run(
    "UPDATE tests SET logical_id = '', case_id = '' WHERE run_id = ?",
    [firstRun.id],
  );

  const secondRun = buildRun();
  secondRun.id = "identity-new";
  secondRun.startedAt = "2026-07-18T10:00:00.000Z";
  secondRun.tests[0].id = "new-test-id";
  secondRun.tests[0].status = "failed";
  secondRun.tests[0].tags = ["@FONLP06-9999"];
  secondRun.tests[0].logicalId = "new-logical-id";
  secondRun.tests[0].caseId = "new-case-id";
  persistRun(database, secondRun);

  for (let index = 3; index <= 7; index += 1) {
    const historicalRun = buildRun();
    historicalRun.id = `identity-${index}`;
    historicalRun.startedAt = `2026-07-${String(16 + index).padStart(2, "0")}T10:00:00.000Z`;
    historicalRun.tests[0].id = `historical-test-${index}`;
    historicalRun.tests[0].status = "failed";
    historicalRun.tests[0].tags = ["@FONLP06-9999"];
    historicalRun.tests[0].logicalId = `historical-logical-${index}`;
    historicalRun.tests[0].caseId = `historical-case-${index}`;
    persistRun(database, historicalRun);
  }

  const analytics = buildQualityAnalytics(database, "sandbox");
  assert.equal(analytics.recurrentFailures.length, 1);
  assert.equal(analytics.recurrentFailures[0].jira_id, "FONLP06-9999");
  assert.equal(analytics.recurrentFailures[0].executions, 7);
  assert.equal(analytics.recurrentFailures[0].history.length, 5);
  assert.equal(
    analytics.recurrentFailures[0].history[0].startedAt,
    "2026-07-23T10:00:00.000Z",
  );
  assert.equal(analytics.recurrentFailures[0].failure_rate, 100);
  database.close();
});

test("genera un PDF ejecutivo modular con secciones seleccionables", () => {
  const run = buildRun();
  enrichRunTests(run);
  run.annotations = {};
  run.trends = {
    totalRuns: 1,
    runs: [{
      id: run.id,
      environment: run.environment,
      started_at: run.startedAt,
      duration_ms: run.durationMs,
      total: run.tests.length,
      passed: 1,
      failed: 0,
    }],
  };
  const pdf = buildExecutivePdf(run);
  const source = pdf.toString("latin1");
  assert.equal(pdf.subarray(0, 8).toString("ascii"), "%PDF-1.4");
  assert.match(source, /\/Count 4/);
  assert.match(source, /Informe ejecutivo de calidad/);
  assert.match(source, /Comparacion con la corrida anterior/);

  const selectedPdf = buildExecutivePdf(run, { sections: ["summary"] });
  const selectedSource = selectedPdf.toString("latin1");
  assert.match(selectedSource, /\/Count 2/);
  assert.match(selectedSource, /Resumen ejecutivo/);
  assert.doesNotMatch(selectedSource, /Comparacion con la corrida anterior/);
  assert.throws(
    () => buildExecutivePdf(run, { sections: [] }),
    /Selecciona al menos una seccion/,
  );
});

test("configura la interfaz sin selección y con seguimiento de fallas", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "..", "assets", "app.js"),
    "utf8",
  );
  const stylesSource = fs.readFileSync(
    path.join(__dirname, "..", "assets", "app.css"),
    "utf8",
  );

  assert.match(appSource, /expandedExampleGroups: new Set\(\)/);
  assert.match(
    appSource,
    /selectedId: initialUrlState\.get\("test"\)/,
  );
  assert.match(appSource, /\["other_errors", "Otros errores"\]/);
  assert.match(appSource, /environment_error: "Error de ambiente"/);
  assert.match(appSource, /reported: "Reportado"/);
  assert.match(appSource, /data-save-failure-review/);
  assert.match(appSource, /requestElmuloJson\("\/api\/annotations"/);
  assert.match(appSource, /\/api\/trends\?environment=/);
  assert.match(appSource, /requestElmuloJson/);
  assert.match(appSource, /http:\/\/127\.0\.0\.1:4178/);
  assert.doesNotMatch(appSource, /response\.json\(\)/);
  assert.match(appSource, /\/api\/runs\//);
  assert.match(appSource, /\/api\/test-history\?jiraId=/);
  assert.match(appSource, /querySelectorAll\("\[data-test-history\]"\)/);
  assert.match(appSource, /historicalStateMatchesCurrent/);
  assert.match(appSource, /ya coinciden con la ejecución actual/);
  assert.match(appSource, /notReusable/);
  assert.match(appSource, /aria-disabled="\$\{notReusable\}"/);
  assert.match(appSource, /data-history-environment/);
  assert.match(appSource, /state\.testHistoryEntries\[0\]\?\.environment/);
  assert.match(appSource, /currentExecutionBadge/);
  assert.match(stylesSource, /\.historyEntry\.notReusable/);
  assert.match(stylesSource, /\.historyEntry\.currentExecution/);
  assert.match(
    stylesSource,
    /html\[data-theme="dark"\] \.historyEntry > header \.currentExecutionBadge/,
  );
  assert.match(
    stylesSource,
    /\.historyEntry\.currentExecution\.notReusable[\s\S]*?filter:\s*none;[\s\S]*?opacity:\s*1;/,
  );
  assert.match(stylesSource, /\.historyFilterBar/);
  assert.match(appSource, /Reutilizar estado/);
  assert.match(appSource, /name="jira-history-entry"/);
  assert.match(appSource, /Última ejecución/);
  assert.match(stylesSource, /\.historyEntry\.latest/);
  assert.match(stylesSource, /html\[data-theme="dark"\] \.historyEntry\.latest/);
  assert.match(stylesSource, /\.historyRadio input:focus-visible/);
  assert.match(stylesSource, /background:\s*#8ee8e2/);
  assert.match(stylesSource, /html\[data-theme="dark"\] \.historyModalFooter/);
  assert.match(appSource, /id="reuse-confirmation-modal"/);
  assert.match(appSource, /Confirmar cambio/);
  assert.match(appSource, /<details class="historyEntryDetails">/);
  assert.doesNotMatch(appSource, /window\.confirm/);
  assert.match(appSource, /id="trend-environment"/);
  assert.match(appSource, /data-close-trend-history/);
  assert.match(appSource, /id="test-history-modal"/);
  assert.match(appSource, /<details class="panel trendPanel">/);
  assert.match(appSource, /run\.tests\.map\(effectiveTestStatus\)/);
  assert.match(stylesSource, /\.exampleRows\[hidden\]/);
  assert.match(stylesSource, /html\[data-theme="dark"\] \.exampleRow/);
  assert.match(stylesSource, /html\[data-theme="dark"\] \.timelineLog/);
  assert.match(stylesSource, /html\[data-theme="dark"\] \.timelineLog \.logHighlight/);
  assert.match(
    stylesSource,
    /\.testHistoryModal\s*\{\s*overflow:\s*hidden;\s*\}/,
  );
  assert.doesNotMatch(appSource, /selectedId: run\.tests\[0\]/);
  assert.doesNotMatch(appSource, /<details class="panel trendPanel" open>/);
  assert.match(appSource, /id="quality-content"/);
  assert.match(appSource, /data-nav-view=/);
  assert.match(appSource, /data-view="overview"/);
  assert.match(appSource, /data-view="executions"/);
  assert.match(appSource, /function featureDistributionMarkup/);
  assert.match(appSource, /<h2>Features<\/h2>/);
  assert.match(appSource, /class="featureStatusBar"/);
  assert.match(stylesSource, /\.trendSummary[\s\S]*?padding:\s*1\.25rem;/);
  assert.match(stylesSource, /\.featureRow/);
  assert.match(stylesSource, /\.featureStatusSegment\.passed/);
  assert.match(appSource, /data-view="quality"/);
  assert.match(appSource, /data-view="analysis"/);
  assert.match(appSource, /data-view="tests"/);
  assert.match(appSource, /data-view="preferences"/);
  assert.match(appSource, /sidebarCollapsed/);
  assert.match(stylesSource, /\.sidebar\.collapsed/);
  assert.match(stylesSource, /\.workspaceView\[hidden\]/);
  assert.match(appSource, /id="compare-runs"/);
  assert.match(appSource, /id="apply-bulk"/);
  assert.match(appSource, /Modificación masiva/);
  assert.doesNotMatch(appSource, /Triage masivo/i);
  assert.match(stylesSource, /html\[data-theme="dark"\] \.bulkPanel/);
  assert.match(stylesSource, /html\[data-theme="dark"\] \.failureReview/);
  assert.match(stylesSource, /html\[data-theme="dark"\] pre/);
  assert.match(stylesSource, /scrollbar-color:\s*#4c6b83 #071522/);
  assert.match(stylesSource, /::-webkit-scrollbar-thumb/);
  assert.match(appSource, /id="save-status"/);
  assert.match(appSource, /class="attentionGrid"/);
  assert.match(appSource, /id="execution-status-chart"/);
  assert.match(appSource, /executionStatusChartMarkup/);
  assert.match(appSource, /id="export-executive-pdf"/);
  assert.match(appSource, /\/api\/export\/executive\.pdf/);
  assert.match(stylesSource, /\.exportPdfButton/);
  assert.match(appSource, /id="pdf-export-modal"/);
  assert.match(appSource, /function openPdfExportModal/);
  assert.match(appSource, /name="pdf-section"/);
  assert.match(appSource, /Usar selección recomendada/);
  assert.match(appSource, /Puede contener credenciales y datos sensibles/);
  assert.match(appSource, /sections=\$\{sectionQuery\}/);
  assert.match(stylesSource, /\.pdfExportModal/);
  assert.match(stylesSource, /\.pdfSectionGrid/);
  assert.match(appSource, /truncateStepWords/);
  assert.match(appSource, /word\.slice\(0, maximum - 3\)/);
  assert.match(appSource, /class="stepText"/);
  assert.match(appSource, /function firstErrorLine/);
  assert.match(appSource, /firstErrorLine\(test\.error\)/);
  assert.match(appSource, /function renderHttpExchanges/);
  assert.match(appSource, /<details class="httpDisclosure">/);
  assert.doesNotMatch(appSource, /<details class="httpDisclosure" open>/);
  assert.match(stylesSource, /\.httpExchangeList/);
  assert.match(stylesSource, /\.statusDonut/);
  assert.match(stylesSource, /\.statusDistributionLegend/);
  assert.match(
    stylesSource,
    /\.trendLegend\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*3;/,
  );
  assert.match(stylesSource, /--trend-outdated-test:\s*#8b5cf6/);
  assert.match(
    stylesSource,
    /\.trendBar \.outdated_test\s*\{\s*background:\s*var\(--trend-outdated-test\);\s*\}/,
  );
  assert.match(appSource, /\["environment_error", "Error de ambiente"\]/);
  assert.match(stylesSource, /\.detailHeader\s*\{\s*position:\s*static;/);
  assert.match(stylesSource, /max-height:\s*calc\(100vh - 104px\)/);
  assert.match(appSource, /data-quality-tab=/);
  assert.match(appSource, /history\.slice\(0, 5\)/);
  assert.match(appSource, /Number\.EPSILON\) \* 100\) \/ 100/);
  assert.match(appSource, /data-visible-options="10"/);
  assert.match(appSource, /function bindTestFilterDropdowns/);
  assert.doesNotMatch(appSource, /id="saved-view"/);
  assert.doesNotMatch(appSource, /id="view-name"/);
  assert.doesNotMatch(appSource, /id="save-view"/);
  assert.doesNotMatch(appSource, /savedViewsStorageKey/);
  assert.match(stylesSource, /\.filterDropdownMenu[\s\S]*?max-height:\s*24\.5rem;/);
  assert.match(stylesSource, /\.filterDropdownMenu[\s\S]*?overflow-y:\s*auto;/);
  assert.match(appSource, /id="theme-toggle"/);
  assert.match(appSource, /id="density"/);
  assert.match(appSource, /test\.status === "failed"/);
  assert.match(appSource, /data-select-test=/);
  assert.match(appSource, /id="bulk-confirmation-modal"/);
  assert.match(appSource, /jira\|status\|tag\|ticket\|spec/);
});

test("protege secretos y conserva una auditoría inmutable", async () => {
  assert.equal(
    redactSecrets("Authorization: Bearer abc.def token=secreto"),
    "Authorization: [REDACTADO] [REDACTADO] token=[REDACTADO]",
  );
  assert.equal(
    sanitizeLogEntry({ name: "request", message: "apiKey=12345" }).message,
    "apiKey=[REDACTADO]",
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elmulo-v2-audit-"));
  const database = await openDatabase(path.join(tempDir, "history.sqlite"));
  const run = buildRun();
  enrichRunTests(run);
  persistRun(database, run);
  persistAnnotation(database, {
    runId: run.id,
    testId: run.tests[0].id,
    status: "environment_error",
    comment: "API inestable",
    ticket: "BUG-100",
    actor: "QA Automation",
  });
  persistAnnotation(database, {
    runId: run.id,
    testId: run.tests[0].id,
    status: "reported",
    comment: "Reportado",
    ticket: "BUG-101",
    actor: "QA Lead",
  });
  const events = loadAnnotationAudit(database, run.id, run.tests[0].id);
  assert.equal(events.length, 2);
  assert.equal(events[0].actor, "QA Lead");
  assert.equal(loadAnnotations(database, run.id)[run.tests[0].id].revision, 2);
  const analytics = buildQualityAnalytics(database, run.environment);
  assert.equal(Array.isArray(analytics.slowest), true);
  assert.equal(Array.isArray(analytics.unstable), true);
  assert.equal(Array.isArray(analytics.recurrentFailures), true);
  assert.equal(analytics.unstable.every((item) => item.flaky_runs > 0), true);
  const comparison = compareRuns(database, run.id, run.id);
  assert.deepEqual(comparison.changes, []);
  database.close();
});
