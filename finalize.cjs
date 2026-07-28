const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");
const {
  atomicWriteFile,
  ensureDir,
  stableId,
  writeJson,
} = require("./core.cjs");
const { normalizeActor, sanitizeText } = require("./security.cjs");

const DATABASE_SCHEMA_VERSION = 3;

const VALID_ANNOTATION_STATUSES = new Set([
  "passed",
  "failed",
  "skipped",
  "pending",
  "environment_error",
  "precondition_error",
  "outdated_test",
  "reported",
]);

function extractJiraId(tags = []) {
  for (const tag of tags) {
    const match = String(tag || "").trim().match(/^@?([A-Z][A-Z0-9]+-\d+)$/i);
    if (match) return match[1].toUpperCase();
  }
  return "";
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+\(example\s+#\d+\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function canonicalTestIdentity(test = {}) {
  const jiraId = String(test.jira_id || test.jiraId || "")
    .replace(/^@/, "")
    .trim()
    .toUpperCase();
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(jiraId)) {
    return `jira:${jiraId}`;
  }

  const caseId = String(test.case_id || test.caseId || "").trim();
  if (caseId) return `case:${caseId}`;

  const logicalId = String(test.logical_id || test.logicalId || "").trim();
  if (logicalId) return `logical:${logicalId}`;

  return `fallback:${stableId(
    String(test.spec || "").replaceAll("\\", "/").toLowerCase(),
    normalizeTitle(test.originalTitle || test.title),
  )}`;
}

function readCucumberScenarios(projectRoot) {
  const cucumberPath = path.join(projectRoot, "jsonlogs", "cucumber.json");
  const features = readJson(cucumberPath, []);
  const scenarios = [];

  for (const feature of Array.isArray(features) ? features : []) {
    for (const scenario of feature.elements || []) {
      scenarios.push({
        feature: feature.name || "",
        uri: feature.uri || "",
        name: scenario.name || "",
        originalName: scenario.original_name || scenario.name || "",
        isExample: Boolean(scenario.is_example),
        exampleIndex: Number(scenario.example_index || 0) || null,
        status: scenario.status || "",
        tags: (scenario.tags || []).map((tag) => tag.name).filter(Boolean),
        steps: (scenario.steps || []).map((step, index) => ({
          index,
          keyword: String(step.keyword || "Step").trim(),
          name: step.name || "",
          status: String(step.result?.status || "unknown").toLowerCase(),
          durationMs: Math.round(Number(step.result?.duration || 0) / 1_000_000),
          startedAt: step.started_at || null,
          finishedAt: step.finished_at || null,
          error: step.result?.error_message || "",
        })),
      });
    }
  }

  return scenarios;
}

