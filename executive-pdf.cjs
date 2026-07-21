const STATUS_DEFINITIONS = [
  ["passed", "Exitosas", [0.102, 0.608, 0.471]],
  ["failed", "Fallidas", [0.937, 0.255, 0.38]],
  ["environment_error", "Error de ambiente", [0.961, 0.62, 0.043]],
  ["precondition_error", "Error de precondicion", [0.918, 0.42, 0.094]],
  ["outdated_test", "Pruebas desactualizadas", [0.486, 0.361, 0.898]],
  ["reported", "Reportadas", [0.118, 0.439, 0.722]],
  ["omitted", "Omitidas", [0.553, 0.627, 0.702]],
  ["other", "Otros estados", [0.325, 0.404, 0.482]],
];

const STATUS_LABELS = Object.fromEntries(STATUS_DEFINITIONS.map(([key, label]) => [key, label]));

function normalizeText(value) {
  return String(value ?? "")
    .replaceAll("\u2013", "-")
    .replaceAll("\u2014", "-")
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'")
    .replaceAll("\u201c", '"')
    .replaceAll("\u201d", '"')
    .replaceAll("\u2026", "...")
    .replace(/[^\x20-\xFF]/g, "?");
}

function pdfEscape(value) {
  return normalizeText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("\r", "")
    .replaceAll("\n", " ");
}

function effectiveStatus(run, test) {
  return run.annotations?.[test.id]?.status || test.status || "other";
}

function formatDate(value) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value));
}

function formatDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds || 0));
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function jiraId(test) {
  return (test.tags || [])
    .map((tag) => String(tag).replace(/^@/, "").toUpperCase())
    .find((tag) => /^[A-Z][A-Z0-9]+-\d+$/.test(tag)) || "-";
}

function truncate(value, maximum) {
  const text = normalizeText(value);
  return text.length > maximum ? `${text.slice(0, Math.max(1, maximum - 3))}...` : text;
}

