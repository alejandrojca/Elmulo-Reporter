const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 2;

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function safeFileName(value) {
  return String(value || "artifact")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "artifact";
}

function stableId(...parts) {
  return crypto
    .createHash("sha1")
    .update(parts.filter(Boolean).join("\u001f"))
    .digest("hex");
}

function atomicWriteFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, filePath);
}

function createRunId(startedAt = new Date().toISOString()) {
  const compactDate = startedAt.replace(/\D/g, "").slice(0, 14);
  return `${compactDate}-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeStatus(status) {
  const value = String(status || "").toLowerCase();

  if (value === "passed") return "passed";
  if (value === "failed") return "failed";
  if (value === "pending") return "pending";
  if (value === "skipped") return "skipped";
  return value || "unknown";
}

function normalizePath(projectRoot, candidate) {
  if (!candidate) return null;
  const absolutePath = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(projectRoot, candidate);

  return {
    absolutePath,
    projectPath: path.relative(projectRoot, absolutePath).replaceAll("\\", "/"),
  };
}

function comparableText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeAttempt(projectRoot, attempt, index, specVideo) {
  const screenshots = (attempt?.screenshots || [])
    .map((screenshot) => normalizePath(projectRoot, screenshot.path))
    .filter(Boolean)
    .map((screenshot) => ({
      ...screenshot,
      takenAt: null,
      width: null,
      height: null,
    }));

  return {
    index,
    number: index + 1,
    state: normalizeStatus(attempt?.state),
    durationMs: Number(attempt?.duration || 0),
    startedAt: attempt?.startedAt || null,
    error: attempt?.error
      ? {
          name: attempt.error.name || "Error",
          message: attempt.error.message || "",
          stack: attempt.error.stack || attempt.error.message || "",
        }
      : null,
    screenshots,
    video: normalizePath(projectRoot, specVideo),
  };
}

function normalizeCypressResults(results, context) {
  const projectRoot = context.projectRoot;
  const startedAt =
    results?.startedTestsAt || context.startedAt || new Date().toISOString();
  const endedAt = results?.endedTestsAt || new Date().toISOString();
  const runId = context.runId || createRunId(startedAt);
  const tests = [];
  const specs = [];

  for (const specRun of results?.runs || []) {
    const specPath =
      specRun?.spec?.relative || specRun?.spec?.name || "unknown-spec";
    const specVideo = specRun?.video || null;
    const specTests = [];
    const normalizedSpecTests = [];
    const specScreenshots = (specRun?.screenshots || [])
      .map((screenshot) => {
        const normalized = normalizePath(projectRoot, screenshot.path);
        return normalized
          ? {
              ...normalized,
              name: screenshot.name || path.basename(screenshot.path),
              takenAt: screenshot.takenAt || null,
              width: screenshot.width || null,
              height: screenshot.height || null,
            }
          : null;
      })
      .filter(Boolean);

    for (const test of specRun?.tests || []) {
      const titlePath = Array.isArray(test.title)
        ? test.title
        : Array.isArray(test.titlePath)
          ? test.titlePath
          : [test.title || "Unnamed test"];
      const attempts = (test.attempts || []).map((attempt, index) =>
        normalizeAttempt(projectRoot, attempt, index, specVideo),
      );
      const finalAttempt = attempts.at(-1);
      const status = normalizeStatus(test.state || finalAttempt?.state);
      const testId = stableId(
        context.projectName || "acceptance-tests",
        specPath,
        ...titlePath,
      );
      const normalizedTest = {
        id: testId,
        identityVersion: 2,
        spec: specPath.replaceAll("\\", "/"),
        title: titlePath.at(-1),
        titlePath,
        suite: titlePath.slice(0, -1).join(" › "),
        status,
        durationMs: attempts.reduce(
          (total, attempt) => total + attempt.durationMs,
          0,
        ),
        retries: Math.max(0, attempts.length - 1),
        flaky: status === "passed" && attempts.some((attempt) => attempt.state === "failed"),
        error:
          finalAttempt?.error ||
          (test.displayError
            ? {
                name: "Error",
                message: test.displayError,
                stack: test.displayError,
              }
            : null),
        attempts,
        steps: [],
        tags: [],
        logs: [],
        attachments: [],
      };

      tests.push(normalizedTest);
      normalizedSpecTests.push(normalizedTest);
      specTests.push(testId);
    }

    const failedSpecTests = normalizedSpecTests.filter(
      (test) => test.status === "failed",
    );
    for (const screenshot of specScreenshots) {
      const screenshotText = comparableText(
        `${screenshot.name} ${screenshot.projectPath}`,
      );
      const matchingTest =
        normalizedSpecTests.find((test) =>
          screenshotText.includes(comparableText(test.title)),
        ) ||
        (failedSpecTests.length === 1 ? failedSpecTests[0] : null);
      const finalAttempt = matchingTest?.attempts?.at(-1);
      if (finalAttempt) finalAttempt.screenshots.push(screenshot);
    }

    specs.push({
      path: specPath.replaceAll("\\", "/"),
      name: specRun?.spec?.name || path.basename(specPath),
      durationMs: Number(specRun?.stats?.duration || 0),
      video: normalizePath(projectRoot, specVideo),
      screenshots: specScreenshots,
      testIds: specTests,
    });
  }

  const counts = tests.reduce(
    (summary, test) => {
      summary.total += 1;
      summary[test.status] = (summary[test.status] || 0) + 1;
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

  return {
    schemaVersion: SCHEMA_VERSION,
    id: runId,
    projectName: context.projectName || "acceptance-tests",
    environment: context.environment || "unknown",
    tagExpression: context.tagExpression || "",
    status: counts.failed > 0 ? "failed" : "passed",
    startedAt,
    endedAt,
    durationMs: Number(results?.totalDuration || 0),
    browser: {
      name: results?.browserName || "",
      version: results?.browserVersion || "",
    },
    cypressVersion: results?.cypressVersion || "",
    source: {
      branch: context.branch || process.env.CI_COMMIT_REF_NAME || "",
      commit: context.commit || process.env.CI_COMMIT_SHA || "",
      pipelineId: context.pipelineId || process.env.CI_PIPELINE_ID || "",
      jobId: context.jobId || process.env.CI_JOB_ID || "",
      jobUrl: context.jobUrl || process.env.CI_JOB_URL || "",
    },
    lifecycle: "completed",
    system: {
      name: results?.osName || process.platform,
      version: results?.osVersion || "",
    },
    counts,
    specs,
    tests,
    attachments: [],
    trends: [],
    generatedAt: new Date().toISOString(),
  };
}

function writeJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = {
  SCHEMA_VERSION,
  atomicWriteFile,
  createRunId,
  ensureDir,
  normalizeCypressResults,
  safeFileName,
  stableId,
  writeJson,
};
