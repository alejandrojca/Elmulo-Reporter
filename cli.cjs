#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { createRunId, ensureDir, stableId, writeJson } = require("./core.cjs");
const { finalizeRun } = require("./finalize.cjs");
const { serveReport } = require("./server.cjs");

function createDemoRun(projectRoot) {
  const outputDir = path.resolve(
    projectRoot,
    process.env.ELMULO_OUTPUT_DIR || "elmulo-results",
  );
  const startedAt = new Date(Date.now() - 84_000).toISOString();
  const endedAt = new Date().toISOString();
  const runId = createRunId(startedAt);
  const runDir = path.join(outputDir, "runs", runId);
  ensureDir(runDir);

  const definitions = [
    {
      spec: "cypress/e2e/decidir/mtt/mtt-payment.feature",
      title: "MTT payment with brand TARJETA NARANJA and DUKPT",
      status: "passed",
      durationMs: 22430,
      retries: 0,
      flaky: false,
    },
    {
      spec: "cypress/e2e/decidir/mtt/mtt-payment.feature",
      title: "MTT payment with brand CABAL DEBIT and DUKPT",
      status: "passed",
      durationMs: 28190,
      retries: 1,
      flaky: true,
    },
    {
      spec: "cypress/e2e/decidir/mtt/mtt-payment.feature",
      title: "MTT payment with brand CABAL CREDIT and DUKPT",
      status: "failed",
      durationMs: 33380,
      retries: 1,
      flaky: false,
    },
    {
      spec: "cypress/e2e/decidir/mtt/mtt-payment-negative.feature",
      title: "Reject MTT payment with an invalid cryptogram",
      status: "skipped",
      durationMs: 0,
      retries: 0,
      flaky: false,
    },
  ];

  const tests = definitions.map((definition, index) => ({
    id: stableId(definition.spec, definition.title),
    ...definition,
    titlePath: ["MTT payment from API", definition.title],
    suite: "MTT payment from API",
    error:
      definition.status === "failed"
        ? {
            name: "AssertionError",
            message: "expected response status 201 but received 500",
            stack:
              "AssertionError: expected response status 201 but received 500\n    at Context.eval (mtt-payment.feature:25:5)",
          }
        : null,
    attempts: Array.from(
      { length: definition.retries + 1 },
      (_, attemptIndex) => ({
        index: attemptIndex,
        number: attemptIndex + 1,
        state:
          attemptIndex < definition.retries
            ? "failed"
            : definition.status,
        durationMs: Math.round(
          definition.durationMs / (definition.retries + 1),
        ),
        startedAt,
        error:
          attemptIndex < definition.retries ||
          definition.status === "failed"
            ? {
                name: "AssertionError",
                message: "La respuesta no coincidió con el contrato esperado",
                stack: "AssertionError: respuesta inesperada",
              }
            : null,
        screenshots: [],
        video: null,
      }),
    ),
    steps: [
      {
        index: 0,
        keyword: "Given",
        name: "A random amount is generated for the MTT payment",
        status: "passed",
        durationMs: 120,
        error: "",
      },
      {
        index: 1,
        keyword: "When",
        name: "The MTT payment request is sent",
        status: definition.status === "failed" ? "failed" : "passed",
        durationMs: Math.max(0, definition.durationMs - 120),
        error:
          definition.status === "failed"
            ? "El servicio respondió HTTP 500"
            : "",
      },
      {
        index: 2,
        keyword: "Then",
        name: "The MTT payment response is successful",
        status:
          definition.status === "failed"
            ? "skipped"
            : definition.status,
        durationMs: 0,
        error: "",
      },
    ],
    tags: ["@mtt", "@smoke"],
    logs: [
      {
        name: "request",
        message: "POST /api/v1/payments",
        timestamp: startedAt,
      },
      {
        name: "assert",
        message: `status: ${definition.status}`,
        timestamp: endedAt,
      },
    ],
    attachments: [],
  }));

  const counts = tests.reduce(
    (summary, test) => {
      summary.total += 1;
      summary[test.status] += 1;
      if (test.flaky) summary.flaky += 1;
      return summary;
    },
    {
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      flaky: 0,
    },
  );

  const run = {
    schemaVersion: 3,
    id: runId,
    projectName: "acceptance-tests",
    environment: "sandbox",
    tagExpression: "@mtt and not @negative",
    status: "failed",
    startedAt,
    endedAt,
    durationMs: 84000,
    browser: { name: "chrome", version: "150" },
    cypressVersion: "14.5.4",
    system: { name: "win32", version: "11" },
    counts,
    specs: [
      {
        path: "cypress/e2e/decidir/mtt/mtt-payment.feature",
        name: "mtt-payment.feature",
        durationMs: 84000,
        video: null,
        testIds: tests.map((test) => test.id),
      },
    ],
    tests,
    attachments: [],
    trends: [],
    generatedAt: endedAt,
    lifecycle: "completed",
    source: {
      branch: "feature/elmulo-v2",
      commit: "demo",
      pipelineId: "local-demo",
      jobId: "",
      jobUrl: "",
    },
    execution: {
      runner: "npm",
      script: "demo",
    },
  };

  writeJson(path.join(runDir, "run.raw.json"), run);
  writeJson(path.join(runDir, "run.json"), run);
  fs.writeFileSync(path.join(outputDir, "latest-run.txt"), runId, "utf8");
  return run;
}

function applyRetention(projectRoot, keepValue) {
  const outputDir = path.resolve(
    projectRoot,
    process.env.ELMULO_OUTPUT_DIR || "elmulo-results",
  );
  const runsDir = path.join(outputDir, "runs");
  const keep = Math.max(1, Math.min(1000, Number(keepValue || 50)));
  if (!fs.existsSync(runsDir)) return { keep, removed: 0 };
  const runs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(runsDir, entry.name),
      modifiedAt: fs.statSync(path.join(runsDir, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const removable = runs.slice(keep);
  for (const run of removable) {
    const resolved = path.resolve(run.path);
    if (!resolved.startsWith(`${path.resolve(runsDir)}${path.sep}`)) {
      throw new Error("La retención intentó salir del directorio de corridas.");
    }
    fs.rmSync(resolved, { recursive: true, force: false });
  }
  return { keep, removed: removable.length };
}

async function main() {
  const projectRoot = process.cwd();
  const command = process.argv[2] || "finalize";

  if (command === "serve") {
    const result = await serveReport({
      projectRoot,
      outputDir: process.env.ELMULO_OUTPUT_DIR,
      port: process.argv[3],
    });
    console.log(`[elmulo] Reporte disponible en ${result.url}`);
    console.log("[elmulo] Las clasificaciones se persisten en SQLite.");
    return;
  }

  if (command === "retention") {
    const result = applyRetention(projectRoot, process.argv[3]);
    console.log(`[elmulo-v2] Retención aplicada: ${result.keep} corridas conservadas, ${result.removed} eliminadas.`);
    return;
  }

  if (command === "demo") createDemoRun(projectRoot);
  if (!["demo", "finalize", "serve", "retention"].includes(command)) {
    throw new Error(`Comando desconocido: ${command}`);
  }

  const result = await finalizeRun({
    projectRoot,
    outputDir: process.env.ELMULO_OUTPUT_DIR,
  });
  console.log(`[elmulo] Reporte generado: ${path.join(result.reportDir, "index.html")}`);
  console.log(`[elmulo] Historial SQLite: ${path.join(result.outputDir, "elmulo.sqlite")}`);
}

main().catch((error) => {
  console.error(`[elmulo] ${error.stack || error.message}`);
  process.exitCode = 1;
});