function wrapText(value, maximum) {
  const text = normalizeText(value).trim();
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const pieces = word.length > maximum
      ? word.match(new RegExp(`.{1,${maximum}}`, "g"))
      : [word];
    for (const piece of pieces) {
      const candidate = line ? `${line} ${piece}` : piece;
      if (candidate.length > maximum && line) {
        lines.push(line);
        line = piece;
      } else {
        line = candidate;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

class PdfCanvas {
  constructor() {
    this.width = 595.28;
    this.height = 841.89;
    this.pages = [];
    this.commands = [];
    this.pageNumber = 0;
    this.newPage();
  }

  newPage() {
    if (this.commands.length) this.pages.push(this.commands.join("\n"));
    this.commands = [];
    this.pageNumber += 1;
    this.fillRect(0, 0, this.width, this.height, [0.969, 0.98, 0.992]);
    this.fillRect(0, 0, this.width, 8, [0.047, 0.694, 0.706]);
  }

  y(top, height = 0) {
    return this.height - top - height;
  }

  fillRect(x, top, width, height, color, radius = 0) {
    const [r, g, b] = color;
    if (!radius) {
      this.commands.push(`${r} ${g} ${b} rg ${x} ${this.y(top, height)} ${width} ${height} re f`);
      return;
    }
    const y = this.y(top, height);
    const k = 0.55228475;
    const c = radius * k;
    this.commands.push(
      `${r} ${g} ${b} rg`,
      `${x + radius} ${y} m`,
      `${x + width - radius} ${y} l`,
      `${x + width - radius + c} ${y} ${x + width} ${y + radius - c} ${x + width} ${y + radius} c`,
      `${x + width} ${y + height - radius} l`,
      `${x + width} ${y + height - radius + c} ${x + width - radius + c} ${y + height} ${x + width - radius} ${y + height} c`,
      `${x + radius} ${y + height} l`,
      `${x + radius - c} ${y + height} ${x} ${y + height - radius + c} ${x} ${y + height - radius} c`,
      `${x} ${y + radius} l`,
      `${x} ${y + radius - c} ${x + radius - c} ${y} ${x + radius} ${y} c f`,
    );
  }

  strokeRect(x, top, width, height, color, lineWidth = 1, radius = 0) {
    const [r, g, b] = color;
    if (!radius) {
      this.commands.push(`${r} ${g} ${b} RG ${lineWidth} w ${x} ${this.y(top, height)} ${width} ${height} re S`);
      return;
    }
    const y = this.y(top, height);
    const k = 0.55228475;
    const c = radius * k;
    this.commands.push(
      `${r} ${g} ${b} RG ${lineWidth} w`,
      `${x + radius} ${y} m`,
      `${x + width - radius} ${y} l`,
      `${x + width - radius + c} ${y} ${x + width} ${y + radius - c} ${x + width} ${y + radius} c`,
      `${x + width} ${y + height - radius} l`,
      `${x + width} ${y + height - radius + c} ${x + width - radius + c} ${y + height} ${x + width - radius} ${y + height} c`,
      `${x + radius} ${y + height} l`,
      `${x + radius - c} ${y + height} ${x} ${y + height - radius + c} ${x} ${y + height - radius} c`,
      `${x} ${y + radius} l`,
      `${x} ${y + radius - c} ${x + radius - c} ${y} ${x + radius} ${y} c S`,
    );
  }

  line(x1, top1, x2, top2, color = [0.82, 0.87, 0.91], width = 1) {
    const [r, g, b] = color;
    this.commands.push(`${r} ${g} ${b} RG ${width} w ${x1} ${this.y(top1)} m ${x2} ${this.y(top2)} l S`);
  }

  text(value, x, top, options = {}) {
    const size = options.size || 10;
    const font = options.bold ? "F2" : "F1";
    const color = options.color || [0.063, 0.176, 0.286];
    const [r, g, b] = color;
    this.commands.push(
      `BT /${font} ${size} Tf ${r} ${g} ${b} rg ${x} ${this.y(top + size * 0.82)} Td (${pdfEscape(value)}) Tj ET`,
    );
  }

  wrappedText(value, x, top, width, options = {}) {
    const size = options.size || 9;
    const lineHeight = options.lineHeight || size * 1.35;
    const maximum = Math.max(8, Math.floor(width / (size * 0.53)));
    const lines = wrapText(value, maximum).slice(0, options.maxLines || 99);
    lines.forEach((line, index) =>
      this.text(line, x, top + index * lineHeight, options));
    return lines.length * lineHeight;
  }

  footer(run) {
    this.line(34, 807, 561, 807);
    this.text(`Elmulo Reporter V2 - ${normalizeText(run.id)}`, 34, 817, {
      size: 7.5,
      color: [0.38, 0.46, 0.54],
    });
    this.text(`Pagina ${this.pageNumber}`, 519, 817, {
      size: 7.5,
      bold: true,
      color: [0.38, 0.46, 0.54],
    });
  }

  finish(run) {
    this.pages.push(this.commands.join("\n"));
    const pageStreams = this.pages;
    const pageIds = pageStreams.map((_, index) => 5 + index * 2);
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Count ${pageStreams.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ];
    for (let index = 0; index < pageStreams.length; index += 1) {
      const streamId = 6 + index * 2;
      const stream = Buffer.from(pageStreams[index], "latin1");
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`,
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"),
          stream,
          Buffer.from("\nendstream", "ascii"),
        ]),
      );
    }

    const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    const offsets = [0];
    let length = chunks[0].length;
    objects.forEach((object, index) => {
      offsets.push(length);
      const header = Buffer.from(`${index + 1} 0 obj\n`, "ascii");
      const body = Buffer.isBuffer(object) ? object : Buffer.from(object, "latin1");
      const footer = Buffer.from("\nendobj\n", "ascii");
      chunks.push(header, body, footer);
      length += header.length + body.length + footer.length;
    });
    const xrefOffset = length;
    const xrefLines = [
      `xref\n0 ${objects.length + 1}`,
      "0000000000 65535 f ",
      ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
      `startxref\n${xrefOffset}\n%%EOF\n`,
    ];
    chunks.push(Buffer.from(xrefLines.join("\n"), "ascii"));
    return Buffer.concat(chunks);
  }
}

function buildStatusSummary(run) {
  const known = new Set(STATUS_DEFINITIONS.slice(0, 6).map(([key]) => key));
  const counts = Object.fromEntries(STATUS_DEFINITIONS.map(([key]) => [key, 0]));
  for (const test of run.tests || []) {
    const status = effectiveStatus(run, test);
    if (["skipped", "pending"].includes(status)) counts.omitted += 1;
    else if (known.has(status)) counts[status] += 1;
    else counts.other += 1;
  }
  return counts;
}

function buildAssessment(counts, total) {
  const classified =
    counts.environment_error +
    counts.precondition_error +
    counts.outdated_test +
    counts.reported;
  if (counts.failed > 0) {
    return {
      title: "NO APROBADO",
      color: [0.937, 0.255, 0.38],
      text: `La corrida conserva ${counts.failed} ${counts.failed === 1 ? "fallo funcional sin clasificar" : "fallos funcionales sin clasificar"}. Se recomienda completar el analisis antes de avanzar.`,
    };
  }
  if (classified > 0 || counts.omitted > 0) {
    return {
      title: "APROBADO CON OBSERVACIONES",
      color: [0.961, 0.62, 0.043],
      text: `No quedan fallos funcionales abiertos, pero existen ${classified} resultados clasificados y ${counts.omitted} omitidos que requieren seguimiento.`,
    };
  }
  return {
    title: "APROBADO",
    color: [0.102, 0.608, 0.471],
    text: `Las ${total} ejecuciones finalizaron sin fallos funcionales ni observaciones abiertas.`,
  };
}

function drawHeader(pdf, run, subtitle) {
  pdf.text("ELMULO REPORTER", 34, 27, {
    size: 9,
    bold: true,
    color: [0.047, 0.694, 0.706],
  });
  pdf.text("Informe ejecutivo de calidad", 34, 44, {
    size: 22,
    bold: true,
  });
  pdf.text(subtitle, 34, 71, {
    size: 9,
    color: [0.38, 0.46, 0.54],
  });
  pdf.fillRect(466, 31, 95, 28, [0.886, 0.965, 0.961], 14);
  pdf.text(String(run.environment || "N/A").toUpperCase(), 493, 40, {
    size: 10,
    bold: true,
    color: [0.02, 0.38, 0.42],
  });
}

function drawMetric(pdf, x, top, width, label, value, color) {
  pdf.fillRect(x, top, width, 58, [1, 1, 1], 8);
  pdf.strokeRect(x, top, width, 58, [0.85, 0.89, 0.93], 0.7, 8);
  pdf.fillRect(x, top, 4, 58, color, 2);
  pdf.text(label, x + 14, top + 13, {
    size: 8,
    bold: true,
    color: [0.38, 0.46, 0.54],
  });
  pdf.text(String(value), x + 14, top + 30, {
    size: 18,
    bold: true,
  });
}

function drawPageOne(pdf, run, counts) {
  drawHeader(pdf, run, `${normalizeText(run.projectName || "Proyecto")} - ${formatDate(run.startedAt)}`);
  const total = (run.tests || []).length;
  const cases = new Set((run.tests || []).map((test) => test.caseId || test.id)).size;
  const passRate = total ? Math.round((counts.passed / total) * 1000) / 10 : 0;
  const metrics = [
    ["Casos", cases, [0.118, 0.439, 0.722]],
    ["Ejecuciones", total, [0.047, 0.694, 0.706]],
    ["Exitosas", counts.passed, [0.102, 0.608, 0.471]],
    ["Fallidas", counts.failed, [0.937, 0.255, 0.38]],
    ["Exito", `${passRate}%`, [0.486, 0.361, 0.898]],
  ];
  metrics.forEach(([label, value, color], index) =>
    drawMetric(pdf, 34 + index * 106, 99, 98, label, value, color));

  const assessment = buildAssessment(counts, total);
  pdf.fillRect(34, 176, 527, 78, [1, 1, 1], 10);
  pdf.strokeRect(34, 176, 527, 78, assessment.color, 1, 10);
  pdf.fillRect(49, 192, 126, 24, assessment.color, 12);
  pdf.text(assessment.title, 61, 199, {
    size: 8.5,
    bold: true,
    color: [1, 1, 1],
  });
  pdf.wrappedText(assessment.text, 49, 224, 495, {
    size: 9,
    lineHeight: 12,
    maxLines: 2,
    color: [0.22, 0.29, 0.37],
  });

  pdf.text("Distribucion por estado", 34, 278, { size: 13, bold: true });
  const barX = 34;
  const barTop = 303;
  const barWidth = 527;
  let cursor = barX;
  STATUS_DEFINITIONS.forEach(([key, , color]) => {
    const width = total ? (counts[key] / total) * barWidth : 0;
    if (width > 0) pdf.fillRect(cursor, barTop, width, 18, color);
    cursor += width;
  });
  pdf.strokeRect(barX, barTop, barWidth, 18, [0.8, 0.85, 0.9], 0.6);
  STATUS_DEFINITIONS.filter(([key]) => counts[key] > 0).forEach(([key, label, color], index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = 34 + column * 132;
    const top = 333 + row * 28;
    pdf.fillRect(x, top + 2, 8, 8, color, 4);
    pdf.text(label, x + 14, top, { size: 7.8, bold: true });
    pdf.text(`${counts[key]} (${total ? Math.round((counts[key] / total) * 100) : 0}%)`, x + 14, top + 11, {
      size: 7.3,
      color: [0.38, 0.46, 0.54],
    });
  });

  const sectionTop = 409;
  pdf.text("Contexto de la corrida", 34, sectionTop, { size: 13, bold: true });
  pdf.fillRect(34, sectionTop + 24, 527, 112, [1, 1, 1], 8);
  const context = [
    ["Corrida", run.id],
    ["Inicio", formatDate(run.startedAt)],
    ["Duracion", formatDuration(run.durationMs)],
    ["Navegador", `${run.browser?.name || "-"} ${run.browser?.version || ""}`.trim()],
    ["Cypress", run.cypressVersion || "-"],
    ["Tags", run.tagExpression || "Sin filtro de tags"],
    ["Rama", run.source?.branch || "-"],
    ["Commit / pipeline", [run.source?.commit?.slice(0, 8), run.source?.pipelineId].filter(Boolean).join(" / ") || "-"],
  ];
  context.forEach(([label, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 49 + column * 255;
    const top = sectionTop + 39 + row * 23;
    pdf.text(label, x, top, { size: 7.5, bold: true, color: [0.38, 0.46, 0.54] });
    pdf.text(truncate(value, 35), x + 74, top, { size: 8.2 });
  });

  const trends = (run.trends?.runs || []).slice(-5);
  pdf.text("Ultimas ejecuciones del ambiente", 34, 572, { size: 13, bold: true });
  pdf.text(`${run.trends?.totalRuns || trends.length} corridas registradas`, 389, 574, {
    size: 8,
    color: [0.38, 0.46, 0.54],
  });
  pdf.fillRect(34, 598, 527, 26, [0.063, 0.176, 0.286], 5);
  ["Fecha", "Total", "Exitosas", "Fallidas", "Clasificadas", "% exito"].forEach((label, index) =>
    pdf.text(label, [45, 231, 284, 350, 407, 503][index], 607, {
      size: 7.5,
      bold: true,
      color: [1, 1, 1],
    }));
  trends.forEach((item, index) => {
    const top = 624 + index * 28;
    const classified = ["environment_error", "precondition_error", "outdated_test", "reported"]
      .reduce((sum, key) => sum + Number(item[key] || 0), 0);
    const itemTotal = Number(item.total || 0);
    const values = [
      formatDate(item.started_at),
      itemTotal,
      Number(item.passed || 0),
      Number(item.failed || 0),
      classified,
      `${itemTotal ? Math.round((Number(item.passed || 0) / itemTotal) * 100) : 0}%`,
    ];
    if (index % 2 === 0) pdf.fillRect(34, top, 527, 28, [0.94, 0.96, 0.98]);
    values.forEach((value, valueIndex) =>
      pdf.text(truncate(value, valueIndex === 0 ? 25 : 12), [45, 231, 284, 350, 407, 503][valueIndex], top + 9, {
        size: 7.5,
        bold: valueIndex === 5,
      }));
  });
  pdf.footer(run);
}

function drawIssuesPage(pdf, run) {
  pdf.newPage();
  drawHeader(pdf, run, "Problemas que requieren seguimiento");
  const actionable = (run.tests || [])
    .filter((test) => effectiveStatus(run, test) !== "passed")
    .sort((left, right) => {
      const order = { failed: 0, reported: 1, environment_error: 2, precondition_error: 3, outdated_test: 4 };
      return (order[effectiveStatus(run, left)] ?? 9) - (order[effectiveStatus(run, right)] ?? 9);
    });
  pdf.text("Principales problemas", 34, 101, { size: 14, bold: true });
  pdf.text(`${actionable.length} resultados distintos de exitoso en la corrida actual`, 34, 121, {
    size: 8.5,
    color: [0.38, 0.46, 0.54],
  });

  if (!actionable.length) {
    pdf.fillRect(34, 151, 527, 78, [0.886, 0.965, 0.961], 10);
    pdf.text("No se detectaron problemas abiertos.", 54, 180, {
      size: 13,
      bold: true,
      color: [0.02, 0.38, 0.42],
    });
  } else {
    pdf.fillRect(34, 148, 527, 25, [0.063, 0.176, 0.286], 5);
    ["Prueba", "Jira", "Estado", "Duracion"].forEach((label, index) =>
      pdf.text(label, [44, 325, 407, 515][index], 156, {
        size: 7.5,
        bold: true,
        color: [1, 1, 1],
      }));
    actionable.slice(0, 9).forEach((test, index) => {
      const top = 173 + index * 61;
      const annotation = run.annotations?.[test.id] || {};
      if (index % 2 === 0) pdf.fillRect(34, top, 527, 61, [0.94, 0.96, 0.98]);
      pdf.text(truncate(test.originalTitle || test.title, 49), 44, top + 9, { size: 8, bold: true });
      pdf.text(jiraId(test), 325, top + 9, { size: 7.5, bold: true });
      pdf.text(STATUS_LABELS[effectiveStatus(run, test)] || effectiveStatus(run, test), 407, top + 9, {
        size: 7.3,
        bold: true,
      });
      pdf.text(formatDuration(test.durationMs), 515, top + 9, { size: 7.3 });
      const comment = annotation.comment || test.error?.message || "Sin comentario";
      pdf.text(`Analisis: ${truncate(comment.replace(/\s+/g, " "), 77)}`, 44, top + 28, {
        size: 7.3,
        color: [0.31, 0.39, 0.47],
      });
      pdf.text(`Ticket: ${truncate(annotation.ticket || "Sin ticket asociado", 67)}`, 44, top + 43, {
        size: 7.3,
        color: [0.31, 0.39, 0.47],
      });
    });
    if (actionable.length > 9) {
      pdf.text(`Se muestran 9 de ${actionable.length} resultados. Consulte Elmulo para el detalle completo.`, 34, 743, {
        size: 8,
        bold: true,
        color: [0.118, 0.439, 0.722],
      });
    }
  }
  pdf.footer(run);
}

function drawQualityPage(pdf, run, counts) {
  pdf.newPage();
  drawHeader(pdf, run, "Estabilidad, comparacion y recomendacion");
  const flaky = (run.tests || []).filter((test) => test.flaky);
  const trends = run.trends?.runs || [];
  const currentIndex = trends.findIndex((item) => item.id === run.id);
  const previous = currentIndex > 0 ? trends[currentIndex - 1] : trends.at(-2);
  const current = trends.find((item) => item.id === run.id) || trends.at(-1);

  pdf.text("Pruebas inestables", 34, 101, { size: 14, bold: true });
  pdf.fillRect(34, 129, 527, 98, [1, 1, 1], 9);
  if (!flaky.length) {
    pdf.text("No se detectaron pruebas que fallaran y luego pasaran en un reintento.", 50, 160, {
      size: 10,
      bold: true,
      color: [0.102, 0.608, 0.471],
    });
    pdf.text("La inestabilidad se calcula dentro de la corrida actual.", 50, 181, {
      size: 8,
      color: [0.38, 0.46, 0.54],
    });
  } else {
    flaky.slice(0, 4).forEach((test, index) => {
      pdf.fillRect(49, 146 + index * 18, 7, 7, [0.961, 0.62, 0.043], 4);
      pdf.text(truncate(test.originalTitle || test.title, 65), 63, 142 + index * 18, {
        size: 8,
        bold: true,
      });
      pdf.text(`${test.retries || 0} reintentos`, 477, 142 + index * 18, {
        size: 7.5,
        color: [0.38, 0.46, 0.54],
      });
    });
  }

  pdf.text("Comparacion con la corrida anterior", 34, 260, { size: 14, bold: true });
  if (!previous || !current) {
    pdf.fillRect(34, 288, 527, 66, [1, 1, 1], 9);
    pdf.text("Todavia no hay otra corrida comparable en este ambiente.", 50, 315, {
      size: 9,
      color: [0.38, 0.46, 0.54],
    });
  } else {
    const previousClassified = ["environment_error", "precondition_error", "outdated_test", "reported"]
      .reduce((sum, key) => sum + Number(previous[key] || 0), 0);
    const currentClassified = ["environment_error", "precondition_error", "outdated_test", "reported"]
      .reduce((sum, key) => sum + Number(current[key] || 0), 0);
    const comparisons = [
      ["Exitosas", Number(current.passed || 0), Number(previous.passed || 0), [0.102, 0.608, 0.471]],
      ["Fallidas", Number(current.failed || 0), Number(previous.failed || 0), [0.937, 0.255, 0.38]],
      ["Clasificadas", currentClassified, previousClassified, [0.961, 0.62, 0.043]],
      ["Duracion", Number(current.duration_ms || run.durationMs), Number(previous.duration_ms || 0), [0.118, 0.439, 0.722]],
    ];
    comparisons.forEach(([label, value, oldValue, color], index) => {
      const x = 34 + index * 132;
      pdf.fillRect(x, 288, 122, 78, [1, 1, 1], 8);
      pdf.fillRect(x, 288, 122, 4, color, 2);
      pdf.text(label, x + 12, 304, { size: 8, bold: true, color: [0.38, 0.46, 0.54] });
      pdf.text(index === 3 ? formatDuration(value) : value, x + 12, 324, { size: 15, bold: true });
      const delta = value - oldValue;
      pdf.text(`${delta > 0 ? "+" : ""}${index === 3 ? formatDuration(delta) : delta} vs. anterior`, x + 12, 348, {
        size: 7,
        color: [0.38, 0.46, 0.54],
      });
    });
  }

  const assessment = buildAssessment(counts, (run.tests || []).length);
  pdf.text("Recomendacion", 34, 405, { size: 14, bold: true });
  pdf.fillRect(34, 434, 527, 118, [1, 1, 1], 10);
  pdf.fillRect(34, 434, 7, 118, assessment.color, 3);
  pdf.text(assessment.title, 56, 454, {
    size: 13,
    bold: true,
    color: assessment.color,
  });
  pdf.wrappedText(assessment.text, 56, 480, 480, {
    size: 9,
    lineHeight: 13,
    maxLines: 3,
    color: [0.22, 0.29, 0.37],
  });
  const missingComments = (run.tests || []).filter((test) =>
    effectiveStatus(run, test) === "failed" && !run.annotations?.[test.id]?.comment).length;
  const missingTickets = (run.tests || []).filter((test) =>
    effectiveStatus(run, test) === "failed" && !run.annotations?.[test.id]?.ticket).length;
  pdf.text(`${missingComments} fallos sin comentario - ${missingTickets} fallos sin ticket`, 56, 527, {
    size: 8,
    bold: true,
    color: [0.38, 0.46, 0.54],
  });

  pdf.text("Alcance del documento", 34, 594, { size: 14, bold: true });
  pdf.fillRect(34, 622, 527, 105, [0.914, 0.945, 0.976], 9);
  pdf.wrappedText(
    "Este PDF resume la corrida actual y las clasificaciones manuales persistidas al momento de exportar. Los pasos Cucumber, logs, evidencias, screenshots, videos y auditoria completa permanecen disponibles en el reporte interactivo de Elmulo.",
    52,
    643,
    490,
    {
      size: 9,
      lineHeight: 14,
      maxLines: 4,
      color: [0.15, 0.27, 0.39],
    },
  );
  pdf.text(`Generado: ${formatDate(new Date().toISOString())}`, 52, 702, {
    size: 7.5,
    color: [0.38, 0.46, 0.54],
  });
  pdf.footer(run);
}

function buildExecutivePdf(run) {
  if (!run || !Array.isArray(run.tests)) {
    throw new Error("La corrida no contiene resultados exportables.");
  }
  const pdf = new PdfCanvas();
  const counts = buildStatusSummary(run);
  drawPageOne(pdf, run, counts);
  drawIssuesPage(pdf, run);
  drawQualityPage(pdf, run, counts);
  return pdf.finish(run);
}

module.exports = {
  STATUS_DEFINITIONS,
  buildExecutivePdf,
  buildStatusSummary,
};
