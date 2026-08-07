const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  baseUrl: "https://prismamediosdepago.atlassian.net",
  projectKey: "FONLP06",
  projectId: "10133",
  issueTypeName: "Error",
  issueTypeId: "10046",
  tipoFieldId: "customfield_10431",
  tipoValueId: "23025",
  tipoValue: "Mantenimiento (IT4IT)",
  severityFieldId: "customfield_10498",
  severityValueId: "25944",
  testTypeFieldId: "customfield_11020",
  automatedTestTypeValueId: "28937",
});

const TIPO_OPTIONS = Object.freeze([
  ["23025", "Mantenimiento (IT4IT)"],
  ["23026", "Evolutivo de Producto"],
  ["23027", "Normativo/Regulatorio/Compliance"],
  ["23028", "Nuevo Producto (VCP)"],
  ["23029", "Tareas Operativas"],
  ["23030", "Incidentes / Problems"],
]);

const SEVERITY_OPTIONS = Object.freeze([
  ["25941", "Urgent"],
  ["25942", "Very High"],
  ["25943", "High"],
  ["25944", "Medium"],
  ["25945", "Low"],
  ["25946", "Blocked"],
]);

function extractCredential(source, name) {
  return String(source || "").match(
    new RegExp(`["']?${name}["']?\\s*:\\s*["']([^"']*)["']`),
  )?.[1] || "";
}