function mergeCucumber(run, scenarios) {
  const byName = new Map();
  const usageByName = new Map();
  for (const scenario of scenarios) {
    const key = normalizeTitle(scenario.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(scenario);
  }

  for (const test of run.tests) {
    const key = normalizeTitle(test.title);
    const candidates = byName.get(key) || [];
    const usage = usageByName.get(key) || 0;
    const scenario =
      candidates.find(
        (candidate, index) =>
          index >= usage &&
          (!candidate.uri ||
            test.spec.includes(
              candidate.uri.replace(/^.*?cypress\//, "cypress/"),
            )),
      ) ||
      candidates[usage] ||
      candidates[0];

    if (!scenario) continue;
    usageByName.set(key, usage + 1);
    test.feature = scenario.feature;
    test.tags = scenario.tags;
    test.originalTitle = scenario.originalName;
    test.isExample = scenario.isExample;
    test.exampleIndex = scenario.exampleIndex;
    test.steps = scenario.steps;

    const attemptStartedAt = test.attempts?.at(-1)?.startedAt;
    let estimatedTimestamp = Date.parse(attemptStartedAt || "");
    if (!Number.isFinite(estimatedTimestamp)) {
      estimatedTimestamp = Date.parse(run.startedAt || "");
    }
    if (!Number.isFinite(estimatedTimestamp)) {
      estimatedTimestamp = 0;
    }

    test.steps = test.steps.map((step) => {
      const startedAt = step.startedAt || (
        estimatedTimestamp > 0 ? new Date(estimatedTimestamp).toISOString() : null
      );
      const durationMs = Math.max(0, Number(step.durationMs || 0));
      const finishedAt = step.finishedAt || (
        startedAt ? new Date(Date.parse(startedAt) + durationMs).toISOString() : null
      );
      const parsedFinishedAt = Date.parse(finishedAt || "");
      if (Number.isFinite(parsedFinishedAt)) {
        estimatedTimestamp = parsedFinishedAt;
      } else {
        estimatedTimestamp += durationMs;
      }

      return {
        ...step,
        startedAt,
        finishedAt,
      };
    });
  }

  return run;
}

function enrichRunTests(run) {
  for (const test of run.tests || []) {
    const exampleMatch = String(test.title || "").match(
      /^(.*?)\s+\(example\s+#(\d+)\)\s*$/i,
    );
    test.originalTitle =
      test.originalTitle ||
      (exampleMatch ? exampleMatch[1].trim() : test.title);
    test.isExample = Boolean(test.isExample || exampleMatch);
    test.exampleIndex =
      Number(test.exampleIndex || exampleMatch?.[2] || 0) || null;
    const jiraId = extractJiraId(test.tags);
    test.caseId = jiraId
      ? stableId("jira", jiraId)
      : stableId("case", test.spec, test.suite, test.originalTitle);
    test.logicalId = test.caseId;
    test.executionId = stableId(
      test.logicalId,
      test.exampleIndex ? `example:${test.exampleIndex}` : test.title,
    );

    const timestamps = [
      ...(test.logs || []).map((log) => Date.parse(log.timestamp || "")),
      ...(test.steps || []).flatMap((step) => [
        Date.parse(step.startedAt || ""),
        Date.parse(step.finishedAt || ""),
      ]),
    ].filter((timestamp) => Number.isFinite(timestamp));

    if (timestamps.length >= 2) {
      const timelineDurationMs = Math.max(...timestamps) - Math.min(...timestamps);
      test.timelineDurationMs = Math.max(0, timelineDurationMs);
      test.durationMs = test.timelineDurationMs;
    } else {
      test.timelineDurationMs = Number(test.durationMs || 0);
    }
  }

  const caseIds = new Set((run.tests || []).map((test) => test.caseId));
  run.counts.testCases = caseIds.size;
  run.counts.executions = (run.tests || []).length;
  return run;
}

function copyEvidence(projectRoot, runDir, run) {
  const mediaDir = path.join(runDir, "media");
  ensureDir(mediaDir);
  const copied = new Map();

  function copyCandidate(candidate, type) {
    if (!candidate?.absolutePath || !fs.existsSync(candidate.absolutePath)) {
      return candidate ? { ...candidate, available: false } : null;
    }

    const cacheKey = candidate.absolutePath;
    if (copied.has(cacheKey)) return copied.get(cacheKey);

    const extension = path.extname(candidate.absolutePath);
    const filename = `${stableId(cacheKey).slice(0, 12)}-${path.basename(
      candidate.absolutePath,
      extension,
    )
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 80)}${extension}`;
    const destination = path.join(mediaDir, filename);
    fs.copyFileSync(candidate.absolutePath, destination);
    const normalized = {
      ...candidate,
      type,
      available: true,
      reportPath: `../runs/${run.id}/media/${filename}`,
    };
    copied.set(cacheKey, normalized);
    return normalized;
  }

  for (const spec of run.specs || []) {
    spec.video = copyCandidate(spec.video, "video");
    spec.screenshots = (spec.screenshots || []).map((screenshot) =>
      copyCandidate(screenshot, "screenshot"),
    );
  }

  for (const test of run.tests || []) {
    for (const attempt of test.attempts || []) {
      attempt.video = copyCandidate(attempt.video, "video");
      attempt.screenshots = (attempt.screenshots || []).map((screenshot) =>
        copyCandidate(screenshot, "screenshot"),
      );
    }
    test.attachments = (test.attachments || []).map((attachment) => ({
      ...attachment,
      available: fs.existsSync(path.join(runDir, attachment.path)),
      reportPath: `../runs/${run.id}/${attachment.path.replaceAll("\\", "/")}`,
    }));
  }

  run.attachments = (run.attachments || []).map((attachment) => ({
    ...attachment,
    available: fs.existsSync(path.join(runDir, attachment.path)),
    reportPath: `../runs/${run.id}/${attachment.path.replaceAll("\\", "/")}`,
  }));

  return run;
}

async function openDatabase(databasePath) {
  const SQL = await initSqlJs({
    locateFile(file) {
      return require.resolve(`sql.js/dist/${file}`);
    },
  });
  const bytes = fs.existsSync(databasePath)
    ? fs.readFileSync(databasePath)
    : undefined;
  const database = bytes ? new SQL.Database(bytes) : new SQL.Database();

  database.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      tag_expression TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      total INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      skipped INTEGER NOT NULL,
      pending INTEGER NOT NULL,
      flaky INTEGER NOT NULL
    );
  `);
  const runColumns = new Set(
    queryRows(database, "PRAGMA table_info(runs)").map((column) => column.name),
  );
  if (!runColumns.has("lifecycle")) {
    database.run("ALTER TABLE runs ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'completed';");
  }
  if (!runColumns.has("metadata_json")) {
    database.run("ALTER TABLE runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';");
  }
  database.run(`
    CREATE TABLE IF NOT EXISTS tests (
      run_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      spec TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      retries INTEGER NOT NULL,
      flaky INTEGER NOT NULL,
      jira_id TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      http_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (run_id, test_id)
    );
  `);
  const testColumns = new Set(
    queryRows(database, "PRAGMA table_info(tests)").map((column) => column.name),
  );
  if (!testColumns.has("jira_id")) {
    database.run("ALTER TABLE tests ADD COLUMN jira_id TEXT NOT NULL DEFAULT '';");
  }
  if (!testColumns.has("tags_json")) {
    database.run("ALTER TABLE tests ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!testColumns.has("http_json")) {
    database.run("ALTER TABLE tests ADD COLUMN http_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!testColumns.has("logical_id")) {
    database.run("ALTER TABLE tests ADD COLUMN logical_id TEXT NOT NULL DEFAULT '';");
  }
  if (!testColumns.has("case_id")) {
    database.run("ALTER TABLE tests ADD COLUMN case_id TEXT NOT NULL DEFAULT '';");
  }
  database.run(
    "CREATE INDEX IF NOT EXISTS tests_identity_idx ON tests(test_id, run_id);",
  );
  database.run(
    "CREATE INDEX IF NOT EXISTS tests_jira_idx ON tests(jira_id, run_id);",
  );
  database.run(`
    CREATE TABLE IF NOT EXISTS test_annotations (
      run_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      status TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      ticket TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, test_id)
    );
  `);
  const annotationColumns = new Set(
    queryRows(database, "PRAGMA table_info(test_annotations)")
      .map((column) => column.name),
  );
  if (!annotationColumns.has("actor")) {
    database.run("ALTER TABLE test_annotations ADD COLUMN actor TEXT NOT NULL DEFAULT 'Usuario local';");
  }
  if (!annotationColumns.has("revision")) {
    database.run("ALTER TABLE test_annotations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;");
  }
  database.run(`
    CREATE TABLE IF NOT EXISTS annotation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      previous_status TEXT NOT NULL,
      status TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      ticket TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL
    );
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  database.run(
    "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
    [String(DATABASE_SCHEMA_VERSION)],
  );
  database.run(
    "CREATE INDEX IF NOT EXISTS annotations_status_idx ON test_annotations(status, run_id);",
  );
  database.run(
    "UPDATE test_annotations SET status = 'reported' WHERE status = 'fix_in_progress';",
  );

  return database;
}

