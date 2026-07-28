const fs = require("node:fs");
const path = require("node:path");
const {
  createRunId,
  ensureDir,
  normalizeCypressResults,
  safeFileName,
  stableId,
  writeJson,
} = require("./core.cjs");
const {
  isAllowedAttachment,
  sanitizeLogEntry,
  sanitizeText,
} = require("./security.cjs");
const { normalizeRerunArgs } = require("./rerun.cjs");

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function registerElmuloReporter(on, config, options = {}) {
  const captureHttp =
    options.captureHttp !== false &&
    String(process.env.ELMULO_CAPTURE_HTTP || "true").toLowerCase() !== "false";
  config.env = {
    ...(config.env || {}),
    elmulo: true,
    elmuloCaptureHttp: captureHttp,
  };
  const projectRoot = config.projectRoot || process.cwd();
  const outputDir = path.resolve(
    projectRoot,
    options.outputDir || process.env.ELMULO_OUTPUT_DIR || "elmulo-results",
  );
  let session = null;
  const executionScript =
    options.rerunScript ||
    process.env.npm_lifecycle_event ||
    process.env.ELMULO_RERUN_SCRIPT ||
    "";
  const executionArgs = normalizeRerunArgs(
    options.rerunArgs ?? process.env.ELMULO_RERUN_ARGS_JSON,
  );

  function startSession(details = {}) {
    const startedAt = details.startedTestsAt || new Date().toISOString();
    const runId = createRunId(startedAt);
    const runDir = path.join(outputDir, "runs", runId);
    ensureDir(runDir);
    session = { runId, runDir, startedAt };
    writeJson(path.join(runDir, "session.json"), {
      runId,
      startedAt,
      environment:
        options.environment ||
        config.env?.ENVIRONMENT ||
        process.env.CYPRESS_ENVIRONMENT ||
        "unknown",
      tagExpression: config.env?.TAGS || process.env.CYPRESS_TAGS || "",
      lifecycle: "running",
      reporterVersion: "2.0.0-beta.9",
      execution: executionScript
        ? { runner: "npm", script: executionScript, args: executionArgs }
        : null,
    });
    fs.writeFileSync(path.join(outputDir, "latest-run.txt"), runId, "utf8");
    return session;
  }

  on("before:run", (details) => {
    startSession(details);
  });

  on("after:run", (results) => {
    if (!session) startSession(results);

    const normalized = normalizeCypressResults(results, {
      projectRoot,
      runId: session.runId,
      startedAt: session.startedAt,
      environment:
        options.environment ||
        config.env?.ENVIRONMENT ||
        process.env.CYPRESS_ENVIRONMENT ||
        "unknown",
      tagExpression: config.env?.TAGS || process.env.CYPRESS_TAGS || "",
      projectName: config.projectName || "acceptance-tests",
      execution: executionScript
        ? { runner: "npm", script: executionScript, args: executionArgs }
        : null,
    });

    const logManifestPath = path.join(session.runDir, "logs", "manifest.json");
    if (fs.existsSync(logManifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(logManifestPath, "utf8"));
      const logsByTest = new Map(
        manifest.map((entry) => [entry.testKey, entry.logs || []]),
      );

      for (const test of normalized.tests) {
        const exactKey = test.titlePath.join(" › ");
        test.logs =
          logsByTest.get(exactKey) ||
          logsByTest.get(test.title) ||
          [];
      }
    }

    const httpManifestPath = path.join(session.runDir, "http", "manifest.json");
    if (fs.existsSync(httpManifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(httpManifestPath, "utf8"));
      const httpByTest = new Map(
        manifest.map((entry) => [entry.testKey, entry.exchanges || []]),
      );
      for (const test of normalized.tests) {
        const exactKey = test.titlePath.join(" â€º ");
        test.http =
          httpByTest.get(exactKey) ||
          httpByTest.get(test.title) ||
          [];
      }
    }

    const attachmentManifestPath = path.join(
      session.runDir,
      "attachments",
      "manifest.json",
    );
    if (fs.existsSync(attachmentManifestPath)) {
      const manifest = JSON.parse(
        fs.readFileSync(attachmentManifestPath, "utf8"),
      );
      normalized.attachments = manifest;
      const attachmentsByTest = new Map();
      for (const attachment of manifest) {
        if (!attachmentsByTest.has(attachment.testKey)) {
          attachmentsByTest.set(attachment.testKey, []);
        }
        attachmentsByTest.get(attachment.testKey).push(attachment);
      }
      for (const test of normalized.tests) {
        test.attachments =
          attachmentsByTest.get(test.titlePath.join(" › ")) ||
          attachmentsByTest.get(test.title) ||
          [];
      }
    }

    writeJson(path.join(session.runDir, "run.raw.json"), normalized);
    writeJson(path.join(session.runDir, "run.json"), normalized);
    return null;
  });

  on("task", {
    "elmulo:recordLogs"({ testKey, logs }) {
      if (!session) startSession();
      const logsDir = path.join(session.runDir, "logs");
      ensureDir(logsDir);
      const manifestPath = path.join(logsDir, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : [];
      const entry = {
        testKey: String(testKey || ""),
        logs: Array.isArray(logs)
          ? logs.slice(-500).map(sanitizeLogEntry)
          : [],
      };
      const existingIndex = manifest.findIndex(
        (item) => item.testKey === entry.testKey,
      );
      if (existingIndex >= 0) manifest[existingIndex] = entry;
      else manifest.push(entry);
      writeJson(manifestPath, manifest);
      return null;
    },

    "elmulo:recordHttp"({ testKey, exchanges }) {
      if (!session) startSession();
      const httpDir = path.join(session.runDir, "http");
      ensureDir(httpDir);
      const manifestPath = path.join(httpDir, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : [];
      const entry = {
        testKey: String(testKey || ""),
        // Deliberately unredacted: exact values are required for diagnosis.
        exchanges: Array.isArray(exchanges) ? exchanges : [],
      };
      const existingIndex = manifest.findIndex(
        (item) => item.testKey === entry.testKey,
      );
      if (existingIndex >= 0) manifest[existingIndex] = entry;
      else manifest.push(entry);
      writeJson(manifestPath, manifest);
      return null;
    },

    "elmulo:attach"({ testKey, name, mimeType, content, encoding }) {
      if (!session) startSession();
      if (!isAllowedAttachment(mimeType)) {
        throw new Error(`Tipo de adjunto no permitido: ${mimeType}`);
      }
      const attachmentsDir = path.join(session.runDir, "attachments");
      ensureDir(attachmentsDir);
      const id = stableId(testKey, name, Date.now().toString()).slice(0, 12);
      const extension =
        mimeType === "application/json"
          ? ".json"
          : mimeType === "text/plain"
            ? ".txt"
            : "";
      const filename = `${id}-${safeFileName(name)}${extension}`;
      const filePath = path.join(attachmentsDir, filename);
      const serializedContent =
        typeof content === "string"
          ? sanitizeText(content, MAX_ATTACHMENT_BYTES)
          : JSON.stringify(content, null, 2);
      const byteLength = Buffer.byteLength(serializedContent, "utf8");
      if (byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error("El adjunto supera el límite de 5 MB.");
      }
      fs.writeFileSync(
        filePath,
        serializedContent,
        encoding === "base64" ? "base64" : "utf8",
      );

      const manifestPath = path.join(attachmentsDir, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : [];
      const attachment = {
        id,
        testKey: String(testKey || ""),
        name: String(name || "Adjunto"),
        mimeType: mimeType || "text/plain",
        path: `attachments/${filename}`,
      };
      manifest.push(attachment);
      writeJson(manifestPath, manifest);
      return attachment;
    },
  });

  return config;
}

module.exports = { registerElmuloReporter };