function loadJiraConfig(projectRoot, env = process.env) {
  const credentialsPath = path.resolve(
    env.ELMULO_JIRA_CREDENTIALS_FILE ||
      path.join(projectRoot, "cypress", "config", "jira-credentials.ts"),
  );
  let fileCredentials = {};
  if (fs.existsSync(credentialsPath)) {
    const source = fs.readFileSync(credentialsPath, "utf8");
    fileCredentials = {
      authorization: extractCredential(source, "authorization"),
      cookie: extractCredential(source, "cookie"),
      projectKey: extractCredential(source, "project"),
      projectId: extractCredential(source, "projectId"),
    };
  }

  const email = String(env.ELMULO_JIRA_EMAIL || "").trim();
  const apiToken = String(env.ELMULO_JIRA_API_TOKEN || "").trim();
  const authorization = String(
    env.ELMULO_JIRA_AUTHORIZATION ||
      (email && apiToken
        ? `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`
        : fileCredentials.authorization || ""),
  ).trim();

  return {
    ...DEFAULTS,
    baseUrl: String(env.ELMULO_JIRA_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    projectKey: String(
      env.ELMULO_JIRA_PROJECT || fileCredentials.projectKey || DEFAULTS.projectKey,
    ).trim(),
    projectId: String(
      env.ELMULO_JIRA_PROJECT_ID || fileCredentials.projectId || DEFAULTS.projectId,
    ).trim(),
    issueTypeId: String(env.ELMULO_JIRA_ISSUE_TYPE_ID || DEFAULTS.issueTypeId).trim(),
    issueTypeName: String(
      env.ELMULO_JIRA_ISSUE_TYPE_NAME || DEFAULTS.issueTypeName,
    ).trim(),
    tipoFieldId: String(env.ELMULO_JIRA_TIPO_FIELD_ID || DEFAULTS.tipoFieldId).trim(),
    tipoValueId: String(env.ELMULO_JIRA_TIPO_VALUE_ID || DEFAULTS.tipoValueId).trim(),
    tipoValue: String(env.ELMULO_JIRA_TIPO_VALUE || DEFAULTS.tipoValue).trim(),
    severityFieldId: String(
      env.ELMULO_JIRA_SEVERITY_FIELD_ID || DEFAULTS.severityFieldId,
    ).trim(),
    severityValueId: String(
      env.ELMULO_JIRA_SEVERITY_VALUE_ID || DEFAULTS.severityValueId,
    ).trim(),
    testTypeFieldId: String(
      env.ELMULO_JIRA_TEST_TYPE_FIELD_ID || DEFAULTS.testTypeFieldId,
    ).trim(),
    automatedTestTypeValueId: String(
      env.ELMULO_JIRA_AUTOMATED_TEST_TYPE_VALUE_ID || DEFAULTS.automatedTestTypeValueId,
    ).trim(),
    authorization,
    cookie: String(env.ELMULO_JIRA_COOKIE || fileCredentials.cookie || "").trim(),
    credentialsPath,
    enabled: Boolean(authorization),
  };
}

function firstErrorLine(error = {}) {
  const value = String(error.message || error.stack || error || "").trim();
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() || "Error sin detalle";
}

function normalizeFingerprintPart(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function defectFingerprint(config, test) {
  const source = [
    config.projectKey,
    String(test.spec || "").replaceAll("\\", "/"),
    test.originalTitle || test.title,
    firstErrorLine(test.error),
  ].map(normalizeFingerprintPart).join("|");
  return `elmulo-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
}

function normalizeScenarioTitle(value) {
  return normalizeFingerprintPart(value).replace(/\s+\(example\s+#\d+\)$/, "");
}

function sourceKeywords(projectRoot, test) {
  const specPath = path.resolve(projectRoot, String(test.spec || ""));
  if (!fs.existsSync(specPath)) return [];
  const lines = fs.readFileSync(specPath, "utf8").split(/\r?\n/);
  const target = normalizeScenarioTitle(test.originalTitle || test.title);
  const scenarioPattern = /^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/i;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(scenarioPattern);
    if (match && normalizeScenarioTitle(match[1]) === target) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return [];
  const keywords = [];
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*(?:Scenario(?: Outline)?|Rule|Feature):/i.test(lines[index])) break;
    if (/^\s*Examples:/i.test(lines[index])) break;
    const match = lines[index].match(/^\s*(Given|When|Then|And|But|\*)\s+/i);
    if (match) keywords.push(match[1]);
  }
  return keywords;
}

function buildExecutedGherkin(projectRoot, test) {
  const keywords = sourceKeywords(projectRoot, test);
  const tags = Array.isArray(test.tags) ? test.tags.join(" ") : "";
  const steps = (test.steps || []).filter((step) => step.status !== "skipped");
  return [
    tags,
    `Scenario: ${test.title || test.originalTitle || "Caso sin nombre"}`,
    ...steps.map((step, index) =>
      `  ${keywords[index] || (index === 0 ? "Given" : "And")} ${step.name}`),
  ].filter(Boolean).join("\n");
}

function selectFailureExchange(test) {
  const exchanges = Array.isArray(test.http) ? test.http : [];
  if (!exchanges.length) return null;
  const failedStep = (test.steps || []).find((step) => step.status === "failed");
  if (!failedStep) return exchanges.at(-1);
  const failureTime = Date.parse(failedStep.finishedAt || failedStep.startedAt || "");
  if (!Number.isFinite(failureTime)) return exchanges.at(-1);
  const eligible = exchanges.filter((exchange) => {
    const startedAt = Date.parse(exchange.startedAt || "");
    return Number.isFinite(startedAt) && startedAt <= failureTime;
  });
  return eligible.at(-1) || exchanges.at(-1);
}

function jiraDocument(blocks) {
  return { type: "doc", version: 1, content: blocks };
}

function heading(text, level = 2) {
  return {
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text: String(text) }],
  };
}

function paragraph(text) {
  return {
    type: "paragraph",
    content: String(text || "").split("\n").flatMap((line, index) => [
      ...(index ? [{ type: "hardBreak" }] : []),
      { type: "text", text: line || " " },
    ]),
  };
}

function codeBlock(value, language = "text") {
  return {
    type: "codeBlock",
    attrs: { language },
    content: [{ type: "text", text: String(value || "") }],
  };
}

function prettyJson(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? null, null, 2);
}

function relatedJiraCase(test) {
  return (test.tags || [])
    .map((tag) => String(tag).replace(/^@/, "").toUpperCase())
    .find((tag) => /^[A-Z][A-Z0-9]+-\d+$/.test(tag)) || "";
}

function buildDescription({ config, projectRoot, run, test, comment, previousIssue, draft = {} }) {
  const exchange = selectFailureExchange(test);
  const failedStep = (test.steps || []).find((step) => step.status === "failed");
  const blocks = [
    heading("Caso de prueba"),
    paragraph([
      `Proyecto: ${config.projectKey}`,
      `Feature: ${test.feature || test.titlePath?.[0] || ""}`,
      `Archivo: ${test.spec || ""}`,
      `Caso Xray: ${relatedJiraCase(test) || "Sin vinculación"}`,
      `Ambiente: ${run.environment || "Sin especificar"}`,
      `Fecha de ejecución: ${run.endedAt || run.finishedAt || new Date().toISOString()}`,
    ].join("\n")),
    codeBlock(draft.gherkin ?? buildExecutedGherkin(projectRoot, test), "gherkin"),
    heading("Error final"),
    codeBlock(draft.error ?? String(test.error?.stack || test.error?.message || "Error sin detalle")),
  ];
  if (failedStep) {
    blocks.push(paragraph("Paso que falló:"), codeBlock(
      `${sourceKeywords(projectRoot, test)[failedStep.index] || "Then"} ${failedStep.name}`,
      "gherkin",
    ));
  }
  if (exchange) {
    blocks.push(
      heading("Request asociado a la falla"),
      codeBlock(draft.request ?? prettyJson(exchange.request), "json"),
      heading("Respuesta asociada a la falla"),
      codeBlock(draft.response ?? prettyJson(exchange.response), "json"),
    );
  } else {
    blocks.push(heading("Request y respuesta"), paragraph(
      "Elmulo no registró un intercambio HTTP asociado a esta falla.",
    ));
  }
  blocks.push(heading("Comentario de la falla"), paragraph(comment));
  if (previousIssue) {
    blocks.push(
      heading("Recurrencia"),
      paragraph(
        `Este defecto es una recurrencia de ${previousIssue.key}, actualmente finalizado: ` +
        `${config.baseUrl}/browse/${previousIssue.key}`,
      ),
    );
  }
  return jiraDocument(blocks);
}

function defectSummary(test, recurrence = false) {
  const failedStep = (test.steps || []).find((step) => step.status === "failed");
  const prefix = recurrence ? "[RECURRENCIA]" : "";
  const mtt = (test.tags || []).some((tag) => String(tag).toLowerCase() === "@mtt")
    ? "[MTT]"
    : "[Elmulo]";
  const detail = failedStep
    ? `${test.title}: ${firstErrorLine({ message: failedStep.error || firstErrorLine(test.error) })}`
    : `${test.title}: ${firstErrorLine(test.error)}`;
  return `${prefix}${mtt} ${detail}`.slice(0, 255);
}

function recurrenceComment({ run, test, comment }) {
  const failedStep = (test.steps || []).find((step) => step.status === "failed");
  return jiraDocument([
    heading("Recurrencia detectada por Elmulo", 3),
    paragraph("El error continúa sucediendo."),
    paragraph([
      `Fecha: ${run.endedAt || run.finishedAt || new Date().toISOString()}`,
      `Ambiente: ${run.environment || "Sin especificar"}`,
      `Caso: ${relatedJiraCase(test) || test.title}`,
      `Error: ${failedStep?.error || firstErrorLine(test.error)}`,
      `Comentario: ${comment}`,
    ].join("\n")),
  ]);
}

async function jiraRequest(config, pathname, options = {}) {
  if (!config.enabled) {
    throw new Error(
      `Jira no está configurado. Definí ELMULO_JIRA_EMAIL/ELMULO_JIRA_API_TOKEN ` +
      `o creá ${config.credentialsPath}.`,
    );
  }
  const headers = {
    Accept: "application/json",
    Authorization: config.authorization,
    "Content-Type": "application/json",
    ...(config.cookie ? { Cookie: config.cookie } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${config.baseUrl}${pathname}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const detail = data.errorMessages?.join("; ") ||
      Object.entries(data.errors || {}).map(([field, message]) => `${field}: ${message}`).join("; ") ||
      data.message || `HTTP ${response.status}`;
    throw new Error(`Jira rechazó la operación: ${detail}`);
  }
  return data;
}

async function findMatchingIssues(config, fingerprint) {
  const conditions = [
    `project = "${config.projectKey}"`,
    `issuetype = "${config.issueTypeName}"`,
    `labels = "${fingerprint}"`,
  ].join(" AND ");
  const jql = `${conditions} ORDER BY created DESC`;
  const query = new URLSearchParams({
    jql,
    fields: "summary,status,labels",
    maxResults: "50",
  });
  const data = await jiraRequest(config, `/rest/api/3/search/jql?${query}`);
  return data.issues || [];
}

async function addRecurrenceComment(config, issueKey, context) {
  await jiraRequest(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: JSON.stringify({ body: recurrenceComment(context) }),
  });
}

async function createIssue(config, context, fingerprint, previousIssue) {
  const myself = await jiraRequest(config, "/rest/api/3/myself");
  const data = await jiraRequest(config, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { id: config.projectId },
        issuetype: { id: config.issueTypeId },
        summary: String(
          context.draft?.summary || defectSummary(context.test, Boolean(previousIssue)),
        ).trim().slice(0, 255),
        description: buildDescription({ config, ...context, previousIssue }),
        reporter: { accountId: myself.accountId },
        [config.tipoFieldId]: { id: context.draft.tipoId },
        [config.severityFieldId]: { id: context.draft.severityId },
        [config.testTypeFieldId]: { id: config.automatedTestTypeValueId },
        labels: [fingerprint, "elmulo-reporter"],
      },
    }),
  });
  return { id: data.id, key: data.key };
}

async function reportDefect({ config, projectRoot, run, test, comment, draft = {} }) {
  if (!String(comment || "").trim()) {
    throw new Error("El comentario de la falla es obligatorio.");
  }
  if (test.status !== "failed") {
    throw new Error("Solo se pueden reportar pruebas fallidas.");
  }
  const tipoId = String(draft.tipoId || config.tipoValueId);
  const severityId = String(draft.severityId || config.severityValueId);
  if (!TIPO_OPTIONS.some(([id]) => id === tipoId)) {
    throw new Error("El tipo seleccionado no es válido.");
  }
  if (!SEVERITY_OPTIONS.some(([id]) => id === severityId)) {
    throw new Error("La severidad seleccionada no es válida.");
  }
  const normalizedDraft = {
    summary: String(draft.summary || "").trim().slice(0, 255),
    gherkin: draft.gherkin === undefined
      ? undefined
      : String(draft.gherkin).slice(0, 30_000),
    error: draft.error === undefined
      ? undefined
      : String(draft.error).slice(0, 30_000),
    request: draft.request === undefined
      ? undefined
      : String(draft.request).slice(0, 60_000),
    response: draft.response === undefined
      ? undefined
      : String(draft.response).slice(0, 60_000),
    tipoId,
    severityId,
  };
  const fingerprint = defectFingerprint(config, test);
  const matches = await findMatchingIssues(config, fingerprint);
  const active = matches.find(
    (issue) => issue.fields?.status?.statusCategory?.key !== "done",
  );
  const context = {
    projectRoot,
    run,
    test,
    comment: String(comment).trim(),
    draft: normalizedDraft,
  };
  if (active) {
    await addRecurrenceComment(config, active.key, context);
    return {
      action: "reused",
      fingerprint,
      issueKey: active.key,
      issueUrl: `${config.baseUrl}/browse/${active.key}`,
    };
  }
  const previousIssue = matches[0] || null;
  const created = await createIssue(config, context, fingerprint, previousIssue);
  return {
    action: previousIssue ? "recreated" : "created",
    fingerprint,
    issueKey: created.key,
    issueUrl: `${config.baseUrl}/browse/${created.key}`,
    previousIssueKey: previousIssue?.key || "",
  };
}

module.exports = {
  DEFAULTS,
  SEVERITY_OPTIONS,
  TIPO_OPTIONS,
  buildDescription,
  buildExecutedGherkin,
  defectFingerprint,
  defectSummary,
  firstErrorLine,
  loadJiraConfig,
  reportDefect,
  selectFailureExchange,
  sourceKeywords,
};