function persistRun(database, run) {
  const counts = run.counts;
  database.run(
    `INSERT OR REPLACE INTO runs (
      id, environment, tag_expression, status, started_at, ended_at,
      duration_ms, total, passed, failed, skipped, pending, flaky,
      lifecycle, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.environment,
      run.tagExpression,
      run.status,
      run.startedAt,
      run.endedAt,
      run.durationMs,
      counts.total,
      counts.passed,
      counts.failed,
      counts.skipped,
      counts.pending,
      counts.flaky,
      run.lifecycle || "completed",
      JSON.stringify({
        browser: run.browser || {},
        cypressVersion: run.cypressVersion || "",
        system: run.system || {},
        source: run.source || {},
        execution: run.execution || null,
        reporterVersion: "2.0.0-beta.9",
      }),
    ],
  );

  const statement = database.prepare(
    `INSERT OR REPLACE INTO tests (
      run_id, test_id, spec, title, status, duration_ms, retries, flaky,
      jira_id, tags_json, logical_id, case_id, http_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const test of run.tests) {
    statement.run([
      run.id,
      test.id,
      test.spec,
      test.title,
      test.status,
      test.durationMs,
      test.retries,
      test.flaky ? 1 : 0,
      extractJiraId(test.tags),
      JSON.stringify(test.tags || []),
      test.logicalId || test.id,
      test.caseId || test.logicalId || test.id,
      JSON.stringify(test.http || []),
    ]);
  }
  statement.free();
}

function backfillTestMetadata(database, outputDir) {
  const runsDir = path.join(outputDir, "runs");
  if (!fs.existsSync(runsDir)) return;

  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runPath = path.join(runsDir, entry.name, "run.json");
    const historicalRun = readJson(runPath);
    if (!historicalRun) continue;

    for (const test of historicalRun.tests || []) {
      const tags = test.tags || [];
      const [storedMetadata] = queryRows(
        database,
        `SELECT jira_id
           FROM tests
          WHERE run_id = ? AND test_id = ?`,
        [historicalRun.id, test.id],
      );
      const jiraId = extractJiraId(tags) || storedMetadata?.jira_id || "";
      const originalTitle =
        test.originalTitle ||
        String(test.title || "").replace(/\s+\(example\s+#\d+\)\s*$/i, "").trim();
      const caseId = jiraId
        ? stableId("jira", jiraId)
        : stableId("case", test.spec, test.suite, originalTitle);
      database.run(
        `UPDATE tests
            SET jira_id = ?, tags_json = ?, logical_id = ?, case_id = ?
          WHERE run_id = ? AND test_id = ?`,
        [
          jiraId,
          JSON.stringify(tags),
          caseId,
          caseId,
          historicalRun.id,
          test.id,
        ],
      );
    }
  }
}

function queryRows(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  statement.bind(parameters);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function loadAnnotations(database, runId) {
  const rows = queryRows(
    database,
    `SELECT test_id, status, comment, ticket, updated_at, actor, revision
       FROM test_annotations
      WHERE run_id = ?`,
    [runId],
  );

  return Object.fromEntries(rows.map((row) => [
    row.test_id,
    {
      status: row.status,
      comment: row.comment,
      ticket: row.ticket,
      updatedAt: row.updated_at,
      actor: row.actor,
      revision: Number(row.revision || 1),
    },
  ]));
}

function persistAnnotation(database, annotation) {
  if (!VALID_ANNOTATION_STATUSES.has(annotation.status)) {
    throw new Error(`Estado de anotación inválido: ${annotation.status}`);
  }

  const updatedAt = annotation.updatedAt || new Date().toISOString();
  const [current] = queryRows(
    database,
    `SELECT status, revision FROM test_annotations
      WHERE run_id = ? AND test_id = ?`,
    [annotation.runId, annotation.testId],
  );
  const [test] = queryRows(
    database,
    "SELECT status FROM tests WHERE run_id = ? AND test_id = ?",
    [annotation.runId, annotation.testId],
  );
  const previousStatus = current?.status || test?.status || "unknown";
  const actor = normalizeActor(annotation.actor);
  const comment = sanitizeText(annotation.comment || "");
  const ticket = sanitizeText(annotation.ticket || "", 2_000);
  const revision = Number(current?.revision || 0) + 1;
  database.run(
    `INSERT OR REPLACE INTO test_annotations (
      run_id, test_id, status, comment, ticket, updated_at, actor, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      annotation.runId,
      annotation.testId,
      annotation.status,
      comment,
      ticket,
      updatedAt,
      actor,
      revision,
    ],
  );
  database.run(
    `INSERT INTO annotation_events (
      run_id, test_id, previous_status, status, comment, ticket,
      actor, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      annotation.runId,
      annotation.testId,
      previousStatus,
      annotation.status,
      comment,
      ticket,
      actor,
      sanitizeText(annotation.source || "manual", 80),
      updatedAt,
    ],
  );
  return updatedAt;
}

function loadAnnotationAudit(database, runId, testId) {
  return queryRows(
    database,
    `SELECT previous_status, status, comment, ticket, actor, source, created_at
       FROM annotation_events
      WHERE run_id = ? AND test_id = ?
      ORDER BY id DESC`,
    [runId, testId],
  );
}

function loadRunResults(database, runId) {
  const [run] = queryRows(
    database,
    `SELECT id, environment, tag_expression, status, started_at, ended_at,
            duration_ms, total, passed, failed, skipped, pending, flaky,
            metadata_json
       FROM runs
      WHERE id = ?`,
    [runId],
  );
  if (!run) return null;

  const tests = queryRows(
    database,
    `SELECT t.test_id AS id, t.spec, t.title,
            t.status AS original_status,
            COALESCE(a.status, t.status) AS status,
            t.duration_ms, t.retries, t.flaky, t.jira_id, t.tags_json,
            t.http_json,
            COALESCE(a.comment, '') AS comment,
            COALESCE(a.ticket, '') AS ticket,
            a.updated_at
       FROM tests t
       LEFT JOIN test_annotations a
         ON a.run_id = t.run_id AND a.test_id = t.test_id
      WHERE t.run_id = ?
      ORDER BY t.spec, t.title`,
    [runId],
  );

  for (const test of tests) {
    try {
      test.http = JSON.parse(test.http_json || "[]");
    } catch {
      test.http = [];
    }
    delete test.http_json;
  }

  let metadata = {};
  try {
    metadata = JSON.parse(run.metadata_json || "{}");
  } catch {
    metadata = {};
  }
  delete run.metadata_json;

  return {
    ...run,
    browser: metadata.browser || {},
    system: metadata.system || {},
    source: metadata.source || {},
    execution: metadata.execution || null,
    specs: [...new Set(tests.map((test) => test.spec).filter(Boolean))],
    tests,
  };
}

function loadTestHistory(database, jiraId) {
  const normalizedJiraId = String(jiraId || "").replace(/^@/, "").toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(normalizedJiraId)) return [];

  return queryRows(
    database,
    `SELECT r.id AS run_id, r.environment, r.started_at,
            t.test_id, t.title, t.spec, t.jira_id,
            t.status AS original_status,
            COALESCE(a.status, t.status) AS status,
            t.duration_ms, t.retries, t.flaky,
            COALESCE(a.comment, '') AS comment,
            COALESCE(a.ticket, '') AS ticket,
            a.updated_at
       FROM tests t
       JOIN runs r ON r.id = t.run_id
       LEFT JOIN test_annotations a
         ON a.run_id = t.run_id AND a.test_id = t.test_id
      WHERE UPPER(t.jira_id) = ?
      ORDER BY r.started_at DESC, t.title`,
    [normalizedJiraId],
  );
}

function buildQualityAnalytics(database, environment) {
  const rows = queryRows(
    database,
    `SELECT t.logical_id, t.case_id, t.test_id, t.jira_id,
            t.title, t.spec, t.status, t.flaky, t.duration_ms,
            r.started_at
       FROM tests t
       JOIN runs r ON r.id = t.run_id
      WHERE LOWER(r.environment) = LOWER(?)
      ORDER BY r.started_at DESC, t.title`,
    [environment],
  );

  const groups = new Map();
  for (const row of rows) {
    const key = canonicalTestIdentity(row);
    if (!groups.has(key)) {
      groups.set(key, {
        logical_id: key,
        jira_id: row.jira_id || "",
        title: row.title,
        spec: row.spec,
        executions: 0,
        failures: 0,
        flaky_runs: 0,
        duration_total: 0,
        min_duration: Number.POSITIVE_INFINITY,
        max_duration: 0,
        last_seen: row.started_at,
        history: [],
      });
    }

    const group = groups.get(key);
    const duration = Number(row.duration_ms || 0);
    group.executions += 1;
    group.failures += row.status === "failed" ? 1 : 0;
    group.flaky_runs += Number(row.flaky || 0) ? 1 : 0;
    group.duration_total += duration;
    group.min_duration = Math.min(group.min_duration, duration);
    group.max_duration = Math.max(group.max_duration, duration);
    if (group.history.length < 5) {
      group.history.push({
        status: row.status,
        flaky: Boolean(row.flaky),
        startedAt: row.started_at,
      });
    }
  }

  const withHistory = [...groups.values()].map((item) => ({
    ...item,
    average_duration: item.executions
      ? item.duration_total / item.executions
      : 0,
    min_duration: Number.isFinite(item.min_duration) ? item.min_duration : 0,
    failure_rate: item.executions
      ? Math.round((item.failures / item.executions) * 1000) / 10
      : 0,
    sample_sufficient: item.executions >= 3,
  }));

  return {
    unstable: withHistory
      .filter((item) => item.flaky_runs > 0)
      .slice(0, 25),
    recurrentFailures: withHistory
      .filter((item) => item.failures > 0)
      .sort((left, right) =>
        right.failures - left.failures || right.failure_rate - left.failure_rate)
      .slice(0, 25),
    slowest: [...withHistory]
      .sort((left, right) => Number(right.average_duration) - Number(left.average_duration))
      .slice(0, 10),
  };
}

function compareRuns(database, baseRunId, targetRunId) {
  const load = (runId) => queryRows(
    database,
    `SELECT logical_id, test_id, title, spec, status, duration_ms
       FROM tests WHERE run_id = ?`,
    [runId],
  );
  const base = load(baseRunId);
  const target = load(targetRunId);
  const baseById = new Map(base.map((test) => [test.logical_id || test.test_id, test]));
  const targetById = new Map(target.map((test) => [test.logical_id || test.test_id, test]));
  const keys = new Set([...baseById.keys(), ...targetById.keys()]);
  const changes = [];

  for (const key of keys) {
    const before = baseById.get(key);
    const after = targetById.get(key);
    let type = "unchanged";
    if (!before) type = "added";
    else if (!after) type = "removed";
    else if (before.status !== "failed" && after.status === "failed") type = "new_failure";
    else if (before.status === "failed" && after.status !== "failed") type = "resolved";
    else if (before.status !== after.status) type = "status_changed";
    else if (Number(after.duration_ms) > Number(before.duration_ms) * 1.5) type = "slower";
    if (type !== "unchanged") changes.push({ key, type, before, after });
  }
  return { baseRunId, targetRunId, changes };
}

function buildTrends(database, currentRun, requestedLimit = 20) {
  const limit = Math.max(10, Math.min(50, Number(requestedLimit || 20)));
  const [runCount] = queryRows(
    database,
    `SELECT COUNT(*) AS total_runs
       FROM runs
      WHERE LOWER(environment) = LOWER(?)`,
    [currentRun.environment],
  );
  const runs = queryRows(
    database,
    `SELECT r.id, r.environment, r.status, r.started_at, r.duration_ms,
            COUNT(t.test_id) AS total,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'passed' THEN 1 ELSE 0 END) AS passed,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'skipped' THEN 1 ELSE 0 END) AS skipped,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'environment_error' THEN 1 ELSE 0 END) AS environment_error,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'precondition_error' THEN 1 ELSE 0 END) AS precondition_error,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'outdated_test' THEN 1 ELSE 0 END) AS outdated_test,
            SUM(CASE WHEN COALESCE(a.status, t.status) = 'reported' THEN 1 ELSE 0 END) AS reported,
            r.flaky
       FROM runs r
       LEFT JOIN tests t ON t.run_id = r.id
       LEFT JOIN test_annotations a
         ON a.run_id = t.run_id AND a.test_id = t.test_id
      WHERE LOWER(r.environment) = LOWER(?)
      GROUP BY r.id, r.environment, r.status, r.started_at, r.duration_ms, r.flaky
      ORDER BY r.started_at DESC
      LIMIT ?`,
    [currentRun.environment, limit],
  ).reverse();

  const flakyTests = queryRows(
    database,
    `SELECT t.test_id, t.title, t.spec,
            SUM(CASE WHEN t.flaky = 1 THEN 1 ELSE 0 END) AS flaky_runs,
            SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
            COUNT(*) AS executions
       FROM tests t
       JOIN runs r ON r.id = t.run_id
      WHERE LOWER(r.environment) = LOWER(?)
      GROUP BY t.test_id, t.title, t.spec
     HAVING flaky_runs > 0 OR failed_runs > 0
      ORDER BY flaky_runs DESC, failed_runs DESC
      LIMIT 20`,
    [currentRun.environment],
  );

  return {
    runs,
    flakyTests,
    totalRuns: Number(runCount?.total_runs || 0),
  };
}

function buildHtml(run) {
  const serialized = JSON.stringify(run).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <title>Elmulo Reporter V2 · ${run.environment}</title>
    <link rel="icon" href="assets/donkey-favicon.png" />
    <link rel="stylesheet" href="assets/app.css" />
  </head>
  <body>
    <div id="app"></div>
    <script id="elmulo-data" type="application/json">${serialized}</script>
    <script src="assets/app.js"></script>
  </body>
</html>
`;
}

function copyDirectoryContents(sourceDir, destinationDir) {
  ensureDir(destinationDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function copyStaticAssets(reportDir) {
  // Assets belong to the reporter package, not to the consuming Cypress project.
  copyDirectoryContents(
    path.join(__dirname, "assets"),
    path.join(reportDir, "assets"),
  );
}

function mergeHttpManifest(run, runDir) {
  const manifest = readJson(path.join(runDir, "http", "manifest.json"), []);
  if (!Array.isArray(manifest) || !manifest.length) return;

  for (const test of run.tests || []) {
    const exactKey = (test.titlePath || []).join(" â€º ");
    const entry = manifest.find((candidate) => {
      const candidateKey = String(candidate?.testKey || "");
      if (candidateKey === exactKey || candidateKey === test.title) return true;
      return Boolean(test.title) &&
        candidateKey.endsWith(test.title) &&
        (test.titlePath || []).every((part) => candidateKey.includes(part));
    });
    test.http = Array.isArray(entry?.exchanges) ? entry.exchanges : test.http || [];
  }
}

async function finalizeRun(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.resolve(
    projectRoot,
    options.outputDir || process.env.ELMULO_OUTPUT_DIR || "elmulo-results",
  );
  const latestRunPath = path.join(outputDir, "latest-run.txt");

  if (!fs.existsSync(latestRunPath)) {
    throw new Error(
      "No hay una ejecución capturada. Ejecuta Cypress con Elmulo habilitado.",
    );
  }

  const runId = fs.readFileSync(latestRunPath, "utf8").trim();
  const runDir = path.join(outputDir, "runs", runId);
  const rawPath = path.join(runDir, "run.raw.json");
  const run = readJson(rawPath);
  if (!run) throw new Error(`No se encontró ${rawPath}`);

  run.schemaVersion = DATABASE_SCHEMA_VERSION;
  run.reporterVersion = "2.0.0-beta.9";
  run.lifecycle = run.lifecycle || "completed";
  run.source = run.source || {
    branch: process.env.CI_COMMIT_REF_NAME || "",
    commit: process.env.CI_COMMIT_SHA || "",
    pipelineId: process.env.CI_PIPELINE_ID || "",
    jobId: process.env.CI_JOB_ID || "",
    jobUrl: process.env.CI_JOB_URL || "",
  };
  mergeHttpManifest(run, runDir);
  mergeCucumber(run, readCucumberScenarios(projectRoot));
  enrichRunTests(run);
  copyEvidence(projectRoot, runDir, run);

  const databasePath = path.join(outputDir, "elmulo.sqlite");
  const database = await openDatabase(databasePath);
  persistRun(database, run);
  backfillTestMetadata(database, outputDir);
  run.annotations = loadAnnotations(database, run.id);
  run.trends = buildTrends(database, run);
  atomicWriteFile(databasePath, Buffer.from(database.export()));
  database.close();

  run.generatedAt = new Date().toISOString();
  writeJson(path.join(runDir, "run.json"), run);

  const reportDir = path.join(outputDir, "report");
  ensureDir(reportDir);
  copyStaticAssets(reportDir);
  fs.writeFileSync(path.join(reportDir, "index.html"), buildHtml(run), "utf8");
  writeJson(path.join(reportDir, "data.json"), run);

  return { outputDir, reportDir, runDir, run };
}

module.exports = {
  VALID_ANNOTATION_STATUSES,
  backfillTestMetadata,
  buildHtml,
  buildTrends,
  buildQualityAnalytics,
  canonicalTestIdentity,
  compareRuns,
  copyDirectoryContents,
  copyStaticAssets,
  enrichRunTests,
  finalizeRun,
  loadAnnotations,
  loadAnnotationAudit,
  loadRunResults,
  loadTestHistory,
  extractJiraId,
  mergeCucumber,
  normalizeTitle,
  openDatabase,
  persistAnnotation,
  persistRun,
};
