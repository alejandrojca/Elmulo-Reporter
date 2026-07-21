const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  buildQualityAnalytics,
  buildHtml,
  buildTrends,
  compareRuns,
  loadAnnotationAudit,
  loadAnnotations,
  loadRunResults,
  loadTestHistory,
  openDatabase,
  persistAnnotation,
  VALID_ANNOTATION_STATUSES,
} = require("./finalize.cjs");
const { atomicWriteFile, writeJson } = require("./core.cjs");
const { buildExecutivePdf } = require("./executive-pdf.cjs");
const { normalizeActor, sanitizeText } = require("./security.cjs");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
};

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function persistDatabase(databasePath, database) {
  atomicWriteFile(databasePath, Buffer.from(database.export()));
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("El seguimiento supera el tamaño permitido."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("El cuerpo de la solicitud no es JSON válido."));
      }
    });
    request.on("error", reject);
  });
}

function safeStaticPath(reportDir, pathname) {
  const relativePath = decodeURIComponent(pathname)
    .replace(/^\/+/, "") || "index.html";
  const candidate = path.resolve(reportDir, relativePath);
  const rootPrefix = `${path.resolve(reportDir)}${path.sep}`;
  return candidate.startsWith(rootPrefix) ? candidate : null;
}

async function serveReport(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.resolve(
    projectRoot,
    options.outputDir || process.env.ELMULO_OUTPUT_DIR || "elmulo-results-v2",
  );
  const reportDir = path.join(outputDir, "report");
  const databasePath = path.join(outputDir, "elmulo.sqlite");
  const dataPath = path.join(reportDir, "data.json");
  const indexPath = path.join(reportDir, "index.html");
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || process.env.ELMULO_PORT || 4178);

  if (!fs.existsSync(indexPath) || !fs.existsSync(dataPath)) {
    throw new Error("No existe un reporte generado. Ejecutá yarn elmulo:generate.");
  }

  let writeQueue = Promise.resolve();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || host}`);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Private-Network": "true",
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        version: "2.0.0-beta.1",
        schemaVersion: 2,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/export/executive.pdf") {
      try {
        const run = JSON.parse(fs.readFileSync(dataPath, "utf8"));
        const pdf = buildExecutivePdf(run);
        const environment = String(run.environment || "ambiente")
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "");
        const runId = String(run.id || "corrida").replace(/[^a-zA-Z0-9_-]/g, "");
        response.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Content-Disposition",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="elmulo-ejecutivo-${environment}-${runId}.pdf"`,
          "Content-Length": pdf.length,
          "Content-Type": "application/pdf",
        });
        response.end(pdf);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/analytics") {
      const environment = String(url.searchParams.get("environment") || "sandbox");
      try {
        const database = await openDatabase(databasePath);
        const analytics = buildQualityAnalytics(database, environment);
        database.close();
        sendJson(response, 200, analytics);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/compare") {
      const base = String(url.searchParams.get("base") || "");
      const target = String(url.searchParams.get("target") || "");
      if (![base, target].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
        sendJson(response, 400, { error: "Corridas inválidas para comparar." });
        return;
      }
      try {
        const database = await openDatabase(databasePath);
        const comparison = compareRuns(database, base, target);
        database.close();
        sendJson(response, 200, comparison);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/audit") {
      const runId = String(url.searchParams.get("runId") || "");
      const testId = String(url.searchParams.get("testId") || "");
      if (![runId, testId].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
        sendJson(response, 400, { error: "Identidad de prueba inválida." });
        return;
      }
      try {
        const database = await openDatabase(databasePath);
        const events = loadAnnotationAudit(database, runId, testId);
        database.close();
        sendJson(response, 200, { events });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/trends") {
      const environment = String(url.searchParams.get("environment") || "")
        .trim()
        .toLowerCase();
      if (!["qa", "sandbox"].includes(environment)) {
        sendJson(response, 400, { error: "Ambiente inválido." });
        return;
      }
      try {
        const database = await openDatabase(databasePath);
        const trends = buildTrends(
          database,
          { environment },
          url.searchParams.get("limit"),
        );
        database.close();
        sendJson(response, 200, trends);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const runId = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
        sendJson(response, 400, { error: "Identificador de corrida inválido." });
        return;
      }
      try {
        const database = await openDatabase(databasePath);
        const runResults = loadRunResults(database, runId);
        database.close();
        if (!runResults) {
          sendJson(response, 404, { error: "Corrida no encontrada." });
          return;
        }
        sendJson(response, 200, runResults);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/test-history") {
      const jiraId = String(url.searchParams.get("jiraId") || "")
        .replace(/^@/, "")
        .toUpperCase();
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(jiraId)) {
        sendJson(response, 400, { error: "Identificador Jira inválido." });
        return;
      }
      try {
        const database = await openDatabase(databasePath);
        const history = loadTestHistory(database, jiraId);
        database.close();
        sendJson(response, 200, { jiraId, history });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/history-annotations") {
      try {
        const body = await readRequestJson(request);
        writeQueue = writeQueue.catch(() => {}).then(async () => {
          const jiraId = String(body.jiraId || "").replace(/^@/, "").toUpperCase();
          if (!/^[A-Z][A-Z0-9]+-\d+$/.test(jiraId)) {
            throw new Error("Identificador Jira inválido.");
          }
          if (!VALID_ANNOTATION_STATUSES.has(body.status)) {
            throw new Error("La clasificación seleccionada no es válida.");
          }

          const activeRun = JSON.parse(fs.readFileSync(dataPath, "utf8"));
          const database = await openDatabase(databasePath);
          const history = loadTestHistory(database, jiraId);
          const target = history.find(
            (entry) =>
              entry.run_id === body.runId && entry.test_id === body.testId,
          );
          if (!target) {
            database.close();
            throw new Error("La ejecución no pertenece al historial Jira indicado.");
          }

          persistAnnotation(database, {
            runId: target.run_id,
            testId: target.test_id,
            status: body.status,
            comment: String(body.comment || "").slice(0, 20_000),
            ticket: String(body.ticket || "").slice(0, 2_000),
            actor: normalizeActor(body.actor),
            source: "history_reuse",
          });
          activeRun.annotations = loadAnnotations(database, activeRun.id);
          activeRun.trends = buildTrends(database, activeRun);
          const updatedHistory = loadTestHistory(database, jiraId);
          persistDatabase(databasePath, database);
          database.close();

          writeJson(dataPath, activeRun);
          fs.writeFileSync(indexPath, buildHtml(activeRun), "utf8");
          return {
            jiraId,
            history: updatedHistory,
            annotations: activeRun.annotations,
            trends: activeRun.trends,
          };
        });
        sendJson(response, 200, await writeQueue);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/annotations") {
      try {
        const body = await readRequestJson(request);
        writeQueue = writeQueue.catch(() => {}).then(async () => {
          const run = JSON.parse(fs.readFileSync(dataPath, "utf8"));
          const test = run.tests.find((candidate) => candidate.id === body.testId);
          if (body.runId !== run.id || !test) {
            throw new Error("La prueba no pertenece al reporte activo.");
          }
          if (!VALID_ANNOTATION_STATUSES.has(body.status)) {
            throw new Error("La clasificación seleccionada no es válida.");
          }

          const database = await openDatabase(databasePath);
          const updatedAt = persistAnnotation(database, {
            runId: run.id,
            testId: test.id,
            status: body.status,
            comment: String(body.comment || "").slice(0, 20_000),
            ticket: String(body.ticket || "").slice(0, 2_000),
            actor: normalizeActor(body.actor),
            source: sanitizeText(body.source || "manual", 80),
          });
          run.annotations = loadAnnotations(database, run.id);
          run.trends = buildTrends(database, run);
          persistDatabase(databasePath, database);
          database.close();

          writeJson(dataPath, run);
          fs.writeFileSync(indexPath, buildHtml(run), "utf8");
          return {
            annotation: run.annotations[test.id],
            annotations: run.annotations,
            trends: run.trends,
            updatedAt,
          };
        });

        sendJson(response, 200, await writeQueue);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/bulk-annotations") {
      try {
        const body = await readRequestJson(request);
        writeQueue = writeQueue.catch(() => {}).then(async () => {
          const run = JSON.parse(fs.readFileSync(dataPath, "utf8"));
          const testIds = [...new Set(Array.isArray(body.testIds) ? body.testIds : [])]
            .filter((id) => run.tests.some((test) => test.id === id))
            .slice(0, 250);
          if (!testIds.length) throw new Error("Seleccioná al menos una prueba.");
          if (!VALID_ANNOTATION_STATUSES.has(body.status)) {
            throw new Error("La clasificación seleccionada no es válida.");
          }
          const database = await openDatabase(databasePath);
          for (const testId of testIds) {
            persistAnnotation(database, {
              runId: run.id,
              testId,
              status: body.status,
              comment: body.comment,
              ticket: body.ticket,
              actor: body.actor,
              source: "bulk",
            });
          }
          run.annotations = loadAnnotations(database, run.id);
          run.trends = buildTrends(database, run);
          persistDatabase(databasePath, database);
          database.close();
          writeJson(dataPath, run);
          fs.writeFileSync(indexPath, buildHtml(run), "utf8");
          return { updated: testIds.length, annotations: run.annotations, trends: run.trends };
        });
        sendJson(response, 200, await writeQueue);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Método no permitido." });
      return;
    }

    const filePath = safeStaticPath(reportDir, url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(response, 404, { error: "Recurso no encontrado." });
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ||
        "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    url: `http://${host}:${port}`,
  };
}

module.exports = { serveReport };
