const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function normalizeRerunArgs(value) {
  if (value === undefined || value === null || value === "") return null;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("ELMULO_RERUN_ARGS_JSON debe contener un array JSON válido.");
    }
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error("Los argumentos de reejecución deben ser un array de hasta 100 valores.");
  }
  return parsed.map((argument) => {
    if (!["string", "number", "boolean"].includes(typeof argument)) {
      throw new Error("Cada argumento de reejecución debe ser texto, número o booleano.");
    }
    const normalized = String(argument);
    if (normalized.includes("\0") || normalized.length > 4_000) {
      throw new Error("Un argumento histórico no es seguro para reejecutar.");
    }
    return normalized;
  });
}

function npmCliCandidates(projectRoot, options = {}) {
  const candidates = [
    options.npmCliPath,
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "node_modules", "npm", "bin", "npm-cli.js")
      : "",
  ];
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const npmNames = process.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"];
  for (const pathEntry of pathEntries) {
    for (const npmName of npmNames) {
      const npmPath = path.join(pathEntry, npmName);
      if (!fs.existsSync(npmPath)) continue;
      try {
        const resolved = fs.realpathSync(npmPath);
        if (/npm-cli\.(?:c?js)$/i.test(resolved)) candidates.push(resolved);
      } catch {
        // Ignore broken PATH entries and continue with deterministic candidates.
      }
      candidates.push(
        path.join(path.dirname(npmPath), "node_modules", "npm", "bin", "npm-cli.js"),
      );
    }
  }
  candidates.push(
    path.join(projectRoot, "node_modules", "npm", "bin", "npm-cli.js"),
  );
  return candidates.filter(Boolean);
}

function resolveNpmCli(projectRoot, options = {}) {
  if (options.npmCliPath) {
    const configuredPath = path.resolve(options.npmCliPath);
    if (
      /npm-cli\.(?:c?js)$/i.test(configuredPath) &&
      fs.existsSync(configuredPath) &&
      fs.statSync(configuredPath).isFile()
    ) {
      return configuredPath;
    }
    throw new Error("La ruta configurada para npm-cli.js no es válida.");
  }
  for (const candidate of npmCliCandidates(projectRoot, options)) {
    const resolved = path.resolve(candidate);
    if (
      /npm-cli\.(?:c?js)$/i.test(resolved) &&
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isFile()
    ) {
      return resolved;
    }
  }
  throw new Error(
    "No se encontró npm-cli.js. Iniciá Elmulo desde npm o configurá una instalación válida de npm.",
  );
}

function readPackageScripts(projectRoot) {
  const packagePath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packagePath)) return {};
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
}

function executionScriptFor(run, scripts, configuredScript = "") {
  const environment = String(run.environment || "").trim().toLowerCase();
  const capturedScript = String(run.execution?.script || "").trim();
  const preferredScript = String(capturedScript || configuredScript).trim();

  if (preferredScript) {
    if (!Object.hasOwn(scripts, preferredScript)) {
      throw new Error(
        `El script de reejecución "${preferredScript}" ya no existe en package.json.`,
      );
    }
    return preferredScript;
  }

  if (run.source?.commit === "demo" && Object.hasOwn(scripts, "demo")) {
    return "demo";
  }

  const environmentToken = new RegExp(
    `(^|[-_:])${environment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[-_:])`,
    "i",
  );
  const candidates = Object.keys(scripts).filter(
    (name) => /(^|[-_:])report($|[-_:])/i.test(name) && environmentToken.test(name),
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      "Hay más de un script de reporte compatible. Configurá ELMULO_RERUN_SCRIPT para elegir uno.",
    );
  }
  throw new Error(
    "Esta corrida no registró el script que la originó y no se encontró uno compatible.",
  );
}

