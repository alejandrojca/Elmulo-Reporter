(() => {
  const dataElement = document.getElementById("elmulo-data");
  const run = JSON.parse(dataElement.textContent);
  const app = document.getElementById("app");
  const annotationStorageKey = `elmulo-annotations:${run.id}`;
  const actorStorageKey = "elmulo-v2-actor";
  const preferenceStorageKey = "elmulo-v2-preferences";
  const initialUrlState = new URLSearchParams(window.location.search);
  const initialTrendEnvironment =
    String(run.environment || "").toLowerCase() === "qa" ? "qa" : "sandbox";
  const availableViews = new Set([
    "overview",
    "executions",
    "quality",
    "analysis",
    "tests",
    "preferences",
  ]);
  const initialView = availableViews.has(initialUrlState.get("view"))
    ? initialUrlState.get("view")
    : "overview";

  const customErrorStatuses = {
    environment_error: "Error de ambiente",
    precondition_error: "Error de precondición",
    outdated_test: "Prueba desactualizada",
    reported: "Reportado",
  };
  const editableFailureStatuses = new Set([
    "failed",
    ...Object.keys(customErrorStatuses),
  ]);
  const persistedAnnotationStatuses = new Set([
    "passed",
    "skipped",
    "pending",
    ...editableFailureStatuses,
  ]);
  const otherErrorStatuses = new Set([
    ...Object.keys(customErrorStatuses),
  ]);
  const pdfSections = [
    ["summary", "Resumen ejecutivo", "Indicadores principales y evaluación general.", true],
    ["statusDistribution", "Distribución por estado", "Resultados automáticos y clasificaciones manuales.", true],
    ["runContext", "Contexto de la corrida", "Ambiente, fecha, navegador, tags, rama y pipeline.", false],
    ["features", "Resultados por Feature", "Totales y estados agrupados por Feature.", true],
    ["issues", "Problemas que requieren seguimiento", "Fallos, Jira, comentarios y tickets asociados.", true],
    ["previousComparison", "Comparación con la corrida anterior", "Variaciones de resultados y duración.", false],
    ["recentHistory", "Historial reciente", "Últimas ejecuciones del mismo ambiente.", false],
    ["flaky", "Pruebas inestables", "Casos que pasaron después de uno o más reintentos.", false],
    ["recurrentFailures", "Fallos recurrentes", "Pruebas con fallos repetidos en el historial.", false],
    ["slowTests", "Pruebas más lentas", "Ranking histórico de pruebas por duración.", false],
    ["recommendation", "Recomendación y pendientes", "Evaluación final, fallos sin comentario y sin ticket.", true],
  ];

  function readLocalJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  const preferences = readLocalJson(preferenceStorageKey, {
    density: "comfortable",
    theme: "light",
    sidebarCollapsed: false,
  });

  function loadAnnotations() {
    let localAnnotations = {};
    try {
      const stored = localStorage.getItem(annotationStorageKey);
      const parsed = stored ? JSON.parse(stored) : {};
      localAnnotations = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      localAnnotations = {};
    }

    const annotations = {
      ...localAnnotations,
      ...(run.annotations || {}),
    };
    for (const annotation of Object.values(annotations)) {
      if (annotation?.status === "fix_in_progress") {
        annotation.status = "reported";
      }
    }
    return annotations;
  }

  function persistAnnotationsLocally() {
    try {
      localStorage.setItem(annotationStorageKey, JSON.stringify(state.annotations));
      return true;
    } catch {
      return false;
    }
  }

  async function requestElmuloJson(apiPath, options = {}) {
    const localServerUrl = new URL(apiPath, "http://127.0.0.1:4178").href;
    const currentOriginUrl = new URL(apiPath, window.location.href).href;
    const candidates = [...new Set([currentOriginUrl, localServerUrl])];
    let lastError = null;

    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, options);
        const bodyText = await response.text();
        let result = null;
        try {
          result = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          lastError = new Error(
            `El servidor respondió ${response.status} sin datos válidos de Elmulo.`,
          );
          continue;
        }

        if (!response.ok) {
          throw new Error(result.error || `La consulta respondió ${response.status}.`);
        }
        return result;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      lastError?.message ||
      "No se pudo conectar con Elmulo V2 en http://127.0.0.1:4178.",
    );
  }

  async function persistAnnotation(testId) {
    persistAnnotationsLocally();
    const annotation = state.annotations[testId];
    if (!annotation || location.protocol === "file:") {
      state.persistenceStatus = "local";
      renderSaveStatus();
      return { durable: false };
    }

    try {
      state.persistenceStatus = "saving";
      renderSaveStatus();
      const result = await requestElmuloJson("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: run.id,
          testId,
          status: annotation.status,
          comment: annotation.comment || "",
          ticket: annotation.ticket || "",
          actor: state.actor,
        }),
      });

      state.annotations = result.annotations || state.annotations;
      run.annotations = state.annotations;
      if (state.trendEnvironment === initialTrendEnvironment) {
        run.trends = result.trends || run.trends;
      }
      persistAnnotationsLocally();
      renderSummary();
      renderTrendArea();
      state.persistenceStatus = "saved";
      renderSaveStatus();
      return { durable: true };
    } catch (error) {
      state.persistenceStatus = "error";
      renderSaveStatus(error.message);
      return { durable: false, error: error.message };
    }
  }

  function renderSaveStatus(errorMessage = "") {
    const status = document.getElementById("save-status");
    if (!status) return;
    const content = {
      saved: ["saved", "Guardado en SQLite"],
      saving: ["saving", "Guardando…"],
      local: ["local", "Sólo navegador"],
      error: ["error", "Error al guardar"],
    }[state.persistenceStatus] || ["saved", "Guardado en SQLite"];
    status.className = `saveStatus ${content[0]}`;
    status.textContent = content[1];
    status.title = errorMessage ||
      (state.persistenceStatus === "local"
        ? "Abrí el reporte con Elmulo Serve para guardar en SQLite."
        : "");
  }

  const state = {
    search: initialUrlState.get("q") || "",
    status: initialUrlState.get("status") || "all",
    spec: initialUrlState.get("spec") || "all",
    tag: initialUrlState.get("tag") || "all",
    trendStatus: "total",
    trendEnvironment: initialTrendEnvironment,
    selectedTrendRunId: null,
    historicalRun: null,
    historicalRerun: null,
    historicalStatusFilter: "",
    historyJiraId: null,
    historyTestTitle: "",
    historyCurrentTestId: null,
    historyEnvironment: null,
    selectedHistoryKey: null,
    testHistoryEntries: null,
    testHistoryError: "",
    historyReuseMessage: "",
    debugTestIds: new Set(),
    expandedExampleGroups: new Set(),
    annotations: loadAnnotations(),
    selectedId: initialUrlState.get("test"),
    flaky: initialUrlState.get("flaky") || "all",
    sort: initialUrlState.get("sort") || "severity",
    actor: (() => {
      try {
        return localStorage.getItem(actorStorageKey) || "Usuario local";
      } catch {
        return "Usuario local";
      }
    })(),
    bulkSelected: new Set(),
    analytics: null,
    comparison: null,
    attentionFilter: "",
    qualityTab: "flaky",
    detailTab: "steps",
    trendLimit: Number(initialUrlState.get("runs") || 20),
    persistenceStatus: location.protocol === "file:" ? "local" : "saved",
    density: preferences.density || "comfortable",
    theme: preferences.theme || "light",
    view: initialView,
    sidebarCollapsed: Boolean(preferences.sidebarCollapsed),
  };

  function syncUrlState(push = false) {
    const url = new URL(window.location.href);
    const values = {
      view: state.view === "overview" ? "" : state.view,
      q: state.search,
      status: state.status === "all" ? "" : state.status,
      spec: state.spec === "all" ? "" : state.spec,
      tag: state.tag === "all" ? "" : state.tag,
      flaky: state.flaky === "all" ? "" : state.flaky,
      sort: state.sort === "severity" ? "" : state.sort,
      runs: state.trendLimit === 20 ? "" : state.trendLimit,
      test: state.selectedId || "",
    };
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history[push ? "pushState" : "replaceState"](null, "", url);
  }

  function savePreferences() {
    localStorage.setItem(preferenceStorageKey, JSON.stringify({
      density: state.density,
      theme: state.theme,
      sidebarCollapsed: state.sidebarCollapsed,
    }));
  }

  function applyAppearance() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.density = state.density;
  }

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const formatLogMessage = (value) => {
    const message = String(value ?? "");
    const highlightPattern = /\*\*([\s\S]+?)\*\*/g;
    let formatted = "";
    let lastIndex = 0;
    let match;

    while ((match = highlightPattern.exec(message)) !== null) {
      formatted += escapeHtml(message.slice(lastIndex, match.index));
      formatted += `<strong class="logHighlight">${escapeHtml(match[1])}</strong>`;
      lastIndex = match.index + match[0].length;
    }

    formatted += escapeHtml(message.slice(lastIndex));
    return formatted;
  };

  function stepWordCharacterLimit() {
    if (window.innerWidth <= 520) return 24;
    if (window.innerWidth <= 900) return 32;
    if (window.innerWidth <= 1400) return 44;
    return 56;
  }

  function truncateStepWords(value) {
    const fullText = String(value || "");
    const maximum = stepWordCharacterLimit();
    const text = fullText.replace(/\S+/gu, (word) =>
      word.length > maximum
        ? `${word.slice(0, maximum - 3)}...`
        : word);
    return {
      fullText,
      text,
      truncated: text !== fullText,
    };
  }

  const formatDuration = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds || 0));
    const rounded = (number) =>
      Math.round((number + Number.EPSILON) * 100) / 100;
    if (value < 1000) return `${rounded(value)} ms`;
    const seconds = value / 1000;
    if (seconds < 60) return `${rounded(seconds)} s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${rounded(seconds % 60)}s`;
  };

  const formatDate = (value, compact = false) => {
    if (!value) return "Sin fecha";
    const date = new Date(value);
    return new Intl.DateTimeFormat("es-AR", compact
      ? { day: "2-digit", month: "2-digit" }
      : {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
  };

  const formatTimelineTime = (value) => {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    return new Intl.DateTimeFormat("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
    }).format(new Date(timestamp));
  };

  const statusLabel = {
    passed: "Exitoso",
    failed: "Fallido",
    skipped: "Omitido",
    pending: "Pendiente",
    unknown: "Desconocido",
    ...customErrorStatuses,
  };

  const annotationFor = (test) => state.annotations[test.id] || {};

  const effectiveTestStatus = (test) => {
    const annotatedStatus = annotationFor(test).status;
    return persistedAnnotationStatuses.has(annotatedStatus)
      ? annotatedStatus
      : test.status;
  };

  const unique = (items) => [...new Set(items.filter(Boolean))].sort();
  const specs = unique(run.tests.map((test) => test.spec));
  const tags = unique(run.tests.flatMap((test) => test.tags || []));
  const jiraIdForTest = (test) => {
    for (const tag of test.tags || []) {
      const match = String(tag || "").match(/^@?([A-Z][A-Z0-9]+-\d+)$/i);
      if (match) return match[1].toUpperCase();
    }
    return "";
  };

  const originalTestTitle = (test) =>
    test.originalTitle ||
    String(test.title || "").replace(/\s+\(example\s+#\d+\)\s*$/i, "");

  const testCaseKey = (test) =>
    test.caseId || [test.spec, test.suite, originalTestTitle(test)].join("\u001f");

  function groupTestsByCase(tests) {
    const groups = new Map();

    for (const test of tests) {
      const key = testCaseKey(test);
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          title: originalTestTitle(test),
          spec: test.spec,
          tests: [],
        });
      }
      groups.get(key).tests.push(test);
    }

    return [...groups.values()];
  }

  function aggregateTestStatus(tests) {
    const statuses = tests.map(effectiveTestStatus);
    if (statuses.includes("failed")) return "failed";
    const customStatus = statuses.find((status) => customErrorStatuses[status]);
    if (customStatus) return customStatus;
    if (statuses.includes("pending")) return "pending";
    if (statuses.includes("skipped")) return "skipped";
    if (statuses.every((status) => status === "passed")) return "passed";
    return "unknown";
  }

  function filteredTests() {
    const rawQuery = state.search.trim();
    const tokens = rawQuery.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const operators = {};
    const plainTerms = [];
    for (const token of tokens) {
      const match = token.match(/^(jira|status|tag|ticket|spec):(.+)$/i);
      if (match) operators[match[1].toLowerCase()] = match[2].replaceAll('"', "").toLowerCase();
      else plainTerms.push(token.replaceAll('"', "").toLowerCase());
    }
    const severity = {
      failed: 0,
      reported: 1,
      environment_error: 2,
      precondition_error: 3,
      outdated_test: 4,
      pending: 5,
      skipped: 6,
      passed: 7,
    };
    const filtered = run.tests.filter((test) => {
      const effectiveStatus = effectiveTestStatus(test);
      const annotation = annotationFor(test);
      const jiraId = jiraIdForTest(test).toLowerCase();
      const haystack = [
        test.title,
        originalTestTitle(test),
        test.suite,
        test.spec,
        ...(test.tags || []),
        jiraIdForTest(test),
        annotation.comment,
        annotation.ticket,
      ].join(" ").toLowerCase();
      return (
        plainTerms.every((term) => haystack.includes(term)) &&
        (!operators.jira || jiraId.includes(operators.jira)) &&
        (!operators.status || effectiveStatus.includes(operators.status)) &&
        (!operators.tag || (test.tags || []).some((tag) =>
          tag.toLowerCase().includes(operators.tag))) &&
        (!operators.ticket || String(annotation.ticket || "").toLowerCase()
          .includes(operators.ticket)) &&
        (!operators.spec || test.spec.toLowerCase().includes(operators.spec)) &&
        (state.attentionFilter !== "no_comment" || !annotation.comment) &&
        (state.attentionFilter !== "no_ticket" || !annotation.ticket) &&
        (
          state.status === "all" ||
          effectiveStatus === state.status ||
          (state.status === "other_errors" && otherErrorStatuses.has(effectiveStatus))
        ) &&
        (state.spec === "all" || test.spec === state.spec) &&
        (state.tag === "all" || (test.tags || []).includes(state.tag)) &&
        (state.flaky === "all" ||
          (state.flaky === "yes" && test.flaky) ||
          (state.flaky === "no" && !test.flaky))
      );
    });
    return filtered.sort((left, right) => {
      if (state.sort === "duration") return Number(right.durationMs) - Number(left.durationMs);
      if (state.sort === "name") return originalTestTitle(left)
        .localeCompare(originalTestTitle(right), "es");
      if (state.sort === "history") {
        return Number(right.retries || 0) - Number(left.retries || 0);
      }
      return (severity[effectiveTestStatus(left)] ?? 99) -
        (severity[effectiveTestStatus(right)] ?? 99);
    });
  }

  function renderQualityPanel() {
    if (!state.analytics) {
      return `<div class="analyticsLoading">Consultando indicadores de calidad…</div>`;
    }
    const unstable = state.analytics.unstable || [];
    const recurrent = state.analytics.recurrentFailures || [];
    const slowest = state.analytics.slowest || [];
    const sparkline = (history = []) => {
      const recentHistory = history.slice(0, 5);
      return `<span class="sparkline" aria-label="Últimas ${recentHistory.length} ejecuciones">
      ${recentHistory.map((event) => `<i
        class="${event.flaky ? "flaky" : escapeHtml(event.status)}"
        title="${event.flaky ? "Flaky" : statusLabel[event.status] || event.status}"
      ></i>`).join("")}
    </span>`;
    };
    const datasets = {
      flaky: {
        title: "Pruebas inestables",
        description: "Fallaron en un intento y terminaron exitosas después de un retry.",
        items: unstable,
        metric: (item) => `${item.flaky_runs} corrida${item.flaky_runs === 1 ? "" : "s"} flaky`,
        empty: "No se detectaron pruebas flaky.",
      },
      recurrent: {
        title: "Fallos recurrentes",
        description: "Pruebas que finalizaron fallidas en una o más corridas.",
        items: recurrent,
        metric: (item) => item.sample_sufficient
          ? `${item.failure_rate}% de fallos`
          : `${item.failures} fallo${item.failures === 1 ? "" : "s"} · datos insuficientes`,
        empty: "No hay fallos recurrentes.",
      },
      slow: {
        title: "Pruebas más lentas",
        description: "Promedio histórico de duración por prueba.",
        items: slowest,
        metric: (item) => formatDuration(item.average_duration),
        empty: "No hay información de duración.",
      },
    };
    const selected = datasets[state.qualityTab] || datasets.flaky;
    return `<div class="qualityTabs" role="tablist" aria-label="Indicadores históricos">
      ${Object.entries({
        flaky: `Inestables (${unstable.length})`,
        recurrent: `Fallos recurrentes (${recurrent.length})`,
        slow: "Más lentas",
      }).map(([key, label]) => `<button
        type="button"
        role="tab"
        aria-selected="${state.qualityTab === key}"
        data-quality-tab="${key}"
      >${escapeHtml(label)}</button>`).join("")}
    </div>
    <section class="qualityContent" role="tabpanel">
      <header><h3>${escapeHtml(selected.title)}</h3><p>${escapeHtml(selected.description)}</p></header>
      <div class="qualityList">
        ${selected.items.length
          ? selected.items.slice(0, 10).map((item) => `<article class="qualityRow">
              <span>
                <strong>${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(item.executions)} ejecuciones · ${escapeHtml(item.spec)}</small>
              </span>
              ${sparkline(item.history)}
              <strong class="qualityMetric">${escapeHtml(selected.metric(item))}</strong>
            </article>`).join("")
          : `<div class="emptyState compact"><strong>${escapeHtml(selected.empty)}</strong></div>`}
      </div>
    </section>`;
  }

  function bindQualityEvents() {
    document.querySelectorAll("[data-quality-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.qualityTab = button.dataset.qualityTab;
        const container = document.getElementById("quality-content");
        if (container) container.innerHTML = renderQualityPanel();
        bindQualityEvents();
      });
    });
  }

  async function loadAnalytics() {
    try {
      state.analytics = await requestElmuloJson(
        `/api/analytics?environment=${encodeURIComponent(state.trendEnvironment)}`,
      );
    } catch (error) {
      state.analytics = {
        unstable: [],
        recurrentFailures: [],
        slowest: [],
        error: error.message,
      };
    }
    const container = document.getElementById("quality-content");
    if (container) container.innerHTML = renderQualityPanel();
    bindQualityEvents();
  }

  async function compareSelectedRuns() {
    const base = document.getElementById("compare-base")?.value;
    const target = document.getElementById("compare-target")?.value;
    const output = document.getElementById("comparison-results");
    if (!base || !target || base === target) {
      output.innerHTML = `<div class="modalMessage error">Elegí dos corridas diferentes.</div>`;
      return;
    }
    output.innerHTML = `<div class="analyticsLoading">Comparando corridas…</div>`;
    try {
      state.comparison = await requestElmuloJson(
        `/api/compare?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`,
      );
      const labels = {
        added: "Agregada",
        removed: "Eliminada",
        new_failure: "Nuevo fallo",
        resolved: "Resuelta",
        status_changed: "Cambió de estado",
        slower: "Más lenta",
      };
      const counts = state.comparison.changes.reduce((summary, change) => {
        summary[change.type] = (summary[change.type] || 0) + 1;
        return summary;
      }, {});
      output.innerHTML = state.comparison.changes.length
        ? `<div class="comparisonSummary">
            ${Object.entries(counts).map(([type, count]) => `<button
              type="button"
              data-comparison-filter="${escapeHtml(type)}"
            ><strong>${escapeHtml(count)}</strong><span>${escapeHtml(labels[type] || type)}</span></button>`).join("")}
          </div>
          <div class="comparisonRows">
          ${state.comparison.changes.map((change) => `<article class="comparisonRow ${escapeHtml(change.type)}" data-comparison-type="${escapeHtml(change.type)}">
            <span><strong>${escapeHtml(change.after?.title || change.before?.title)}</strong><small>${escapeHtml(change.after?.spec || change.before?.spec)}</small></span>
            <span>${escapeHtml(labels[change.type] || change.type)}</span>
          </article>`).join("")}
          </div>`
        : `<div class="emptyState"><strong>Sin diferencias relevantes</strong><span>Las corridas seleccionadas son equivalentes.</span></div>`;
      output.querySelectorAll("[data-comparison-filter]").forEach((button) => {
        button.addEventListener("click", () => {
          const type = button.dataset.comparisonFilter;
          output.querySelectorAll("[data-comparison-type]").forEach((row) => {
            row.hidden = row.dataset.comparisonType !== type;
          });
        });
      });
    } catch (error) {
      output.innerHTML = `<div class="modalMessage error">${escapeHtml(error.message)}</div>`;
    }
  }

  async function applyBulkTriage() {
    const tests = run.tests.filter((test) => state.bulkSelected.has(test.id));
    const status = document.getElementById("bulk-status")?.value;
    const feedback = document.getElementById("bulk-feedback");
    if (!tests.length || !status) return;
    document.getElementById("bulk-confirmation-modal")?.close();
    feedback.textContent = "Aplicando clasificación…";
    state.persistenceStatus = "saving";
    renderSaveStatus();
    try {
      const result = await requestElmuloJson("/api/bulk-annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: run.id,
          testIds: tests.map((test) => test.id),
          status,
          comment: document.getElementById("bulk-comment")?.value || "",
          ticket: document.getElementById("bulk-ticket")?.value || "",
          actor: state.actor,
        }),
      });
      state.annotations = result.annotations;
      run.annotations = result.annotations;
      run.trends = result.trends;
      feedback.textContent = `${result.updated} ejecuciones actualizadas.`;
      state.bulkSelected.clear();
      state.persistenceStatus = "saved";
      renderSaveStatus();
      renderList();
      renderTrendArea();
    } catch (error) {
      feedback.textContent = error.message;
      state.persistenceStatus = "error";
      renderSaveStatus(error.message);
    }
  }

  function openBulkConfirmation() {
    const dialog = document.getElementById("bulk-confirmation-modal");
    const count = state.bulkSelected.size;
    const status = document.getElementById("bulk-status")?.value;
    if (!dialog || !count || !status) return;
    dialog.innerHTML = `<div class="confirmationShell">
      <header>
        <div><p class="eyebrow">Confirmar modificación masiva</p><h2>¿Aplicar el cambio a ${count} ${count === 1 ? "ejecución" : "ejecuciones"}?</h2></div>
        <button class="modalCloseButton" type="button" data-close-bulk aria-label="Cerrar">×</button>
      </header>
      <div class="confirmationBody">
        <p>Se aplicará la clasificación <strong>${escapeHtml(statusLabel[status] || status)}</strong> únicamente a las pruebas seleccionadas.</p>
        <p>El cambio quedará registrado con el analista <strong>${escapeHtml(state.actor)}</strong>.</p>
      </div>
      <footer>
        <button class="cancelReuseButton" type="button" data-close-bulk>Cancelar</button>
        <button class="confirmReuseButton" type="button" data-confirm-bulk>Confirmar ${count} ${count === 1 ? "cambio" : "cambios"}</button>
      </footer>
    </div>`;
    dialog.querySelectorAll("[data-close-bulk]").forEach((button) =>
      button.addEventListener("click", () => dialog.close()));
    dialog.querySelector("[data-confirm-bulk]")?.addEventListener("click", applyBulkTriage);
    dialog.showModal();
  }

  function metric(label, value, className = "") {
    return `<article class="metricCard ${className}">
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
    </article>`;
  }

  function failureMetric(total, deltaMarkup, breakdown, className = "") {
    return `<article class="metricCard failed failedBreakdown ${className}">
      <div class="failureMetricTotal">
        <span>Fallidas</span>
        <strong>${escapeHtml(total)}${deltaMarkup}</strong>
      </div>
      <dl class="failureMetricBreakdown" aria-label="Desglose de pruebas fallidas">
        ${breakdown.map(([label, value, status]) => `<div class="${escapeHtml(status)}">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>`).join("")}
      </dl>
    </article>`;
  }

  function summaryMarkup() {
    const effectiveStatuses = run.tests.map(effectiveTestStatus);
    const statusCount = (status) =>
      effectiveStatuses.filter((value) => value === status).length;
    const activeClass = (status, baseClass = status) =>
      `${baseClass} ${state.status === status ? "activeFilter" : ""}`.trim();
    const previousRun = [...(run.trends?.runs || [])]
      .reverse()
      .find((item) => item.id !== run.id);
    const delta = (current, previous) => {
      if (!previousRun || previous == null) return "";
      const difference = Number(current) - Number(previous || 0);
      if (!difference) return '<small class="metricDelta neutral">Sin cambios</small>';
      return `<small class="metricDelta ${difference > 0 ? "up" : "down"}">${difference > 0 ? "+" : ""}${difference} vs. anterior</small>`;
    };
    const passedCount = statusCount("passed");
    const automaticFailures = run.tests.filter((test) => test.status === "failed");
    const failedCount = automaticFailures.length;
    const pendingFailures = automaticFailures.filter((test) =>
      effectiveTestStatus(test) === "failed").length;
    const reportedFailures = automaticFailures.filter((test) =>
      effectiveTestStatus(test) === "reported").length;
    const otherFailures = automaticFailures.filter((test) => {
      const status = effectiveTestStatus(test);
      return otherErrorStatuses.has(status) && status !== "reported";
    }).length;

    return `
      ${metric("Casos", groupTestsByCase(run.tests).length)}
      ${metric("Ejecuciones", run.tests.length)}
      ${metric("Exitosas", `${passedCount}${delta(passedCount, previousRun?.passed)}`, activeClass("passed"))}
      ${failureMetric(
        failedCount,
        delta(failedCount, previousRun?.failed),
        [
          ["Pendientes", pendingFailures, "pending"],
          ["Reportadas", reportedFailures, "reported"],
          ["Otros errores", otherFailures, "otherErrors"],
        ],
        activeClass("failed"),
      )}
      ${metric("Inestables", run.tests.filter((test) => test.flaky).length, "flaky")}
    `;
  }

  function executionStatusChartMarkup() {
    const effectiveStatuses = run.tests.map(effectiveTestStatus);
    const total = effectiveStatuses.length;
    const definitions = [
      ["passed", "Exitosas", "#1a9b78"],
      ["failed", "Fallidas", "#ef4161"],
      ["environment_error", "Error de ambiente", "#f59e0b"],
      ["precondition_error", "Error de precondición", "#ea6b18"],
      ["outdated_test", "Pruebas desactualizadas", "#7c5ce5"],
      ["reported", "Reportadas", "#1e70b8"],
      ["omitted", "Omitidas", "#8da0b3"],
      ["other", "Otros estados", "#53677b"],
    ];
    const knownStatuses = new Set([
      "passed",
      "failed",
      "environment_error",
      "precondition_error",
      "outdated_test",
      "reported",
      "skipped",
      "pending",
    ]);
    const entries = definitions.map(([key, label, color]) => {
      const count = key === "omitted"
        ? effectiveStatuses.filter((status) => ["skipped", "pending"].includes(status)).length
        : key === "other"
          ? effectiveStatuses.filter((status) => !knownStatuses.has(status)).length
          : effectiveStatuses.filter((status) => status === key).length;
      return {
        key,
        label,
        color,
        count,
        percentage: total ? Math.round((count / total) * 1000) / 10 : 0,
      };
    });
    let cursor = 0;
    const segments = entries
      .filter((entry) => entry.count > 0)
      .map((entry) => {
        const start = cursor;
        cursor += (entry.count / total) * 100;
        return `${entry.color} ${start}% ${cursor}%`;
      });
    const gradient = segments.length
      ? `conic-gradient(${segments.join(",")})`
      : "conic-gradient(#d7e0ea 0% 100%)";
    const ariaLabel = [
      `${total} ejecuciones`,
      ...entries.filter((entry) => entry.count > 0)
        .map((entry) => `${entry.label}: ${entry.count}`),
    ].join(". ");

    return `<div class="statusDistributionCopy">
      <p class="eyebrow">Corrida actual</p>
      <h2>Ejecuciones por estado</h2>
      <p>La clasificación manual se refleja junto con el resultado automático.</p>
    </div>
    <div class="statusDonutWrap">
      <div
        class="statusDonut"
        style="--donut-gradient:${gradient}"
        role="img"
        aria-label="${escapeHtml(ariaLabel)}"
      >
        <span><strong>${escapeHtml(total)}</strong><small>Ejecuciones</small></span>
      </div>
    </div>
    <div class="statusDistributionLegend" aria-label="Referencias del gráfico">
      ${entries.map((entry) => `<div class="statusLegendItem ${entry.count ? "" : "empty"}" style="--status-color:${entry.color}">
        <span class="statusLegendDot" aria-hidden="true"></span>
        <span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.percentage)}%</small></span>
        <b>${escapeHtml(entry.count)}</b>
      </div>`).join("")}
    </div>`;
  }

  function renderSummary() {
    const summary = document.getElementById("summary-grid");
    if (summary) summary.innerHTML = summaryMarkup();
    const chart = document.getElementById("execution-status-chart");
    if (chart) chart.innerHTML = executionStatusChartMarkup();
  }

  function featureDistributionMarkup() {
    const definitions = [
      ["passed", "Exitosos"],
      ["failed", "Fallidos"],
      ["environment_error", "Error de ambiente"],
      ["precondition_error", "Error de precondición"],
      ["outdated_test", "Prueba desactualizada"],
      ["reported", "Reportado"],
      ["omitted", "Omitidos"],
      ["other", "Otros"],
    ];
    const knownStatuses = new Set(definitions.slice(0, 6).map(([status]) => status));
    const groups = new Map();
    for (const test of run.tests) {
      const feature = test.feature || test.suite || test.spec?.split("/").at(-1) || "Sin Feature";
      if (!groups.has(feature)) {
        groups.set(feature, {
          feature,
          counts: Object.fromEntries(definitions.map(([status]) => [status, 0])),
          total: 0,
        });
      }
      const group = groups.get(feature);
      const effectiveStatus = effectiveTestStatus(test);
      const status = ["skipped", "pending"].includes(effectiveStatus)
        ? "omitted"
        : knownStatuses.has(effectiveStatus)
          ? effectiveStatus
          : "other";
      group.counts[status] += 1;
      group.total += 1;
    }
    const features = [...groups.values()]
      .sort((left, right) => left.feature.localeCompare(right.feature, "es"));
    const visibleStatuses = definitions.filter(([status]) =>
      features.some((feature) => feature.counts[status] > 0));

    if (!features.length) {
      return `<div class="emptyState compact"><strong>No hay Features disponibles en esta corrida.</strong></div>`;
    }

    return `<div class="featureDistribution">
      <div class="featureLegend" aria-label="Referencias de estados">
        ${visibleStatuses.map(([status, label]) =>
          `<span><i class="${status}" aria-hidden="true"></i>${escapeHtml(label)}</span>`).join("")}
      </div>
      <div class="featureRows">
        ${features.map((feature) => {
          const ariaLabel = visibleStatuses
            .filter(([status]) => feature.counts[status] > 0)
            .map(([status, label]) => `${label}: ${feature.counts[status]}`)
            .join(". ");
          return `<article class="featureRow">
            <strong title="${escapeHtml(feature.feature)}">${escapeHtml(feature.feature)}</strong>
            <div
              class="featureStatusBar"
              role="img"
              aria-label="${escapeHtml(`${feature.feature}. ${ariaLabel}`)}"
            >
              ${visibleStatuses
                .filter(([status]) => feature.counts[status] > 0)
                .map(([status, label]) => `<span
                  class="featureStatusSegment ${status}"
                  style="--feature-count:${feature.counts[status]}"
                  title="${escapeHtml(`${label}: ${feature.counts[status]}`)}"
                >${escapeHtml(feature.counts[status])}</span>`)
                .join("")}
            </div>
          </article>`;
        }).join("")}
      </div>
    </div>`;
  }

  function attentionMarkup() {
    const failed = run.tests.filter((test) => effectiveTestStatus(test) === "failed");
    const flaky = run.tests.filter((test) => test.flaky);
    const withoutComment = failed.filter((test) => !annotationFor(test).comment);
    const withoutTicket = failed.filter((test) => !annotationFor(test).ticket);
    const reported = run.tests.filter((test) => effectiveTestStatus(test) === "reported");
    const cards = [
      ["failed", "Fallos para revisar", failed.length, "Resultado automático fallido"],
      ["flaky", "Pruebas inestables", flaky.length, "Fallaron y pasaron en un retry"],
      ["no_comment", "Sin análisis", withoutComment.length, "Fallos sin comentario"],
      ["no_ticket", "Sin ticket", withoutTicket.length, "Fallos sin bug asociado"],
      ["reported", "Reportadas", reported.length, "Con seguimiento abierto"],
    ];
    return cards.map(([key, label, value, description]) => `<button
      class="attentionCard ${key}"
      type="button"
      data-attention-filter="${key}"
      ${Number(value) === 0 ? "disabled" : ""}
    >
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(description)}</small>
    </button>`).join("");
  }

  function bindAttentionEvents() {
    document.querySelectorAll("[data-attention-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const filter = button.dataset.attentionFilter;
        state.attentionFilter = ["no_comment", "no_ticket"].includes(filter) ? filter : "";
        state.search = "";
        state.flaky = filter === "flaky" ? "yes" : "all";
        state.status = ["failed", "reported"].includes(filter) ? filter : "all";
        if (filter === "no_comment") state.search = "status:failed";
        if (filter === "no_ticket") state.search = "status:failed";
        state.view = "tests";
        syncUrlState();
        render();
        document.querySelector(".resultsLayout")?.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  function renderTrend() {
    const history = run.trends?.runs || [];
    if (!history.length) {
      return `<div class="emptyState"><strong>Primera ejecución</strong><span>Las tendencias aparecerán a partir de la próxima corrida.</span></div>`;
    }
    const trendMetrics = {
      total: {
        label: "Todos",
        axisLabel: "Casos ejecutados",
        className: "total",
        value: (item) => Number(item.total || 0),
      },
      passed: {
        label: "Exitosos",
        axisLabel: "Casos exitosos",
        className: "passed",
        value: (item) => Number(item.passed || 0),
      },
      failed: {
        label: "Fallidos",
        axisLabel: "Casos fallidos",
        className: "failed",
        value: (item) => Number(item.failed || 0),
      },
      environment_error: {
        label: "Errores de ambiente",
        axisLabel: "Errores de ambiente",
        className: "environment_error",
        value: (item) => Number(item.environment_error || 0),
      },
      precondition_error: {
        label: "Errores de precondición",
        axisLabel: "Errores de precondición",
        className: "precondition_error",
        value: (item) => Number(item.precondition_error || 0),
      },
      outdated_test: {
        label: "Pruebas desactualizadas",
        axisLabel: "Pruebas desactualizadas",
        className: "outdated_test",
        value: (item) => Number(item.outdated_test || 0),
      },
      reported: {
        label: "Reportado",
        axisLabel: "Casos reportados",
        className: "reported",
        value: (item) => Number(item.reported || 0),
      },
      success_rate: {
        label: "Tasa de éxito",
        axisLabel: "Porcentaje exitoso",
        className: "passed",
        value: (item) => Number(item.total)
          ? Math.round((Number(item.passed || 0) / Number(item.total)) * 100)
          : 0,
      },
    };
    const selectedMetric = trendMetrics[state.trendStatus] || trendMetrics.total;
    const maxTotal = Math.max(...history.map(selectedMetric.value), 1);
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, maxTotal / 4)));
    const normalizedStep = maxTotal / 4 / magnitude;
    const stepMultiplier =
      normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10;
    const tickStep = Math.max(1, stepMultiplier * magnitude);
    const axisMax = state.trendStatus === "success_rate"
      ? 100
      : Math.max(tickStep, Math.ceil(maxTotal / tickStep) * tickStep);
    const ticks = Array.from(
      { length: Math.floor(axisMax / tickStep) + 1 },
      (_, index) => index * tickStep,
    );
    const canvasWidth = Math.max(520, history.length * 82);

    return `<div class="trendFigure" aria-label="Tendencia de ${escapeHtml(selectedMetric.axisLabel.toLowerCase())} por corrida">
      <div class="trendYAxisTitle">${escapeHtml(selectedMetric.axisLabel)}</div>
      <div class="trendPlot">
        <div class="trendYAxis" aria-hidden="true">
          ${ticks.map((tick) => `<span style="bottom:${30 + (tick / axisMax) * 198}px">${escapeHtml(tick)}</span>`).join("")}
        </div>
        <div class="trendViewport">
          <div class="trendCanvas" style="min-width:${canvasWidth}px">
            ${ticks.map((tick) => `<i class="trendGridLine ${tick === 0 ? "baseline" : ""}" style="bottom:${30 + (tick / axisMax) * 198}px" aria-hidden="true"></i>`).join("")}
            <div class="trendColumns" style="--run-count:${history.length}">
              ${history.map((item) => {
                const total = Number(item.total || 0);
                const selectedValue = selectedMetric.value(item);
                const statusSegments = [
                  ["passed", Number(item.passed || 0)],
                  ["failed", Number(item.failed || 0)],
                  ["environment_error", Number(item.environment_error || 0)],
                  ["precondition_error", Number(item.precondition_error || 0)],
                  ["outdated_test", Number(item.outdated_test || 0)],
                  ["reported", Number(item.reported || 0)],
                ];
                const classified = statusSegments.reduce(
                  (sum, [, value]) => sum + value,
                  0,
                );
                const other = Math.max(0, total - classified);
                const height = selectedValue === 0
                  ? 0
                  : Math.max(4, (selectedValue / axisMax) * 100);
                const percent = (value) => total ? `${(value / total) * 100}%` : "0%";
                const segments = state.trendStatus === "total"
                  ? `${statusSegments
                      .filter(([, value]) => value > 0)
                      .map(([status, value]) =>
                        `<i class="${status}" style="height:${percent(value)}"></i>`)
                      .join("")}
                     ${other > 0 ? `<i class="other" style="height:${percent(other)}"></i>` : ""}`
                  : `<i class="${escapeHtml(selectedMetric.className)}" style="height:100%"></i>`;
                return `<button
                  class="trendColumn ${item.id === state.selectedTrendRunId ? "selected" : ""}"
                  type="button"
                  data-trend-run-id="${escapeHtml(item.id)}"
                  title="${escapeHtml(`${selectedMetric.label}: ${selectedValue}${state.trendStatus === "success_rate" ? "%" : ""} · ${item.total} ejecuciones · ${formatDate(item.started_at)} · ${item.failed || 0} fallidas`)}"
                  aria-label="Consultar corrida del ${escapeHtml(formatDate(item.started_at))}"
                >
                  <span class="trendValue">${escapeHtml(selectedValue)}${state.trendStatus === "success_rate" ? "%" : ""}</span>
                  <div class="trendBarSlot">
                    <div class="trendBar ${selectedValue === 0 ? "empty" : ""}" style="--bar-height:${height}%">
                      ${segments}
                    </div>
                  </div>
                  <small>${escapeHtml(formatDate(item.started_at, true))}</small>
                </button>`;
              }).join("")}
            </div>
          </div>
        </div>
      </div>
      <div class="trendLegend" aria-label="Leyenda de estados">
        ${[
          ["passed", "Exitosos"],
          ["failed", "Fallidos"],
          ["environment_error", "Error de ambiente"],
          ["precondition_error", "Error de precondición"],
          ["outdated_test", "Prueba desactualizada"],
          ["reported", "Reportado"],
        ].map(([status, label]) => `<span><i class="${status}"></i>${label}</span>`).join("")}
      </div>
      <div class="trendXAxisTitle">Corridas</div>
    </div>`;
  }

  function renderHistoricalRun() {
    const historicalRun = state.historicalRun;
    if (!state.selectedTrendRunId) {
      return `<div class="trendHistoryPlaceholder">
        Seleccioná una corrida del gráfico para consultar sus resultados.
      </div>`;
    }
    if (!historicalRun) {
      return `<div class="trendHistoryPlaceholder">Cargando resultados históricos…</div>`;
    }

    const tests = historicalRun.tests || [];
    const historicalStatusOrder = [
      "passed",
      "failed",
      "environment_error",
      "precondition_error",
      "outdated_test",
      "reported",
      "skipped",
      "pending",
      "unknown",
    ];
    const statusCounts = tests.reduce((counts, test) => {
      const status = String(test.status || "unknown");
      counts.set(status, (counts.get(status) || 0) + 1);
      return counts;
    }, new Map());
    const visibleStatuses = [...statusCounts.entries()]
      .sort(([left], [right]) => {
        const leftIndex = historicalStatusOrder.indexOf(left);
        const rightIndex = historicalStatusOrder.indexOf(right);
        return (leftIndex < 0 ? historicalStatusOrder.length : leftIndex) -
          (rightIndex < 0 ? historicalStatusOrder.length : rightIndex);
      });
    if (
      state.historicalStatusFilter &&
      !statusCounts.has(state.historicalStatusFilter)
    ) {
      state.historicalStatusFilter = "";
    }
    const filteredTests = state.historicalStatusFilter
      ? tests.filter((test) => test.status === state.historicalStatusFilter)
      : tests;
    const rerun = state.historicalRerun || historicalRun.rerun || {};
    const rerunBusy = ["starting", "running"].includes(rerun.status);
    const rerunLabel = rerun.status === "starting"
      ? "Iniciando…"
      : rerun.status === "running"
        ? "Reejecutando…"
        : "Reejecutar reporte";
    const rerunFeedback = {
      completed: "La reejecución terminó correctamente. Recargá el dashboard para ver la nueva corrida.",
      failed: rerun.error || "La reejecución no pudo completarse.",
      unavailable: rerun.reason || "Esta corrida no tiene parámetros reutilizables.",
    }[rerun.status] || "";

    return `<section class="trendHistoryPanel">
      <header class="trendHistoryHeader">
        <div>
          <p class="eyebrow">Consulta histórica</p>
          <h3>${escapeHtml(formatDate(historicalRun.started_at))}</h3>
          <p>${escapeHtml(String(historicalRun.environment || "").toUpperCase())} · ${escapeHtml(historicalRun.tag_expression || "Sin filtro de tags")}</p>
        </div>
        <div class="trendHistoryActions">
          <button
            class="rerunReportButton"
            type="button"
            data-rerun-trend-report
            ${rerunBusy || rerun.available === false ? "disabled" : ""}
            title="${escapeHtml(rerun.available === false ? rerun.reason : "Ejecuta nuevamente el mismo script, ambiente y expresión de tags")}"
          >${escapeHtml(rerunLabel)}</button>
          <span class="environmentPill">${escapeHtml(formatDuration(historicalRun.duration_ms))}</span>
          <button
            class="closeHistoryButton"
            type="button"
            data-close-trend-history
            aria-label="Cerrar consulta histórica"
          >×</button>
        </div>
      </header>
      ${rerunFeedback
        ? `<div class="trendRerunFeedback ${rerun.status === "failed" || rerun.status === "unavailable" ? "error" : "success"}" role="status">${escapeHtml(rerunFeedback)}</div>`
        : ""}
      <div class="trendHistoryStats">
        <span class="historicalExecutionCount"><strong>${tests.length}</strong> ejecuciones</span>
        <div class="historicalStatusFilters" aria-label="Filtrar pruebas históricas por estado">
          ${visibleStatuses.map(([status, count]) => `<button
            class="historicalStatusFilter ${escapeHtml(status)} ${state.historicalStatusFilter === status ? "active" : ""}"
            type="button"
            data-historical-status-filter="${escapeHtml(status)}"
            aria-pressed="${state.historicalStatusFilter === status}"
          ><strong>${escapeHtml(count)}</strong> ${escapeHtml(statusLabel[status] || status)}</button>`).join("")}
        </div>
      </div>
      <div class="historicalTestList">
        ${filteredTests.length
          ? filteredTests.map((test) => `<article class="historicalTestRow">
              <span class="statusDot ${escapeHtml(test.status)}" aria-hidden="true"></span>
              <span>
                <strong>${escapeHtml(test.title)}</strong>
                <small>${escapeHtml(test.spec)}</small>
                ${test.comment ? `<small class="historicalNote">${escapeHtml(test.comment)}</small>` : ""}
                ${test.ticket ? `<small class="historicalNote">Ticket: ${escapeHtml(test.ticket)}</small>` : ""}
              </span>
              <span class="historicalTestMeta">
                <span class="statusPill ${escapeHtml(test.status)}">${escapeHtml(statusLabel[test.status] || test.status)}</span>
                <small>${escapeHtml(formatDuration(test.duration_ms))}</small>
              </span>
            </article>`).join("")
          : `<div class="emptyState"><strong>Sin resultados</strong><span>Esta corrida no tiene pruebas registradas.</span></div>`}
      </div>
    </section>`;
  }

  function updateTrendRunCount() {
    const counter = document.getElementById("trend-run-count");
    const count = Number(
      run.trends?.totalRuns ?? run.trends?.runs?.length ?? 0,
    );
    if (counter) {
      counter.textContent = `${count} corrida${count === 1 ? "" : "s"}`;
    }
  }

  function renderTrendArea() {
    const trendContent = document.getElementById("trend-content");
    const trendHistory = document.getElementById("trend-history");
    if (trendContent) trendContent.innerHTML = renderTrend();
    if (trendHistory) trendHistory.innerHTML = renderHistoricalRun();
    updateTrendRunCount();
    bindTrendEvents();
    bindTrendHistoryClose();
  }

  function bindTrendHistoryClose() {
    const closeButton = document.querySelector("[data-close-trend-history]");
    if (!closeButton) return;
    closeButton.addEventListener("click", () => {
      state.selectedTrendRunId = null;
      state.historicalRun = null;
      state.historicalRerun = null;
      state.historicalStatusFilter = "";
      renderTrendArea();
    });
    document.querySelectorAll("[data-historical-status-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const status = button.dataset.historicalStatusFilter;
        state.historicalStatusFilter =
          state.historicalStatusFilter === status ? "" : status;
        renderTrendHistoryPanel();
      });
    });
    document.querySelector("[data-rerun-trend-report]")?.addEventListener(
      "click",
      startHistoricalRerun,
    );
  }

  function renderTrendHistoryPanel() {
    const history = document.getElementById("trend-history");
    if (history) history.innerHTML = renderHistoricalRun();
    bindTrendHistoryClose();
  }

  async function pollHistoricalRerun(runId) {
    window.setTimeout(async () => {
      if (state.selectedTrendRunId !== runId) return;
      try {
        const result = await requestElmuloJson(
          `/api/runs/${encodeURIComponent(runId)}/rerun`,
        );
        if (state.selectedTrendRunId !== runId) return;
        state.historicalRerun = result;
        renderTrendHistoryPanel();
        if (state.historicalRerun.status === "running") {
          pollHistoricalRerun(runId);
        }
      } catch (error) {
        if (state.selectedTrendRunId !== runId) return;
        state.historicalRerun = {
          available: true,
          status: "failed",
          error: error.message,
        };
        renderTrendHistoryPanel();
      }
    }, 2_000);
  }

  async function startHistoricalRerun() {
    const runId = state.selectedTrendRunId;
    if (!runId || !state.historicalRun) return;
    state.historicalRerun = {
      ...(state.historicalRerun || {}),
      available: true,
      status: "starting",
    };
    renderTrendHistoryPanel();
    try {
      const result = await requestElmuloJson(
        `/api/runs/${encodeURIComponent(runId)}/rerun`,
        { method: "POST" },
      );
      if (state.selectedTrendRunId !== runId) return;
      state.historicalRerun = {
        available: true,
        ...result,
      };
      renderTrendHistoryPanel();
      pollHistoricalRerun(runId);
    } catch (error) {
      if (state.selectedTrendRunId !== runId) return;
      state.historicalRerun = {
        available: true,
        status: "failed",
        error: error.message,
      };
      renderTrendHistoryPanel();
    }
  }

  function bindTrendEvents() {
    document.querySelectorAll("[data-trend-run-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const requestedRunId = button.dataset.trendRunId;
        state.selectedTrendRunId = requestedRunId;
        state.historicalRun = null;
        state.historicalRerun = null;
        state.historicalStatusFilter = "";
        renderTrendArea();

        try {
          const result = await requestElmuloJson(
            `/api/runs/${encodeURIComponent(requestedRunId)}`,
          );
          if (state.selectedTrendRunId !== requestedRunId) return;
          state.historicalRun = result;
          state.historicalRerun = result.rerun || null;
          renderTrendHistoryPanel();
          if (state.historicalRerun?.status === "running") {
            pollHistoricalRerun(state.selectedTrendRunId);
          }
        } catch (error) {
          if (state.selectedTrendRunId !== requestedRunId) return;
          const history = document.getElementById("trend-history");
          if (history) {
            history.innerHTML = `<div class="trendHistoryPlaceholder error">${escapeHtml(error.message)}</div>`;
          }
        }
      });
    });
  }

  async function loadTrendEnvironment(environment) {
    state.trendEnvironment = environment;
    state.selectedTrendRunId = null;
    state.historicalRun = null;
    state.historicalRerun = null;
    state.historicalStatusFilter = "";
    const trendContent = document.getElementById("trend-content");
    const trendHistory = document.getElementById("trend-history");
    const trendCounter = document.getElementById("trend-run-count");
    if (trendCounter) trendCounter.textContent = "Consultando…";
    if (trendContent) {
      trendContent.innerHTML = `<div class="trendHistoryPlaceholder">Cargando corridas de ${escapeHtml(environment.toUpperCase())}…</div>`;
    }
    if (trendHistory) trendHistory.innerHTML = "";

    try {
      const result = await requestElmuloJson(
        `/api/trends?environment=${encodeURIComponent(environment)}&limit=${encodeURIComponent(state.trendLimit)}`,
      );
      run.trends = result;
      renderTrendArea();
      loadAnalytics();
    } catch (error) {
      if (trendContent) {
        trendContent.innerHTML = `<div class="trendHistoryPlaceholder error">${escapeHtml(error.message)}</div>`;
      }
      if (trendCounter) trendCounter.textContent = "Sin datos";
    }
  }

  function renderTestRow(test, options = {}) {
    const selected = test.id === state.selectedId ? " selected" : "";
    const exampleClass = options.example ? " exampleRow" : "";
    const effectiveStatus = effectiveTestStatus(test);
    const displayTitle = options.example
      ? `Example ${test.exampleIndex || options.position || ""}`.trim()
      : test.title;
    const resolvedTitle = String(test.title || "").replace(
      /\s+\(example\s+#\d+\)\s*$/i,
      "",
    );
    const subtitle = options.example && resolvedTitle !== originalTestTitle(test)
      ? `${resolvedTitle} · ${test.spec}`
      : test.spec;

    const classification = annotationFor(test).status;
    const sparkline = test.flaky
      ? '<span class="miniSignal flaky" title="Falló y pasó en un retry">Flaky</span>'
      : "";
    return `<div class="testRowContainer ${state.bulkSelected.has(test.id) ? "bulkSelected" : ""}">
      <label class="testSelector" title="Seleccionar para modificación masiva">
        <input type="checkbox" data-select-test="${escapeHtml(test.id)}" ${state.bulkSelected.has(test.id) ? "checked" : ""} />
        <span class="srOnly">Seleccionar ${escapeHtml(displayTitle)}</span>
      </label>
      <button class="testRow${exampleClass}${selected}" data-test-id="${escapeHtml(test.id)}" type="button">
      <span class="statusDot ${escapeHtml(effectiveStatus)} ${test.flaky ? "flaky" : ""}" aria-hidden="true"></span>
      <span>
        <span class="testName">${escapeHtml(displayTitle)}</span>
        <span class="testSpec">${escapeHtml(subtitle)}</span>
        <span class="rowSignals">
          <span class="resultSignal">Resultado: ${escapeHtml(statusLabel[test.status] || test.status)}</span>
          ${classification && classification !== test.status
            ? `<span class="classificationSignal ${escapeHtml(classification)}">Clasificación: ${escapeHtml(statusLabel[classification] || classification)}</span>`
            : ""}
          ${jiraIdForTest(test) ? `<span>${escapeHtml(jiraIdForTest(test))}</span>` : ""}
          ${annotationFor(test).ticket ? `<span>${escapeHtml(annotationFor(test).ticket)}</span>` : ""}
          ${sparkline}
        </span>
        ${effectiveStatus !== test.status
          ? `<span class="inlineStatus ${escapeHtml(effectiveStatus)}">${escapeHtml(statusLabel[effectiveStatus])}</span>`
          : ""}
      </span>
      <span class="testMeta">
        ${escapeHtml(formatDuration(test.durationMs))}
        ${test.retries ? `<br>${test.retries} reintento${test.retries === 1 ? "" : "s"}` : ""}
      </span>
      </button>
    </div>`;
  }

  function renderTestCaseGroup(group) {
    const hasExamples = group.tests.some((test) => test.isExample);
    if (!hasExamples) {
      return renderTestRow(group.tests[0]);
    }

    const expanded = state.expandedExampleGroups.has(group.id);
    const status = aggregateTestStatus(group.tests);
    const flaky = group.tests.some((test) => test.flaky);
    const durationMs = group.tests.reduce(
      (total, test) => total + Number(test.durationMs || 0),
      0,
    );
    const containsSelected = group.tests.some(
      (test) => test.id === state.selectedId,
    );
    const contentId = `examples-${group.id}`;

    return `<section class="testCaseGroup ${containsSelected ? "containsSelected" : ""}">
      <button
        class="testRow testCaseRow"
        data-example-group="${escapeHtml(group.id)}"
        type="button"
        aria-expanded="${expanded}"
        aria-controls="${escapeHtml(contentId)}"
      >
        <span class="groupChevron ${expanded ? "expanded" : ""}" aria-hidden="true">›</span>
        <span>
          <span class="testName">${escapeHtml(group.title)}</span>
          <span class="testSpec">
            <span class="examplesToggleLabel">${expanded ? "Ocultar" : "Mostrar"} ${group.tests.length} examples</span>
            · ${escapeHtml(group.spec)}
          </span>
        </span>
        <span class="testMeta">
          <span class="statusPill ${escapeHtml(status)}">${escapeHtml(statusLabel[status] || status)}</span>
          <br>${escapeHtml(formatDuration(durationMs))}
          ${flaky ? "<br>Inestable" : ""}
        </span>
      </button>
      <div id="${escapeHtml(contentId)}" class="exampleRows" ${expanded ? "" : "hidden"}>
        ${group.tests
          .sort((left, right) =>
            Number(left.exampleIndex || 0) - Number(right.exampleIndex || 0))
          .map((test, index) =>
            renderTestRow(test, { example: true, position: index + 1 }))
          .join("")}
      </div>
    </section>`;
  }

  function buildTimeline(test, includeLogs) {
    const steps = (test.steps || []).map((step, index) => ({
      type: "step",
      timestamp: step.startedAt || "",
      sortTime: Date.parse(step.startedAt || ""),
      order: index * 2,
      value: step,
    }));
    const logs = includeLogs
      ? (test.logs || []).map((log, index) => ({
          type: "log",
          timestamp: log.timestamp || "",
          sortTime: Date.parse(log.timestamp || ""),
          order: index * 2 + 1,
          value: log,
        }))
      : [];
    const fallbackCandidates = [
      ...steps.map((event) => event.sortTime),
      Date.parse(test.attempts?.at(-1)?.startedAt || ""),
    ].filter((timestamp) => Number.isFinite(timestamp));
    const fallbackStart = fallbackCandidates.length
      ? Math.min(...fallbackCandidates)
      : 0;

    return [...steps, ...logs]
      .map((event, index) => ({
        ...event,
        sortTime: Number.isFinite(event.sortTime)
          ? event.sortTime
          : (Number.isFinite(fallbackStart) ? fallbackStart : 0) + index,
      }))
      .sort((left, right) => left.sortTime - right.sortTime || left.order - right.order);
  }

  function renderCucumberTimeline(test) {
    if (!test.steps?.length) return "";
    const debugEnabled = state.debugTestIds.has(test.id);
    const timeline = buildTimeline(test, debugEnabled);

    return `<section class="detailSection">
      <header class="timelineHeader">
        <div>
          <h3>Pasos Cucumber</h3>
          <p>${debugEnabled
            ? `${test.logs?.length || 0} logs intercalados cronológicamente`
            : "Los logs están colapsados"}
          </p>
        </div>
        <button
          class="debugButton ${debugEnabled ? "active" : ""}"
          type="button"
          data-debug-test="${escapeHtml(test.id)}"
          aria-pressed="${debugEnabled}"
          title="${debugEnabled ? "Ocultar logs" : "Mostrar logs entre los steps"}"
        >Debug</button>
      </header>
      <ol class="timelineList">
        ${timeline.map((event) => {
          if (event.type === "log") {
            const log = event.value;
            return `<li class="timelineLog">
              <span class="timelineMarker" aria-hidden="true">›</span>
              <span class="timelineBody">
                <strong>${escapeHtml(log.name)}</strong>
                <span class="logMessage">${formatLogMessage(log.message)}</span>
              </span>
              <time datetime="${escapeHtml(log.timestamp)}">${escapeHtml(formatTimelineTime(log.timestamp))}</time>
            </li>`;
          }

          const step = event.value;
          const stepText = truncateStepWords(step.name);
          return `<li class="step timelineStep">
            <span class="timelineMarker ${escapeHtml(step.status)}" aria-hidden="true"></span>
            <span class="stepKeyword">${escapeHtml(step.keyword)}</span>
            <span class="timelineBody">
              ${stepText.truncated
                ? `<span class="stepText" title="${escapeHtml(stepText.fullText)}"><span aria-hidden="true">${escapeHtml(stepText.text)}</span><span class="srOnly">${escapeHtml(stepText.fullText)}</span></span>`
                : `<span class="stepText">${escapeHtml(stepText.fullText)}</span>`}
              ${step.error ? `<pre>${escapeHtml(step.error)}</pre>` : ""}
            </span>
            <span class="stepStatus ${escapeHtml(step.status)}">${escapeHtml(statusLabel[step.status] || step.status)} · ${escapeHtml(formatDuration(step.durationMs))}</span>
            <time datetime="${escapeHtml(step.startedAt || "")}">${escapeHtml(formatTimelineTime(step.startedAt))}</time>
          </li>`;
        }).join("")}
      </ol>
    </section>`;
  }

  function renderAttempts(test) {
    if (!test.attempts?.length) return "";
    return `<section class="detailSection">
      <h3>Intentos y reintentos</h3>
      <div class="attemptList">
        ${test.attempts.map((attempt) => `<details class="attempt" ${attempt.error ? "open" : ""}>
          <summary>Intento ${attempt.number} · ${escapeHtml(statusLabel[attempt.state] || attempt.state)} · ${escapeHtml(formatDuration(attempt.durationMs))}</summary>
          ${attempt.error ? `<pre>${escapeHtml(attempt.error.stack || attempt.error.message)}</pre>` : "<p>Sin errores.</p>"}
        </details>`).join("")}
      </div>
    </section>`;
  }

  function firstErrorLine(error) {
    const value = String(error?.message || error?.stack || "").trim();
    return value.split(/\r?\n/).find((line) => line.trim())?.trim() || "Error sin detalle.";
  }

  function formatHttpPayload(value) {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value;
      }
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value ?? "");
    }
  }

  function shellQuote(value) {
    return `'${String(value).replaceAll("'", `'"'"'`)}'`;
  }

  function httpHeaders(value) {
    if (Array.isArray(value)) {
      return value.flatMap((header) => {
        if (Array.isArray(header) && header.length >= 2) return [[header[0], header[1]]];
        const separator = String(header).indexOf(":");
        return separator < 0
          ? []
          : [[String(header).slice(0, separator), String(header).slice(separator + 1).trim()]];
      });
    }
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([name, headerValue]) =>
      Array.isArray(headerValue)
        ? headerValue.map((item) => [name, item])
        : [[name, headerValue]]);
  }

  function requestUrl(request) {
    const url = String(request.url || "");
    if (!request.qs || typeof request.qs !== "object") return url;
    try {
      const parsed = new URL(url, window.location.href);
      Object.entries(request.qs).forEach(([name, value]) => {
        const values = Array.isArray(value) ? value : [value];
        values.forEach((item) => parsed.searchParams.append(name, String(item)));
      });
      return parsed.href;
    } catch {
      return url;
    }
  }

  function formatCurlRequest(request) {
    const allowedHeaders = new Map([
      ["content-type", "Content-Type"],
      ["apikey", "apikey"],
      ["x-consumer-username", "X-Consumer-Username"],
    ]);
    const lines = [
      `curl --request ${String(request.method || "GET").toUpperCase()} \\`,
      `  --url ${shellQuote(requestUrl(request))}`,
    ];
    httpHeaders(request.headers)
      .filter(([name]) => allowedHeaders.has(String(name).toLowerCase()))
      .forEach(([name, value]) => {
      const canonicalName = allowedHeaders.get(String(name).toLowerCase());
      lines[lines.length - 1] += " \\";
      lines.push(`  --header ${shellQuote(`${canonicalName}: ${value}`)}`);
    });
    if (request.body !== undefined && request.body !== null && request.body !== "") {
      lines[lines.length - 1] += " \\";
      lines.push(`  --data-raw ${shellQuote(formatHttpPayload(request.body))}`);
    }
    return lines.join("\n");
  }

  function formatHttpResponse(response) {
    return formatHttpPayload(response.body);
  }

  function renderHttpExchanges(test) {
    const exchanges = Array.isArray(test.http) ? test.http : [];
    if (!exchanges.length) {
      return `<section class="detailSection">
        <h3>Intercambio HTTP</h3>
        <p class="httpEmpty">No se registraron requests para esta prueba fallida.</p>
      </section>`;
    }

    return `<section class="detailSection">
      <h3>Request y respuesta</h3>
      <div class="httpExchangeList">
        ${exchanges.map((exchange, index) => {
          const request = exchange?.request || {};
          const response = exchange?.response || {};
          const requestLabel = `${request.method || "HTTP"} ${request.url || ""}`.trim();
          const responseLabel = response.status
            ? `HTTP ${response.status}${response.statusText ? ` · ${response.statusText}` : ""}`
            : "Respuesta sin código HTTP";
          return `<article class="httpExchange">
            <p>Intercambio ${index + 1}</p>
            <details class="httpDisclosure">
              <summary>Request · ${escapeHtml(requestLabel)}</summary>
              <pre>${escapeHtml(formatCurlRequest(request))}</pre>
            </details>
            <details class="httpDisclosure">
              <summary>Respuesta · ${escapeHtml(responseLabel)}</summary>
              <pre>${escapeHtml(formatHttpResponse(response))}</pre>
            </details>
          </article>`;
        }).join("")}
      </div>
    </section>`;
  }

  function renderMedia(test) {
    const screenshots = (test.attempts || []).flatMap((attempt) =>
      (attempt.screenshots || []).filter((item) => item?.available));
    const videos = unique((test.attempts || [])
      .map((attempt) => attempt.video?.available ? attempt.video.reportPath : null));
    if (!screenshots.length && !videos.length) return "";
    return `<section class="detailSection">
      <h3>Evidencias</h3>
      <div class="mediaGrid">
        ${screenshots.map((image) => `<a href="${escapeHtml(image.reportPath)}" target="_blank" rel="noreferrer">
          <img src="${escapeHtml(image.reportPath)}" alt="Captura de ${escapeHtml(test.title)}" loading="lazy" />
        </a>`).join("")}
        ${videos.map((video) => `<video controls preload="metadata">
          <source src="${escapeHtml(video)}" />
        </video>`).join("")}
      </div>
    </section>`;
  }

  function renderAttachments(test) {
    if (!test.attachments?.length) return "";
    return `<section class="detailSection">
      <h3>Adjuntos</h3>
      <div class="attachmentList">
        ${test.attachments.map((attachment) => `<div class="attachment">
          ${attachment.available
            ? `<a href="${escapeHtml(attachment.reportPath)}" target="_blank" rel="noreferrer">${escapeHtml(attachment.name)}</a>`
            : `<strong>${escapeHtml(attachment.name)}</strong>`}
          <span> · ${escapeHtml(attachment.mimeType)}</span>
        </div>`).join("")}
      </div>
    </section>`;
  }

  function renderFailureStatusControl(test) {
    const effectiveStatus = effectiveTestStatus(test);
    if (test.status !== "failed") return "";

    const standardChoices = ["failed", ...Object.keys(customErrorStatuses)];
    const choices = standardChoices.includes(effectiveStatus)
      ? standardChoices
      : [effectiveStatus, ...standardChoices];
    return `<label class="statusEditor">
      <span class="srOnly">Clasificación del resultado</span>
      <select
        class="statusPill statusSelect ${escapeHtml(effectiveStatus)}"
        data-failure-status="${escapeHtml(test.id)}"
        aria-label="Cambiar clasificación del resultado"
      >
        ${choices.map((status) => `<option value="${escapeHtml(status)}" ${status === effectiveStatus ? "selected" : ""}>${escapeHtml(statusLabel[status])}</option>`).join("")}
      </select>
    </label>`;
  }

  function renderFailureReview(test) {
    const effectiveStatus = effectiveTestStatus(test);
    const canReviewFailure =
      test.status === "failed" && editableFailureStatuses.has(effectiveStatus);
    if (!canReviewFailure) return "";

    const annotation = annotationFor(test);
    const durablePersistence = location.protocol !== "file:";
    return `<section class="detailSection failureReview">
      <header class="failureReviewHeader">
        <div>
          <h3>Seguimiento de la falla</h3>
          <p>Explicá el motivo o vinculá el bug reportado.</p>
        </div>
        <span>${durablePersistence ? "Historial SQLite" : "Solo navegador"}</span>
      </header>
      <div class="failureReviewFields">
        <label>
          Comentario
          <textarea
            id="failure-comment-${escapeHtml(test.id)}"
            data-failure-comment
            rows="4"
            placeholder="Contexto del error, análisis o próximos pasos…"
          >${escapeHtml(annotation.comment || "")}</textarea>
        </label>
        <label>
          Ticket / bug report
          <input
            id="failure-ticket-${escapeHtml(test.id)}"
            data-failure-ticket
            type="text"
            value="${escapeHtml(annotation.ticket || "")}"
            placeholder="Ej.: BUG-1234 o URL del ticket"
          />
        </label>
      </div>
      <div class="failureReviewActions">
        <button class="saveReviewButton" type="button" data-save-failure-review>Guardar seguimiento</button>
        ${annotation.ticket
          ? `<a class="jiraDefectLink" href="${escapeHtml(annotation.ticket)}" target="_blank" rel="noreferrer">Abrir bug en Jira</a>`
          : `<button
              class="jiraDefectButton"
              type="button"
              data-create-jira-defect
              ${annotation.comment?.trim() && durablePersistence ? "" : "disabled"}
            >Crear defecto en Jira</button>`}
        <span class="saveFeedback" data-save-feedback aria-live="polite"></span>
      </div>
      ${!durablePersistence
        ? '<p class="jiraDefectHint">Abrí el reporte con Elmulo Serve para crear defectos en Jira.</p>'
        : !annotation.ticket
          ? '<p class="jiraDefectHint">El comentario es obligatorio antes de crear el defecto.</p>'
          : ""}
      ${annotation.updatedAt
        ? `<p class="auditSummary">Último cambio: ${escapeHtml(formatDate(annotation.updatedAt))} · ${escapeHtml(annotation.actor || "Usuario local")} · revisión ${escapeHtml(annotation.revision || 1)}</p>`
        : ""}
      <details class="auditTrail">
        <summary data-load-audit="${escapeHtml(test.id)}">Ver auditoría de cambios</summary>
        <div data-audit-events>Desplegá para consultar el historial inmutable.</div>
      </details>
    </section>`;
  }

  function closeJiraDefectConfirmation() {
    document.getElementById("jira-defect-confirmation-modal")?.remove();
  }

  function openJiraDefectConfirmation(test, comment) {
    closeJiraDefectConfirmation();
    const dialog = document.createElement("dialog");
    dialog.id = "jira-defect-confirmation-modal";
    dialog.className = "reuseConfirmationModal jiraDefectModal";
    dialog.innerHTML = `
      <form method="dialog" class="confirmationShell">
        <header>
          <div>
            <p class="eyebrow">Creación de defecto</p>
            <h2>¿Confirmás el reporte en Jira?</h2>
          </div>
          <button type="button" class="modalCloseButton" data-close-jira-defect aria-label="Cerrar">×</button>
        </header>
        <div class="confirmationBody jiraDefectConfirmationBody">
          <dl>
            <div><dt>Proyecto</dt><dd>FONLP06</dd></div>
            <div><dt>Tipo</dt><dd>Error</dd></div>
            <div><dt>Clasificación</dt><dd>Mantenimiento (IT4IT)</dd></div>
            <div><dt>Escenario</dt><dd>${escapeHtml(test.title)}</dd></div>
            <div><dt>Ambiente</dt><dd>${escapeHtml(run.environment || "Sin especificar")}</dd></div>
          </dl>
          <section>
            <h3>Comentario de la falla</h3>
            <p>${escapeHtml(comment)}</p>
          </section>
          <p class="jiraDefectWarning">Se enviarán a Jira el Gherkin ejecutado, el error final y el request/response asociados a la falla.</p>
          <div class="confirmationFeedback" data-jira-defect-feedback aria-live="polite"></div>
        </div>
        <footer>
          <button type="button" class="secondaryButton" data-close-jira-defect>Cancelar</button>
          <button type="button" class="jiraDefectButton" data-confirm-jira-defect>Crear defecto</button>
        </footer>
      </form>`;
    document.body.appendChild(dialog);
    dialog.querySelectorAll("[data-close-jira-defect]").forEach((button) => {
      button.addEventListener("click", closeJiraDefectConfirmation);
    });
    dialog.querySelector("[data-confirm-jira-defect]")?.addEventListener("click", async () => {
      const confirmButton = dialog.querySelector("[data-confirm-jira-defect]");
      const feedback = dialog.querySelector("[data-jira-defect-feedback]");
      confirmButton.disabled = true;
      feedback.textContent = "Consultando Jira y procesando el defecto…";
      feedback.className = "confirmationFeedback";
      try {
        const result = await requestElmuloJson("/api/jira/defects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: run.id,
            testId: test.id,
            comment,
            actor: state.actor,
          }),
        });
        state.annotations = result.annotations || state.annotations;
        run.annotations = state.annotations;
        run.trends = result.trends || run.trends;
        persistAnnotationsLocally();
        closeJiraDefectConfirmation();
        renderList();
        const detailFeedback = document.querySelector("[data-save-feedback]");
        if (detailFeedback) {
          const actionLabel = {
            created: "Defecto creado",
            recreated: "Recurrencia creada",
            reused: "El defecto existente fue actualizado",
          }[result.action] || "Defecto reportado";
          detailFeedback.textContent = `${actionLabel}: ${result.issueKey}.`;
          detailFeedback.classList.remove("error");
        }
      } catch (error) {
        feedback.textContent = error.message;
        feedback.className = "confirmationFeedback error";
        confirmButton.disabled = false;
      }
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeJiraDefectConfirmation();
    });
    dialog.showModal();
  }

  async function loadAuditTrail(test, container) {
    container.innerHTML = "Consultando auditoría…";
    try {
      const result = await requestElmuloJson(
        `/api/audit?runId=${encodeURIComponent(run.id)}&testId=${encodeURIComponent(test.id)}`,
      );
      container.innerHTML = result.events.length
        ? result.events.map((event) => `<article class="auditEvent">
            <strong>${escapeHtml(statusLabel[event.previous_status] || event.previous_status)} → ${escapeHtml(statusLabel[event.status] || event.status)}</strong>
            <span>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor)} · ${escapeHtml(event.source)}</span>
            ${event.comment ? `<p>${escapeHtml(event.comment)}</p>` : ""}
            ${event.ticket ? `<small>Ticket: ${escapeHtml(event.ticket)}</small>` : ""}
          </article>`).join("")
        : "Todavía no hay cambios manuales.";
    } catch (error) {
      container.textContent = error.message;
    }
  }

  function renderTestHistoryModal() {
    const dialog = document.getElementById("test-history-modal");
    if (!dialog) return;

    const entries = state.testHistoryEntries;
    const currentTest = run.tests.find(
      (test) => test.id === state.historyCurrentTestId,
    );
    const selectedEntry = selectedHistoryEntry();
    const selectedMatchesCurrent = Boolean(
      selectedEntry &&
      currentTest &&
      historicalStateMatchesCurrent(selectedEntry, currentTest),
    );
    const historyEnvironment = normalizeHistoryEnvironment(
      state.historyEnvironment ||
      entries?.[0]?.environment ||
      run.environment,
    );
    const visibleEntries = entries?.filter(
      (entry) =>
        normalizeHistoryEnvironment(entry.environment) === historyEnvironment,
    );
    dialog.innerHTML = `<div class="historyModalShell">
      <header class="historyModalHeader">
        <div>
          <p class="eyebrow">Historial por Jira</p>
          <h2>${escapeHtml(state.historyJiraId || "Prueba")}</h2>
          <p>${escapeHtml(state.historyTestTitle)}</p>
        </div>
        <button class="modalCloseButton" type="button" data-close-test-history aria-label="Cerrar historial">×</button>
      </header>
      <div class="historyModalBody">
        ${entries?.length
          ? `<div class="historyFilterBar">
              <label>
                <span>Ambiente</span>
                <select data-history-environment aria-label="Filtrar historial por ambiente">
                  <option value="qa" ${historyEnvironment === "qa" ? "selected" : ""}>QA</option>
                  <option value="sandbox" ${historyEnvironment === "sandbox" ? "selected" : ""}>Sandbox</option>
                </select>
              </label>
              <span>${escapeHtml(visibleEntries.length)} ejecución${visibleEntries.length === 1 ? "" : "es"}</span>
            </div>`
          : ""}
        ${state.historyReuseMessage
          ? `<div class="modalMessage success">${escapeHtml(state.historyReuseMessage)}</div>`
          : ""}
        ${state.testHistoryError
          ? `<div class="modalMessage error">${escapeHtml(state.testHistoryError)}</div>`
          : entries === null
            ? `<div class="modalMessage">Cargando historial de estados…</div>`
            : entries.length === 0
              ? `<div class="modalMessage">No hay ejecuciones registradas para este ID de Jira.</div>`
              : visibleEntries.length === 0
                ? `<div class="modalMessage">No hay ejecuciones registradas para ${escapeHtml(historyEnvironment.toUpperCase())}.</div>`
                : visibleEntries.map((entry, index) => {
                const entryKey = `${entry.run_id}\u001f${entry.test_id}`;
                const notReusable = Boolean(
                  currentTest && historicalStateMatchesCurrent(entry, currentTest),
                );
                const selected =
                  !notReusable && entryKey === state.selectedHistoryKey;
                const isLatest = index === 0;
                const isCurrent =
                  entry.run_id === run.id &&
                  entry.test_id === state.historyCurrentTestId;
                return `<article
                  class="historyEntry ${selected ? "selected" : ""} ${isLatest ? "latest" : ""} ${isCurrent ? "currentExecution" : ""} ${notReusable ? "notReusable" : ""}"
                  data-history-run="${escapeHtml(entry.run_id)}"
                  data-history-test="${escapeHtml(entry.test_id)}"
                  aria-disabled="${notReusable}"
                >
                  <header>
                    <div class="historyEntryHeading">
                      <label class="historyRadio ${notReusable ? "disabled" : ""}" ${notReusable ? 'title="Esta ejecución ya coincide con el estado actual"' : ""}>
                        <input
                          type="radio"
                          name="jira-history-entry"
                          value="${escapeHtml(entryKey)}"
                          ${selected ? "checked" : ""}
                          ${notReusable ? "disabled" : ""}
                        />
                        <span class="srOnly">${notReusable ? "No se puede reutilizar porque ya coincide con la ejecución actual" : "Seleccionar"} ejecución del ${escapeHtml(formatDate(entry.started_at))}</span>
                      </label>
                      <div>
                        <div class="historyDateLine">
                          <strong>${escapeHtml(formatDate(entry.started_at))}</strong>
                          ${isCurrent
                            ? '<span class="currentExecutionBadge">Ejecución actual</span>'
                            : isLatest
                              ? '<span class="latestExecutionBadge">Última ejecución</span>'
                              : ""}
                        </div>
                        <span>${escapeHtml(entry.title)}</span>
                      </div>
                    </div>
                    <div class="historyExecutionState">
                      <span class="historyEnvironment">${escapeHtml(String(entry.environment || "").toUpperCase())}</span>
                      <span class="statusPill ${escapeHtml(entry.status)}">${escapeHtml(statusLabel[entry.status] || entry.status)}</span>
                    </div>
                  </header>
                  <details class="historyEntryDetails">
                    <summary>Comentario y ticket / bug reportado</summary>
                    <dl>
                      <div>
                        <dt>Comentario</dt>
                        <dd>${entry.comment ? escapeHtml(entry.comment) : "Sin comentario."}</dd>
                      </div>
                      <div>
                        <dt>Ticket / bug reportado</dt>
                        <dd>${entry.ticket ? escapeHtml(entry.ticket) : "Sin ticket asociado."}</dd>
                      </div>
                    </dl>
                  </details>
                  <footer>
                    <span>${escapeHtml(formatDuration(entry.duration_ms))} · ${escapeHtml(entry.spec)}</span>
                  </footer>
                  <div class="historyEntryFeedback" data-history-feedback aria-live="polite"></div>
                </article>`;
              }).join("")}
      </div>
      ${visibleEntries?.length
        ? `<footer class="historyModalFooter">
            <span data-history-selection-label>${state.selectedHistoryKey
              ? selectedMatchesCurrent
                ? "El estado, comentario y ticket ya coinciden con la ejecución actual"
                : "1 ejecución seleccionada"
              : "Seleccioná una ejecución para reutilizar su estado"}</span>
            <button
              class="reuseStateButton"
              type="button"
              data-open-reuse-confirmation
              ${state.selectedHistoryKey && !selectedMatchesCurrent ? "" : "disabled"}
            >Reutilizar estado</button>
          </footer>`
        : ""}
    </div>`;

    dialog.querySelector("[data-close-test-history]")?.addEventListener("click", () => {
      dialog.close();
    });
    dialog.querySelector("[data-history-environment]")?.addEventListener(
      "change",
      (event) => {
        state.historyEnvironment = normalizeHistoryEnvironment(event.target.value);
        state.selectedHistoryKey = null;
        renderTestHistoryModal();
      },
    );
    dialog.querySelectorAll('input[name="jira-history-entry"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        state.selectedHistoryKey = radio.value;
        dialog.querySelectorAll(".historyEntry").forEach((entryElement) => {
          const key =
            `${entryElement.dataset.historyRun}\u001f${entryElement.dataset.historyTest}`;
          entryElement.classList.toggle("selected", key === state.selectedHistoryKey);
        });
        const actionButton = dialog.querySelector("[data-open-reuse-confirmation]");
        const selectionLabel = dialog.querySelector("[data-history-selection-label]");
        const entry = selectedHistoryEntry();
        const test = run.tests.find(
          (candidate) => candidate.id === state.historyCurrentTestId,
        );
        const unchanged = Boolean(
          entry && test && historicalStateMatchesCurrent(entry, test),
        );
        if (actionButton) actionButton.disabled = !entry || !test || unchanged;
        if (selectionLabel) {
          selectionLabel.textContent = unchanged
            ? "El estado, comentario y ticket ya coinciden con la ejecución actual"
            : "1 ejecución seleccionada";
        }
      });
    });
    dialog.querySelector("[data-open-reuse-confirmation]")?.addEventListener(
      "click",
      openReuseConfirmation,
    );
  }

  function selectedHistoryEntry() {
    return (state.testHistoryEntries || []).find(
      (entry) => `${entry.run_id}\u001f${entry.test_id}` === state.selectedHistoryKey,
    );
  }

  function normalizeHistoryEnvironment(value) {
    return String(value || "").toLowerCase() === "qa" ? "qa" : "sandbox";
  }

  function normalizedHistoricalValue(value) {
    return String(value || "").trim();
  }

  function historicalStateMatchesCurrent(entry, currentTest) {
    const annotation = annotationFor(currentTest);
    return entry.status === effectiveTestStatus(currentTest) &&
      normalizedHistoricalValue(entry.comment) ===
        normalizedHistoricalValue(annotation.comment) &&
      normalizedHistoricalValue(entry.ticket) ===
        normalizedHistoricalValue(annotation.ticket);
  }

  function openReuseConfirmation() {
    const entry = selectedHistoryEntry();
    const currentTest = run.tests.find(
      (test) => test.id === state.historyCurrentTestId,
    );
    if (!entry || !currentTest) return;
    if (historicalStateMatchesCurrent(entry, currentTest)) {
      renderTestHistoryModal();
      return;
    }

    const currentStatus = effectiveTestStatus(currentTest);
    const confirmationDialog = document.getElementById("reuse-confirmation-modal");
    confirmationDialog.innerHTML = `<div class="confirmationShell">
      <header>
        <div>
          <p class="eyebrow">Confirmar reutilización</p>
          <h2>¿Aplicar este estado histórico?</h2>
        </div>
        <button class="modalCloseButton" type="button" data-cancel-reuse aria-label="Cancelar">×</button>
      </header>
      <div class="confirmationBody">
        <p>Se reemplazarán el estado, comentario y ticket de la ejecución actual.</p>
        <div class="statusComparison">
          <article>
            <span>Estado actual</span>
            <strong class="statusPill ${escapeHtml(currentStatus)}">${escapeHtml(statusLabel[currentStatus] || currentStatus)}</strong>
          </article>
          <span class="comparisonArrow" aria-hidden="true">→</span>
          <article>
            <span>Estado histórico</span>
            <strong class="statusPill ${escapeHtml(entry.status)}">${escapeHtml(statusLabel[entry.status] || entry.status)}</strong>
            <small>${escapeHtml(formatDate(entry.started_at))} · ${escapeHtml(String(entry.environment || "").toUpperCase())}</small>
          </article>
        </div>
        <div class="confirmationMetadata">
          <div><strong>Comentario</strong><span>${entry.comment ? escapeHtml(entry.comment) : "Sin comentario."}</span></div>
          <div><strong>Ticket / bug reportado</strong><span>${entry.ticket ? escapeHtml(entry.ticket) : "Sin ticket asociado."}</span></div>
        </div>
        <div class="confirmationFeedback" data-confirmation-feedback aria-live="polite"></div>
      </div>
      <footer>
        <button class="cancelReuseButton" type="button" data-cancel-reuse>Cancelar</button>
        <button class="confirmReuseButton" type="button" data-confirm-reuse>Confirmar cambio</button>
      </footer>
    </div>`;

    const historyDialog = document.getElementById("test-history-modal");
    historyDialog.close();
    confirmationDialog.showModal();
    confirmationDialog.querySelectorAll("[data-cancel-reuse]").forEach((button) => {
      button.addEventListener("click", () => {
        confirmationDialog.close();
        historyDialog.showModal();
      });
    });
    confirmationDialog.querySelector("[data-confirm-reuse]")?.addEventListener(
      "click",
      () => applySelectedHistoricalState(entry, currentTest),
    );
  }

  async function applySelectedHistoricalState(entry, currentTest) {
    if (historicalStateMatchesCurrent(entry, currentTest)) {
      renderTestHistoryModal();
      return;
    }
    const confirmationDialog = document.getElementById("reuse-confirmation-modal");
    const confirmButton = confirmationDialog.querySelector("[data-confirm-reuse]");
    const feedback = confirmationDialog.querySelector("[data-confirmation-feedback]");
    confirmButton.disabled = true;
    if (feedback) feedback.textContent = "Aplicando estado histórico…";

    const previousAnnotation = state.annotations[currentTest.id]
      ? { ...state.annotations[currentTest.id] }
      : null;
    state.annotations[currentTest.id] = {
      ...annotationFor(currentTest),
      status: entry.status,
      comment: entry.comment || "",
      ticket: entry.ticket || "",
      updatedAt: new Date().toISOString(),
    };
    const result = await persistAnnotation(currentTest.id);
    if (!result.durable) {
      if (previousAnnotation) {
        state.annotations[currentTest.id] = previousAnnotation;
      } else {
        delete state.annotations[currentTest.id];
      }
      persistAnnotationsLocally();
      if (feedback) {
        feedback.textContent = result.error || "No se pudo guardar el cambio en SQLite.";
        feedback.classList.add("error");
      }
      confirmButton.disabled = false;
      return;
    }

    state.historyReuseMessage =
      `Se aplicó el estado ${statusLabel[entry.status] || entry.status} a la ejecución actual.`;
    state.selectedHistoryKey = null;
    const historyResult = await requestElmuloJson(
      `/api/test-history?jiraId=${encodeURIComponent(state.historyJiraId)}`,
    );
    state.testHistoryEntries = historyResult.history || [];
    renderList();
    renderTestHistoryModal();
    confirmationDialog.close();
    document.getElementById("test-history-modal").showModal();
  }

  async function openTestHistory(test) {
    const jiraId = jiraIdForTest(test);
    if (!jiraId) return;
    state.historyJiraId = jiraId;
    state.historyTestTitle = originalTestTitle(test);
    state.historyCurrentTestId = test.id;
    state.historyEnvironment = null;
    state.selectedHistoryKey = null;
    state.testHistoryEntries = null;
    state.testHistoryError = "";
    state.historyReuseMessage = "";

    const dialog = document.getElementById("test-history-modal");
    renderTestHistoryModal();
    if (!dialog.open) dialog.showModal();

    try {
      const result = await requestElmuloJson(
        `/api/test-history?jiraId=${encodeURIComponent(jiraId)}`,
      );
      state.testHistoryEntries = result.history || [];
      state.historyEnvironment = normalizeHistoryEnvironment(
        state.testHistoryEntries[0]?.environment || run.environment,
      );
    } catch (error) {
      state.testHistoryEntries = [];
      state.testHistoryError = error.message;
    }
    renderTestHistoryModal();
  }

  function renderDetail(test) {
    const detail = document.getElementById("test-detail");
    if (!test) {
      detail.innerHTML = `<div class="emptyState"><strong>Sin selección</strong><span>Elegí una prueba para ver sus detalles.</span></div>`;
      return;
    }
    detail.innerHTML = `
      <header class="detailHeader">
        <div>
          <p class="eyebrow">${escapeHtml(test.feature || test.suite || "Prueba")}</p>
          <h2>${escapeHtml(test.title)}</h2>
          <p class="testSpec">${escapeHtml(test.spec)}</p>
        </div>
        <div class="detailStatusColumn">
          <span class="statusPairLabel">Resultado automático</span>
          <span class="statusPill ${escapeHtml(test.status)}">${escapeHtml(statusLabel[test.status] || test.status)}</span>
          ${test.status === "failed"
            ? `<span class="statusPairLabel">Clasificación manual</span>${renderFailureStatusControl(test)}`
            : ""}
          ${jiraIdForTest(test)
            ? `<button class="jiraHistoryButton" type="button" data-test-history="${escapeHtml(test.id)}">Ver historial · ${escapeHtml(jiraIdForTest(test))}</button>`
            : ""}
        </div>
      </header>
      <div>
        ${(test.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
        ${test.flaky ? '<span class="tag">⚠ Inestable</span>' : ""}
      </div>
      <nav class="detailTabs" role="tablist" aria-label="Detalle de la prueba">
        ${[
          ["steps", "Pasos"],
          ["error", "Error"],
          ["attempts", "Intentos"],
          ["evidence", "Evidencias"],
          ["history", "Historial"],
        ].map(([key, label]) => `<button
          type="button"
          role="tab"
          aria-selected="${state.detailTab === key}"
          data-detail-tab="${key}"
        >${label}</button>`).join("")}
      </nav>
      <div class="detailTabPanel" role="tabpanel">
        ${state.detailTab === "steps"
          ? renderCucumberTimeline(test) ||
            '<div class="emptyState compact"><strong>Sin pasos Cucumber registrados.</strong></div>'
          : ""}
        ${state.detailTab === "error"
          ? `${test.error
              ? `<section class="detailSection"><h3>Error final</h3><pre>${escapeHtml(firstErrorLine(test.error))}</pre></section>`
              : '<div class="emptyState compact"><strong>Esta ejecución no tiene un error final.</strong></div>'}
             ${test.status === "failed" ? renderHttpExchanges(test) : ""}
             ${renderFailureReview(test)}`
          : ""}
        ${state.detailTab === "attempts" ? renderAttempts(test) : ""}
        ${state.detailTab === "evidence"
          ? `${renderMedia(test)}${renderAttachments(test)}` ||
            '<div class="emptyState compact"><strong>Sin evidencias disponibles.</strong></div>'
          : ""}
        ${state.detailTab === "history"
          ? `<section class="detailSection">
              <h3>Historial y auditoría</h3>
              ${jiraIdForTest(test)
                ? `<button class="jiraHistoryButton" type="button" data-test-history="${escapeHtml(test.id)}">Abrir historial · ${escapeHtml(jiraIdForTest(test))}</button>`
                : "<p>La prueba no tiene un tag Jira asociado.</p>"}
              <details class="auditTrail">
                <summary data-load-audit="${escapeHtml(test.id)}">Auditoría de cambios manuales</summary>
                <div data-audit-events>Desplegá para consultar el historial inmutable.</div>
              </details>
            </section>`
          : ""}
      </div>
    `;

    const debugButton = detail.querySelector("[data-debug-test]");
    if (debugButton) {
      debugButton.addEventListener("click", () => {
        if (state.debugTestIds.has(test.id)) {
          state.debugTestIds.delete(test.id);
        } else {
          state.debugTestIds.add(test.id);
        }
        renderDetail(test);
      });
    }

    detail.querySelectorAll("[data-test-history]").forEach((button) => {
      button.addEventListener("click", () => {
        openTestHistory(test);
      });
    });
    detail.querySelectorAll("[data-detail-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.detailTab = button.dataset.detailTab;
        renderDetail(test);
      });
    });

    const statusSelect = detail.querySelector("[data-failure-status]");
    if (statusSelect) {
      statusSelect.addEventListener("change", async (event) => {
        const status = event.target.value;
        if (!editableFailureStatuses.has(status)) return;
        statusSelect.disabled = true;
        state.annotations[test.id] = {
          ...annotationFor(test),
          status,
          updatedAt: new Date().toISOString(),
        };
        const result = await persistAnnotation(test.id);
        renderList();
        const feedback = document.querySelector("[data-save-feedback]");
        if (feedback && (!result.durable || result.error)) {
          feedback.textContent = result.error
            ? `No se pudo guardar en SQLite: ${result.error}`
            : "Guardado solo en este navegador. Abrí el reporte con Elmulo Serve para persistirlo.";
          feedback.classList.add("error");
        }
      });
    }

    const saveReviewButton = detail.querySelector("[data-save-failure-review]");
    const failureComment = detail.querySelector("[data-failure-comment]");
    const createJiraDefectButton = detail.querySelector("[data-create-jira-defect]");
    if (failureComment && createJiraDefectButton) {
      const syncJiraButton = () => {
        createJiraDefectButton.disabled =
          !failureComment.value.trim() || location.protocol === "file:";
      };
      failureComment.addEventListener("input", syncJiraButton);
      createJiraDefectButton.addEventListener("click", () => {
        const comment = failureComment.value.trim();
        if (!comment) {
          syncJiraButton();
          return;
        }
        openJiraDefectConfirmation(test, comment);
      });
      syncJiraButton();
    }
    if (saveReviewButton) {
      saveReviewButton.addEventListener("click", async () => {
        const comment = detail.querySelector("[data-failure-comment]")?.value.trim() || "";
        const ticket = detail.querySelector("[data-failure-ticket]")?.value.trim() || "";
        saveReviewButton.disabled = true;
        state.annotations[test.id] = {
          ...annotationFor(test),
          status: effectiveTestStatus(test),
          comment,
          ticket,
          updatedAt: new Date().toISOString(),
        };
        const result = await persistAnnotation(test.id);
        const feedback = detail.querySelector("[data-save-feedback]");
        if (feedback) {
          feedback.textContent = result.durable
            ? "Seguimiento guardado en SQLite."
            : result.error
              ? `No se pudo guardar en SQLite: ${result.error}`
              : "Guardado solo en este navegador. Abrí el reporte con Elmulo Serve para persistirlo.";
          feedback.classList.toggle("error", !result.durable);
        }
        saveReviewButton.disabled = false;
      });
    }
    const auditDetails = detail.querySelector(".auditTrail");
    auditDetails?.addEventListener("toggle", () => {
      if (auditDetails.open && !auditDetails.dataset.loaded) {
        auditDetails.dataset.loaded = "true";
        loadAuditTrail(test, auditDetails.querySelector("[data-audit-events]"));
      }
    });
  }

  function renderList() {
    renderSummary();
    const tests = filteredTests();
    const visibleGroups = groupTestsByCase(tests);
    const allGroups = groupTestsByCase(run.tests);
    const rows = document.getElementById("test-rows");
    const count = document.getElementById("visible-count");
    const selectedCount = document.getElementById("selected-count");
    const bulkButton = document.getElementById("apply-bulk");
    count.textContent =
      `${visibleGroups.length} de ${allGroups.length} casos de prueba · ` +
      `${tests.length} de ${run.tests.length} ejecuciones`;
    if (selectedCount) {
      selectedCount.textContent = `${state.bulkSelected.size} seleccionada${state.bulkSelected.size === 1 ? "" : "s"}`;
    }
    if (bulkButton) bulkButton.disabled = state.bulkSelected.size === 0;
    rows.innerHTML = visibleGroups.length
      ? visibleGroups.map(renderTestCaseGroup).join("")
      : `<div class="emptyState"><strong>No encontramos resultados</strong><span>Probá modificando los filtros.</span></div>`;

    if (state.selectedId && !tests.some((test) => test.id === state.selectedId)) {
      state.selectedId = null;
      syncUrlState();
    }
    renderDetail(run.tests.find((test) => test.id === state.selectedId));

    rows.querySelectorAll("[data-test-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedId = button.dataset.testId;
        syncUrlState();
        renderList();
      });
    });

    rows.querySelectorAll("[data-example-group]").forEach((button) => {
      button.addEventListener("click", () => {
        const groupId = button.dataset.exampleGroup;
        if (state.expandedExampleGroups.has(groupId)) {
          state.expandedExampleGroups.delete(groupId);
        } else {
          state.expandedExampleGroups.add(groupId);
        }
        renderList();
      });
    });
    rows.querySelectorAll("[data-select-test]").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.bulkSelected.add(checkbox.dataset.selectTest);
        else state.bulkSelected.delete(checkbox.dataset.selectTest);
        renderList();
      });
    });
    const selectVisible = document.getElementById("select-visible");
    if (selectVisible) {
      selectVisible.checked = tests.length > 0 &&
        tests.every((test) => state.bulkSelected.has(test.id));
      selectVisible.indeterminate = tests.some((test) =>
        state.bulkSelected.has(test.id)) && !selectVisible.checked;
    }
  }

  function activeFilterChips() {
    const labels = {
      status: statusLabel[state.status] || (state.status === "other_errors" ? "Otros errores" : state.status),
      spec: state.spec.split("/").at(-1),
      tag: state.tag,
      flaky: state.flaky === "yes" ? "Sólo inestables" : "Excluir inestables",
      search: state.search,
    };
    const active = [
      state.search ? ["search", `Búsqueda: ${labels.search}`] : null,
      state.status !== "all" ? ["status", labels.status] : null,
      state.spec !== "all" ? ["spec", labels.spec] : null,
      state.tag !== "all" ? ["tag", labels.tag] : null,
      state.flaky !== "all" ? ["flaky", labels.flaky] : null,
    ].filter(Boolean);
    if (!active.length) return '<span class="noFilters">Sin filtros activos</span>';
    return `${active.map(([key, label]) => `<button type="button" data-remove-filter="${key}">${escapeHtml(label)} <span aria-hidden="true">×</span></button>`).join("")}
      <button class="clearFilters" type="button" data-clear-filters>Limpiar filtros</button>`;
  }

  function bindFilterChipEvents() {
    document.querySelectorAll("[data-remove-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.removeFilter;
        if (key === "search") state.search = "";
        else state[key] = "all";
        syncUrlState();
        render();
      });
    });
    document.querySelector("[data-clear-filters]")?.addEventListener("click", clearFilters);
  }

  function clearFilters() {
    Object.assign(state, {
      search: "",
      status: "all",
      spec: "all",
      tag: "all",
      flaky: "all",
      attentionFilter: "",
    });
    syncUrlState();
    render();
  }

  function filterDropdownMarkup(id, label, options, selectedValue, help = "") {
    const selected = options.find(([value]) => value === selectedValue) || options[0];
    return `<div class="field">
      <span id="${id}-label" class="filterFieldLabel">${escapeHtml(label)}${help}</span>
      <div class="filterDropdown" data-filter-dropdown="${id}">
        <button
          id="${id}"
          class="filterDropdownTrigger"
          type="button"
          aria-haspopup="listbox"
          aria-expanded="false"
          aria-labelledby="${id}-label ${id}-value"
        >
          <span id="${id}-value">${escapeHtml(selected?.[1] || "")}</span>
          <span class="filterDropdownChevron" aria-hidden="true">⌄</span>
        </button>
        <div
          class="filterDropdownMenu"
          role="listbox"
          aria-labelledby="${id}-label"
          data-visible-options="10"
          tabindex="-1"
          hidden
        >
          ${options.map(([value, optionLabel]) => `<button
            type="button"
            role="option"
            data-filter-option="${escapeHtml(value)}"
            aria-selected="${value === selectedValue}"
            title="${escapeHtml(optionLabel)}"
          >${escapeHtml(optionLabel)}</button>`).join("")}
        </div>
      </div>
    </div>`;
  }

  function closeFilterDropdowns(except = null) {
    document.querySelectorAll("[data-filter-dropdown]").forEach((dropdown) => {
      if (dropdown === except) return;
      dropdown.querySelector(".filterDropdownMenu")?.setAttribute("hidden", "");
      dropdown.querySelector(".filterDropdownTrigger")
        ?.setAttribute("aria-expanded", "false");
    });
  }

  function bindTestFilterDropdowns() {
    document.querySelectorAll("[data-filter-dropdown]").forEach((dropdown) => {
      const key = dropdown.dataset.filterDropdown;
      const trigger = dropdown.querySelector(".filterDropdownTrigger");
      const menu = dropdown.querySelector(".filterDropdownMenu");
      const options = [...dropdown.querySelectorAll("[data-filter-option]")];
      const open = (focusOption = false) => {
        closeFilterDropdowns(dropdown);
        menu.removeAttribute("hidden");
        trigger.setAttribute("aria-expanded", "true");
        const selected = options.find((option) => option.getAttribute("aria-selected") === "true");
        selected?.scrollIntoView({ block: "nearest" });
        if (focusOption) (selected || options[0])?.focus();
      };
      const close = (restoreFocus = false) => {
        menu.setAttribute("hidden", "");
        trigger.setAttribute("aria-expanded", "false");
        if (restoreFocus) trigger.focus();
      };

      trigger.addEventListener("click", () => {
        if (menu.hasAttribute("hidden")) open();
        else close();
      });
      trigger.addEventListener("keydown", (event) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          open(true);
        }
      });
      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(true);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = Math.max(0, options.indexOf(document.activeElement));
        const target = event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : event.key === "ArrowDown"
              ? Math.min(options.length - 1, current + 1)
              : Math.max(0, current - 1);
        options[target]?.focus();
      });
      options.forEach((option) => {
        option.addEventListener("click", () => {
          state[key] = option.dataset.filterOption;
          syncUrlState();
          render();
        });
      });
    });

    if (!document.documentElement.dataset.filterDismissBound) {
      document.documentElement.dataset.filterDismissBound = "true";
      document.addEventListener("pointerdown", (event) => {
        if (!event.target.closest("[data-filter-dropdown]")) closeFilterDropdowns();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeFilterDropdowns();
      });
    }
  }

  const viewMetadata = {
    overview: {
      label: "Resumen",
      description: "Estado de la corrida y señales que requieren atención.",
      icon: "summary.png",
    },
    executions: {
      label: "Ejecuciones",
      description: "Tendencias, historial y comparación entre corridas.",
      icon: "executions.png",
    },
    quality: {
      label: "Calidad",
      description: "Estabilidad, fallos recurrentes y rendimiento histórico.",
      icon: "quality.png",
    },
    analysis: {
      label: "Análisis",
      description: "Bandeja de trabajo para investigar y clasificar fallos.",
      icon: "analysis.png",
    },
    tests: {
      label: "Pruebas",
      description: "Explorador de casos, pasos, evidencias e historial por Jira.",
      icon: "tests.png",
    },
    preferences: {
      label: "Preferencias",
      description: "Apariencia y configuración local del espacio de trabajo.",
      icon: "preferences.png",
    },
  };

  function navigateTo(view, push = true) {
    if (!availableViews.has(view) || view === state.view) return;
    state.view = view;
    syncUrlState(push);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openPdfExportModal() {
    const dialog = document.getElementById("pdf-export-modal");
    if (!dialog) return;
    dialog.innerHTML = `<div class="pdfExportShell">
      <header>
        <div>
          <p class="eyebrow">Exportación configurable</p>
          <h2>Armar PDF ejecutivo</h2>
          <p>Elegí qué información querés incluir. La portada y la identificación de la corrida se agregan siempre.</p>
        </div>
        <button type="button" class="modalCloseButton" data-close-pdf aria-label="Cerrar">×</button>
      </header>
      <div class="pdfExportToolbar">
        <span data-pdf-selection-count></span>
        <div>
          <button type="button" data-pdf-recommended>Usar selección recomendada</button>
          <button type="button" data-pdf-all>Seleccionar todas</button>
        </div>
      </div>
      <div class="pdfSectionGrid">
        ${pdfSections.map(([key, label, description, recommended]) => `<label class="pdfSectionOption">
          <input type="checkbox" name="pdf-section" value="${escapeHtml(key)}" ${recommended ? "checked" : ""} />
          <span class="pdfSectionCheck" aria-hidden="true">✓</span>
          <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span>
        </label>`).join("")}
      </div>
      <footer>
        <span class="pdfExportFeedback" data-pdf-feedback role="status"></span>
        <button type="button" class="secondaryButton" data-close-pdf>Cancelar</button>
        <button type="button" class="primaryButton" data-generate-pdf>Generar PDF</button>
      </footer>
    </div>`;

    const checkboxes = [...dialog.querySelectorAll('input[name="pdf-section"]')];
    const generateButton = dialog.querySelector("[data-generate-pdf]");
    const updateSelection = () => {
      const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
      dialog.querySelector("[data-pdf-selection-count]").textContent =
        `${selected} de ${checkboxes.length} secciones seleccionadas`;
      generateButton.disabled = selected === 0;
    };
    checkboxes.forEach((checkbox) => checkbox.addEventListener("change", updateSelection));
    dialog.querySelectorAll("[data-close-pdf]").forEach((button) =>
      button.addEventListener("click", () => dialog.close()));
    dialog.querySelector("[data-pdf-recommended]").addEventListener("click", () => {
      checkboxes.forEach((checkbox) => {
        checkbox.checked = Boolean(pdfSections.find(([key]) => key === checkbox.value)?.[3]);
      });
      updateSelection();
    });
    dialog.querySelector("[data-pdf-all]").addEventListener("click", () => {
      checkboxes.forEach((checkbox) => { checkbox.checked = true; });
      updateSelection();
    });
    generateButton.addEventListener("click", async () => {
      const selected = checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
      const feedback = dialog.querySelector("[data-pdf-feedback]");
      feedback.textContent = "";
      const downloaded = await downloadExecutivePdf(selected, generateButton);
      if (downloaded) dialog.close();
      else feedback.textContent = "No se pudo generar el PDF. Verificá que Elmulo Serve siga activo.";
    });
    updateSelection();
    dialog.showModal();
  }

  async function downloadExecutivePdf(sections, triggerButton) {
    const button = triggerButton || document.getElementById("export-executive-pdf");
    if (!button || button.disabled) return;
    const originalLabel = button.innerHTML;
    button.disabled = true;
    button.innerHTML = "<span aria-hidden=\"true\">↓</span> Generando PDF...";
    button.removeAttribute("title");
    const sectionQuery = encodeURIComponent(sections.join(","));
    const candidates = [...new Set([
      new URL(`/api/export/executive.pdf?sections=${sectionQuery}`, window.location.href).href,
      `http://127.0.0.1:4178/api/export/executive.pdf?sections=${sectionQuery}`,
    ])];
    let lastError = null;

    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate);
        if (!response.ok) {
          const body = await response.text();
          let message = `La exportación respondió ${response.status}.`;
          try {
            message = JSON.parse(body).error || message;
          } catch {
            // El servidor puede responder HTML si no es Elmulo Serve.
          }
          throw new Error(message);
        }
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/pdf")) {
          throw new Error("Elmulo Serve no devolvió un archivo PDF.");
        }
        const disposition = response.headers.get("content-disposition") || "";
        const filename = disposition.match(/filename="([^"]+)"/i)?.[1] ||
          `elmulo-ejecutivo-${run.environment}-${run.id}.pdf`;
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(downloadUrl);
        button.innerHTML = "<span aria-hidden=\"true\">✓</span> PDF descargado";
        button.innerHTML = originalLabel;
        button.disabled = false;
        return true;
      } catch (error) {
        lastError = error;
      }
    }

    button.innerHTML = "<span aria-hidden=\"true\">!</span> No se pudo exportar";
    button.title = `${lastError?.message || "Error desconocido"} Abrí Elmulo mediante yarn elmulo:serve.`;
    button.disabled = false;
    return false;
  }

  function sidebarMarkup() {
    const failed = run.tests.filter((test) => effectiveTestStatus(test) === "failed");
    const pendingAnalysis = failed.filter((test) => !annotationFor(test).comment).length;
    const badges = {
      analysis: pendingAnalysis,
      tests: run.tests.length,
    };
    return `<aside class="sidebar ${state.sidebarCollapsed ? "collapsed" : ""}" aria-label="Navegación principal">
      <div class="sidebarBrand">
        <span class="brandMark">E</span>
        <span class="sidebarBrandText">
          <strong>Elmulo Reporter</strong>
          <small>V2 beta</small>
        </span>
        <button id="sidebar-toggle" class="sidebarToggle" type="button" aria-label="${state.sidebarCollapsed ? "Expandir" : "Colapsar"} menú lateral" title="${state.sidebarCollapsed ? "Expandir" : "Colapsar"} menú">${state.sidebarCollapsed ? "›" : "‹"}</button>
      </div>
      <nav class="sidebarNav">
        ${Object.entries(viewMetadata).map(([key, item]) => `<button
          type="button"
          class="sidebarLink ${state.view === key ? "active" : ""}"
          data-nav-view="${key}"
          aria-current="${state.view === key ? "page" : "false"}"
          title="${escapeHtml(item.label)}"
        >
          <span class="sidebarIcon" aria-hidden="true">
            <img class="sidebarIconImage" src="assets/menu-icons/${escapeHtml(item.icon)}" alt="">
          </span>
          <span class="sidebarLabel">${escapeHtml(item.label)}</span>
          ${badges[key] ? `<span class="sidebarBadge">${escapeHtml(badges[key])}</span>` : ""}
        </button>`).join("")}
      </nav>
      <div class="sidebarContext">
        <span class="environmentDot" aria-hidden="true"></span>
        <span class="sidebarLabel"><strong>${escapeHtml(String(run.environment || "").toUpperCase())}</strong><small>${escapeHtml(formatDate(run.startedAt))}</small></span>
      </div>
    </aside>`;
  }

  function overviewLaunchpadMarkup() {
    const failed = run.tests.filter((test) => effectiveTestStatus(test) === "failed");
    const withoutComment = failed.filter((test) => !annotationFor(test).comment).length;
    const launchIcon = (view) =>
      `<img class="overviewLaunchIcon" src="assets/menu-icons/${escapeHtml(viewMetadata[view].icon)}" alt="">`;
    return `<section class="overviewLaunchpad" aria-labelledby="overview-next-title">
      <header>
        <div><p class="eyebrow">Explorar</p><h2 id="overview-next-title">Continuá el análisis</h2></div>
        <span>Cada área conserva el ambiente, los filtros y la prueba seleccionada.</span>
      </header>
      <div class="overviewLaunchGrid">
        <button type="button" data-nav-view="executions">${launchIcon("executions")}<strong>Ejecuciones</strong><small>${escapeHtml(run.trends?.totalRuns || 0)} corridas disponibles</small></button>
        <button type="button" data-nav-view="quality">${launchIcon("quality")}<strong>Calidad histórica</strong><small>Estabilidad, recurrencia y tiempos</small></button>
        <button type="button" data-nav-view="analysis">${launchIcon("analysis")}<strong>Análisis pendiente</strong><small>${withoutComment} fallos sin comentario</small></button>
        <button type="button" data-nav-view="tests">${launchIcon("tests")}<strong>Explorar pruebas</strong><small>${run.tests.length} ejecuciones en la corrida</small></button>
      </div>
    </section>`;
  }

  function bindWorkspaceNavigation() {
    document.querySelectorAll("[data-nav-view]").forEach((button) => {
      button.addEventListener("click", () => navigateTo(button.dataset.navView));
    });
    document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      savePreferences();
      render();
    });
    document.getElementById("mobile-menu-toggle")?.addEventListener("click", () => {
      document.querySelector(".sidebar")?.classList.toggle("mobileOpen");
    });
    document.getElementById("export-executive-pdf")?.addEventListener(
      "click",
      openPdfExportModal,
    );
  }

  function render() {
    applyAppearance();
    const activeView = viewMetadata[state.view];
    app.innerHTML = `<div class="appFrame">
      ${sidebarMarkup()}
      <div class="workspaceShell">
      <nav class="topbar" aria-label="Contexto del reporte">
        <button id="mobile-menu-toggle" class="mobileMenuToggle" type="button" aria-label="Abrir menú principal">☰</button>
        <div class="pageContext">
          <span>${escapeHtml(activeView.label)}</span>
          <small>${escapeHtml(activeView.description)}</small>
        </div>
        <span id="save-status" class="saveStatus" role="status" aria-live="polite"></span>
        <span class="environmentPill">${escapeHtml(run.environment)}</span>
      </nav>

      <main class="appShell">
      <section class="workspaceView" data-view="overview" ${state.view === "overview" ? "" : "hidden"}>
      <header class="hero">
        <div>
          <p class="eyebrow">Corrida ${run.status === "passed" ? "exitosa" : "fallida"} · ${escapeHtml(String(run.environment || "").toUpperCase())}</p>
          <h1>${run.status === "passed"
            ? `${run.counts?.passed || 0} pruebas exitosas`
            : `${run.counts?.failed || 0} fallos requieren revisión`}</h1>
          <p>${escapeHtml(run.projectName)} · ${escapeHtml(run.tagExpression || "Sin filtro de tags")}</p>
          <div class="heroMeta">
            <span>${escapeHtml(formatDate(run.startedAt))}</span>
            <span>${escapeHtml(run.browser.name)} ${escapeHtml(run.browser.version)}</span>
            <span>Cypress ${escapeHtml(run.cypressVersion)}</span>
            <span>${escapeHtml(formatDuration(run.durationMs))}</span>
            ${run.source?.branch ? `<span>Rama ${escapeHtml(run.source.branch)}</span>` : ""}
            ${run.source?.commit ? `<span>Commit ${escapeHtml(String(run.source.commit).slice(0, 8))}</span>` : ""}
            ${run.source?.pipelineId ? `<span>Pipeline ${escapeHtml(run.source.pipelineId)}</span>` : ""}
          </div>
        </div>
        <div class="heroActionStack">
          <div class="heroRunState">
            <span>Duración</span>
            <strong>${escapeHtml(formatDuration(run.durationMs))}</strong>
            <small>${escapeHtml(run.tests.length)} ejecuciones</small>
          </div>
          <button
            id="export-executive-pdf"
            class="exportPdfButton"
            type="button"
            title="Descargar un resumen ejecutivo de la corrida actual"
          ><span aria-hidden="true">↓</span> Exportar PDF ejecutivo</button>
        </div>
      </header>

      <section id="summary-grid" class="summaryGrid" aria-label="Resumen">
        ${summaryMarkup()}
      </section>
      <section id="execution-status-chart" class="statusDistribution" aria-label="Ejecuciones por estado">
        ${executionStatusChartMarkup()}
      </section>
      ${overviewLaunchpadMarkup()}
      </section>

      <section class="workspaceView" data-view="analysis" ${state.view === "analysis" ? "" : "hidden"}>
      <header class="workspaceHeader">
        <div><p class="eyebrow">Bandeja operativa</p><h1>Análisis</h1><p>Priorizá los resultados que todavía necesitan diagnóstico o seguimiento.</p></div>
        <button type="button" data-nav-view="tests">Abrir explorador de pruebas</button>
      </header>
      <section class="attentionSection" aria-labelledby="attention-title">
        <header><div><p class="eyebrow">Requiere atención</p><h2 id="attention-title">Bandeja de análisis</h2></div><span>Seleccioná una tarjeta para investigar</span></header>
        <div class="attentionGrid">${attentionMarkup()}</div>
      </section>
      <div class="analysisGuidance">
        <article><span>1</span><strong>Seleccioná una cola</strong><small>Filtrá fallos, inestables o pruebas sin seguimiento.</small></article>
        <article><span>2</span><strong>Investigá la evidencia</strong><small>Revisá pasos, error, intentos, screenshots y logs.</small></article>
        <article><span>3</span><strong>Documentá la decisión</strong><small>Clasificá el resultado y asociá comentario o ticket.</small></article>
      </div>
      </section>

      <section class="workspaceView" data-view="executions" ${state.view === "executions" ? "" : "hidden"}>
      <header class="workspaceHeader">
        <div><p class="eyebrow">Corridas</p><h1>Ejecuciones</h1><p>Consultá tendencias, recuperá resultados históricos y compará cambios.</p></div>
      </header>
      <details class="panel trendPanel">
        <summary class="trendSummary">
          <div>
            <h2>Tendencia</h2>
            <label class="trendEnvironmentPicker">
              <span>Últimas ejecuciones del ambiente</span>
              <select
                id="trend-environment"
                aria-label="Seleccionar ambiente para las tendencias"
              >
                <option value="qa" ${state.trendEnvironment === "qa" ? "selected" : ""}>QA</option>
                <option value="sandbox" ${state.trendEnvironment === "sandbox" ? "selected" : ""}>Sandbox</option>
              </select>
            </label>
          </div>
          <div class="trendSummaryMeta">
            <span id="trend-run-count" class="environmentPill">${escapeHtml(run.trends?.totalRuns ?? run.trends?.runs?.length ?? 0)} corridas</span>
            <span class="trendChevron" aria-hidden="true">›</span>
          </div>
        </summary>
        <div class="trendExpandedContent">
          <div class="trendHeaderControls">
            <label>Estado
              <select id="trend-status" aria-label="Filtrar gráfico de tendencia por estado">
                <option value="total" ${state.trendStatus === "total" ? "selected" : ""}>Todos</option>
                <option value="success_rate" ${state.trendStatus === "success_rate" ? "selected" : ""}>Tasa de éxito</option>
                <option value="passed" ${state.trendStatus === "passed" ? "selected" : ""}>Exitosos</option>
                <option value="failed" ${state.trendStatus === "failed" ? "selected" : ""}>Fallidos</option>
                <option value="environment_error" ${state.trendStatus === "environment_error" ? "selected" : ""}>Errores de ambiente</option>
                <option value="precondition_error" ${state.trendStatus === "precondition_error" ? "selected" : ""}>Errores de precondición</option>
                <option value="outdated_test" ${state.trendStatus === "outdated_test" ? "selected" : ""}>Pruebas desactualizadas</option>
                <option value="reported" ${state.trendStatus === "reported" ? "selected" : ""}>Reportado</option>
              </select>
            </label>
            <label>Período
              <select id="trend-limit" aria-label="Cantidad de corridas para la tendencia">
                ${[10, 20, 50].map((limit) => `<option value="${limit}" ${state.trendLimit === limit ? "selected" : ""}>Últimas ${limit}</option>`).join("")}
              </select>
            </label>
          </div>
          <div id="trend-content" aria-live="polite">${renderTrend()}</div>
          <div id="trend-history" aria-live="polite">${renderHistoricalRun()}</div>
        </div>
      </details>
      </section>

      <section class="workspaceView" data-view="quality" ${state.view === "quality" ? "" : "hidden"}>
      <header class="workspaceHeader">
        <div><p class="eyebrow">Observabilidad</p><h1>Calidad</h1><p>Analizá estabilidad, recurrencia y rendimiento con el historial consolidado.</p></div>
      </header>
      <details class="panel qualityPanel">
        <summary><div><h2>Calidad histórica</h2><p>Inestabilidad, tasa de fallos y rendimiento.</p></div><span class="trendChevron" aria-hidden="true">›</span></summary>
        <div id="quality-content">${renderQualityPanel()}</div>
      </details>
      </section>

      <section class="workspaceView executionsContinuation" data-view="executions" ${state.view === "executions" ? "" : "hidden"}>
      <details class="panel featuresPanel" open>
        <summary><div><h2>Features</h2><p>Resultados de la corrida actual agrupados por Feature.</p></div><span class="trendChevron" aria-hidden="true">›</span></summary>
        ${featureDistributionMarkup()}
      </details>
      <details class="panel comparisonPanel">
        <summary><div><h2>Comparar corridas</h2><p>Nuevos fallos, pruebas resueltas y cambios relevantes.</p></div><span class="trendChevron" aria-hidden="true">›</span></summary>
        <div class="comparisonControls">
          <label>Base<select id="compare-base"><option value="">Elegir corrida</option>${(run.trends?.runs || []).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${formatDate(item.started_at)} · ${String(item.environment || "").toUpperCase()} · ${item.failed || 0} fallos`)}</option>`).join("")}</select></label>
          <label>Objetivo<select id="compare-target"><option value="">Elegir corrida</option>${(run.trends?.runs || []).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${formatDate(item.started_at)} · ${String(item.environment || "").toUpperCase()} · ${item.failed || 0} fallos`)}</option>`).join("")}</select></label>
          <button id="compare-runs" type="button">Comparar</button>
        </div>
        <div id="comparison-results" aria-live="polite"></div>
      </details>
      </section>

      <section class="workspaceView" data-view="tests" ${state.view === "tests" ? "" : "hidden"}>
      <header class="workspaceHeader">
        <div><p class="eyebrow">Explorador</p><h1>Pruebas</h1><p>Filtrá casos y examiná pasos, errores, intentos, evidencias e historial por Jira.</p></div>
      </header>
      <section class="filters" aria-label="Filtros de pruebas">
        <div class="field filterSearch"><label for="search">Buscar <span class="helpTip" title="Usá jira:, status:, tag:, ticket: o spec: para búsquedas precisas">?</span></label><input id="search" type="search" value="${escapeHtml(state.search)}" placeholder="Prueba, Jira, ticket… Ej.: jira:FONLP06-2156" /></div>
        ${filterDropdownMarkup("status", "Estado", [
          ["all", "Todos"],
          ["failed", "Fallidos"],
          ["passed", "Exitosos"],
          ["skipped", "Omitidos"],
          ["other_errors", "Otros errores"],
          ["environment_error", "Error de ambiente"],
          ["precondition_error", "Error de precondición"],
          ["outdated_test", "Prueba desactualizada"],
          ["reported", "Reportado"],
        ], state.status)}
        ${filterDropdownMarkup("spec", "Spec", [
          ["all", "Todos"],
          ...specs.map((spec) => [spec, spec.split("/").at(-1)]),
        ], state.spec)}
        ${filterDropdownMarkup("tag", "Tag", [
          ["all", "Todos"],
          ...tags.map((tag) => [tag, tag]),
        ], state.tag)}
        ${filterDropdownMarkup(
          "flaky",
          "Inestabilidad",
          [
            ["all", "Todas"],
            ["yes", "Sólo inestables"],
            ["no", "Excluir inestables"],
          ],
          state.flaky,
          ' <span class="helpTip" title="Flaky: falló en un intento y terminó exitosa después de un retry">?</span>',
        )}
        ${filterDropdownMarkup("sort", "Ordenar", [
          ["severity", "Severidad"],
          ["duration", "Duración"],
          ["name", "Nombre"],
          ["history", "Reintentos"],
        ], state.sort)}
        <div id="active-filters" class="activeFilters">${activeFilterChips()}</div>
      </section>

      <details class="bulkPanel">
        <summary>Modificación masiva · <span id="selected-count">${state.bulkSelected.size} seleccionadas</span></summary>
        <div class="bulkFields">
          <label>Estado<select id="bulk-status"><option value="environment_error">Error de ambiente</option><option value="precondition_error">Error de precondición</option><option value="outdated_test">Prueba desactualizada</option><option value="reported">Reportado</option><option value="failed">Fallido</option></select></label>
          <label>Comentario<input id="bulk-comment" maxlength="20000" /></label>
          <label>Ticket<input id="bulk-ticket" maxlength="2000" /></label>
          <button id="apply-bulk" type="button" ${state.bulkSelected.size ? "" : "disabled"}>Revisar cambios</button>
          <span id="bulk-feedback" aria-live="polite"></span>
        </div>
      </details>

      <section class="resultsLayout">
        <article class="testList">
          <header class="listHeader">
            <div><h2>Pruebas</h2><p id="visible-count"></p></div>
            <label class="selectVisible"><input id="select-visible" type="checkbox" /> Seleccionar visibles</label>
          </header>
          <div id="test-rows" class="testRows"></div>
        </article>
        <article id="test-detail" class="testDetail" aria-live="polite"></article>
      </section>
      </section>

      <section class="workspaceView" data-view="preferences" ${state.view === "preferences" ? "" : "hidden"}>
        <header class="workspaceHeader">
          <div><p class="eyebrow">Espacio de trabajo</p><h1>Preferencias</h1><p>Personalizá la lectura del reporte en este navegador.</p></div>
        </header>
        <div class="preferencesGrid">
          <article class="preferenceCard">
            <span class="preferenceIcon" aria-hidden="true">A</span>
            <div><h2>Analista</h2><p>Nombre que quedará asociado a comentarios y cambios de estado.</p></div>
            <label>Nombre
              <input id="actor-name" value="${escapeHtml(state.actor)}" maxlength="120" aria-label="Nombre del analista" />
            </label>
          </article>
          <article class="preferenceCard">
            <span class="preferenceIcon" aria-hidden="true">≡</span>
            <div><h2>Densidad</h2><p>Ajustá cuánto contenido se muestra simultáneamente.</p></div>
            <label>Densidad de información
              <select id="density" aria-label="Densidad de información">
                <option value="comfortable" ${state.density === "comfortable" ? "selected" : ""}>Cómoda</option>
                <option value="compact" ${state.density === "compact" ? "selected" : ""}>Compacta</option>
                <option value="dense" ${state.density === "dense" ? "selected" : ""}>Muy compacta</option>
              </select>
            </label>
          </article>
          <article class="preferenceCard">
            <span class="preferenceIcon" aria-hidden="true">${state.theme === "dark" ? "☀" : "☾"}</span>
            <div><h2>Apariencia</h2><p>Alterná entre el tema claro y oscuro manteniendo el contraste.</p></div>
            <button id="theme-toggle" class="preferenceAction" type="button">${state.theme === "dark" ? "Usar tema claro" : "Usar tema oscuro"}</button>
          </article>
          <article class="preferenceCard">
            <span class="preferenceIcon" aria-hidden="true">↔</span>
            <div><h2>Menú lateral</h2><p>El menú recuerda automáticamente si preferís verlo expandido o compacto.</p></div>
            <button type="button" class="preferenceAction" data-toggle-sidebar>${state.sidebarCollapsed ? "Expandir menú" : "Colapsar menú"}</button>
          </article>
        </div>
      </section>

      <footer class="footer">Elmulo Reporter V2 beta · Esquema ${escapeHtml(run.schemaVersion || 3)} · Run ${escapeHtml(run.id)} · Generado ${escapeHtml(formatDate(run.generatedAt))}</footer>
      </main>
      </div>
    </div>
    <dialog id="test-history-modal" class="testHistoryModal" aria-label="Historial de estados de la prueba"></dialog>
    <dialog id="reuse-confirmation-modal" class="reuseConfirmationModal" aria-label="Confirmar reutilización de estado"></dialog>
    <dialog id="bulk-confirmation-modal" class="reuseConfirmationModal" aria-label="Confirmar modificación masiva"></dialog>
    <dialog id="pdf-export-modal" class="pdfExportModal" aria-label="Seleccionar secciones del PDF ejecutivo"></dialog>`;

    document.getElementById("search").addEventListener("input", (event) => {
      state.search = event.target.value;
      syncUrlState();
      renderList();
      const activeFilters = document.getElementById("active-filters");
      if (activeFilters) activeFilters.innerHTML = activeFilterChips();
      bindFilterChipEvents();
    });
    bindTestFilterDropdowns();
    const trendEnvironment = document.getElementById("trend-environment");
    for (const eventName of ["click", "pointerdown", "keydown"]) {
      trendEnvironment.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    }
    trendEnvironment.addEventListener("change", (event) => {
      loadTrendEnvironment(event.target.value);
    });
    document.getElementById("trend-status").addEventListener("change", (event) => {
      state.trendStatus = event.target.value;
      renderTrendArea();
    });
    document.getElementById("trend-limit").addEventListener("change", (event) => {
      state.trendLimit = Number(event.target.value);
      syncUrlState();
      loadTrendEnvironment(state.trendEnvironment);
    });
    document.getElementById("actor-name").addEventListener("change", (event) => {
      state.actor = event.target.value.trim() || "Usuario local";
      localStorage.setItem(actorStorageKey, state.actor);
    });
    document.getElementById("density").addEventListener("change", (event) => {
      state.density = event.target.value;
      savePreferences();
      applyAppearance();
    });
    document.getElementById("theme-toggle").addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      savePreferences();
      render();
    });
    document.querySelector("[data-toggle-sidebar]")?.addEventListener("click", () => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      savePreferences();
      render();
    });
    document.getElementById("compare-runs").addEventListener("click", compareSelectedRuns);
    document.getElementById("apply-bulk").addEventListener("click", openBulkConfirmation);
    document.getElementById("select-visible").addEventListener("change", (event) => {
      for (const test of filteredTests()) {
        if (event.target.checked) state.bulkSelected.add(test.id);
        else state.bulkSelected.delete(test.id);
      }
      renderList();
    });
    bindWorkspaceNavigation();
    bindFilterChipEvents();
    bindAttentionEvents();
    bindQualityEvents();
    renderList();
    renderTrendArea();
    renderSaveStatus();
    loadAnalytics();
  }

  window.addEventListener("popstate", () => {
    const view = new URLSearchParams(window.location.search).get("view") || "overview";
    state.view = availableViews.has(view) ? view : "overview";
    render();
  });

  render();
})();