function resolveRerunPlan(projectRoot, run, options = {}) {
  const runId = String(run.id || "");
  const environment = String(run.environment || "").trim();
  const tagExpression = String(run.tag_expression ?? run.tagExpression ?? "").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("La corrida histórica no tiene una identidad válida.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(environment)) {
    throw new Error("La corrida histórica no tiene un ambiente reutilizable.");
  }
  if (/[\0\r\n]/.test(tagExpression) || tagExpression.length > 4_000) {
    throw new Error("La expresión de tags histórica no es segura para reejecutar.");
  }

  const scripts = readPackageScripts(projectRoot);
  const script = executionScriptFor(
    run,
    scripts,
    options.configuredScript || process.env.ELMULO_RERUN_SCRIPT,
  );
  const npmCliPath = resolveNpmCli(projectRoot, options);
  const command = process.execPath;
  const args = [npmCliPath, "run", script];
  const historicalArgs = normalizeRerunArgs(run.execution?.args);
  if (historicalArgs !== null) {
    if (historicalArgs.length) args.push("--", ...historicalArgs);
  } else if (tagExpression) {
    args.push("--", tagExpression);
  }

  return {
    command,
    args,
    cwd: projectRoot,
    script,
    rerunArgs: historicalArgs,
    environment,
    tagExpression,
    env: {
      ...process.env,
      CYPRESS_ENVIRONMENT: environment,
      CYPRESS_TAGS: tagExpression,
      ELMULO_RERUN_OF: runId,
    },
  };
}

function publicStatus(status) {
  if (!status) return null;
  return {
    runId: status.runId,
    status: status.status,
    script: status.script,
    environment: status.environment,
    tagExpression: status.tagExpression,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt || null,
    exitCode: status.exitCode ?? null,
    error: status.error || "",
  };
}

function createRerunManager(projectRoot, options = {}) {
  const statuses = new Map();
  let activeRunId = null;
  const spawnProcess = options.spawnProcess || spawn;

  function describe(run) {
    const existing = publicStatus(statuses.get(run.id));
    if (existing) return { available: true, ...existing };
    try {
      const plan = resolveRerunPlan(projectRoot, run, options);
      return {
        available: true,
        runId: run.id,
        status: "idle",
        script: plan.script,
        environment: plan.environment,
        tagExpression: plan.tagExpression,
      };
    } catch (error) {
      return {
        available: false,
        runId: run.id,
        status: "unavailable",
        reason: error.message,
      };
    }
  }

  function start(run) {
    const activeStatus = activeRunId ? statuses.get(activeRunId) : null;
    if (activeStatus && !TERMINAL_STATUSES.has(activeStatus.status)) {
      throw new Error(
        `Ya se está reejecutando la corrida ${activeRunId}. Esperá a que termine.`,
      );
    }

    const plan = resolveRerunPlan(projectRoot, run, options);
    const status = {
      runId: run.id,
      status: "running",
      script: plan.script,
      environment: plan.environment,
      tagExpression: plan.tagExpression,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: "",
    };
    statuses.set(run.id, status);
    activeRunId = run.id;

    let child;
    try {
      child = spawnProcess(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      status.status = "failed";
      status.error = error.message;
      status.finishedAt = new Date().toISOString();
      activeRunId = null;
      throw error;
    }

    child.once("error", (error) => {
      status.status = "failed";
      status.error = error.message;
      status.finishedAt = new Date().toISOString();
      if (activeRunId === run.id) activeRunId = null;
    });
    child.once("exit", (exitCode) => {
      status.exitCode = exitCode;
      status.status = exitCode === 0 ? "completed" : "failed";
      status.error = exitCode === 0
        ? ""
        : `El script de reporte terminó con código ${exitCode}.`;
      status.finishedAt = new Date().toISOString();
      if (activeRunId === run.id) activeRunId = null;
    });

    return publicStatus(status);
  }

  function get(runId) {
    return publicStatus(statuses.get(runId));
  }

  return { describe, get, start };
}

module.exports = {
  createRerunManager,
  executionScriptFor,
  normalizeRerunArgs,
  resolveNpmCli,
  resolveRerunPlan,
};
