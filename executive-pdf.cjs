const path = require("node:path");
const PDFDocument = require("pdfkit");

const FONT_PATH = path.join(__dirname, "assets", "fonts", "NotoSans-Variable.ttf");

const COLORS = {
  ink: "#102D49",
  muted: "#627589",
  teal: "#0CB1B4",
  tealDark: "#056166",
  paper: "#F7FAFD",
  white: "#FFFFFF",
  line: "#D7E2EC",
  stripe: "#EFF5FA",
  green: "#1A9B78",
  red: "#EF4161",
  amber: "#F59E0B",
  orange: "#EA6B18",
  purple: "#7C5CE5",
  blue: "#1E70B8",
  gray: "#8D9FAD",
};

const STATUS_DEFINITIONS = [
  ["passed", "Exitosas", COLORS.green],
  ["failed", "Fallidas", COLORS.red],
  ["environment_error", "Error de ambiente", COLORS.amber],
  ["precondition_error", "Error de precondición", COLORS.orange],
  ["outdated_test", "Pruebas desactualizadas", COLORS.purple],
  ["reported", "Reportadas", COLORS.blue],
  ["omitted", "Omitidas", COLORS.gray],
  ["other", "Otros estados", "#536777"],
];

const STATUS_LABELS = Object.fromEntries(STATUS_DEFINITIONS.map(([key, label]) => [key, label]));

const PDF_SECTIONS = [
  "summary",
  "statusDistribution",
  "runContext",
  "features",
  "issues",
  "previousComparison",
  "recentHistory",
  "flaky",
  "recurrentFailures",
  "slowTests",
  "recommendation",
];

const DEFAULT_PDF_SECTIONS = PDF_SECTIONS.filter((section) => section !== "slowTests");

function effectiveStatus(run, test) {
  const raw = run.annotations?.[test.id]?.status || test.status || "other";
  return ["skipped", "pending"].includes(raw) ? "omitted" : raw;
}

function formatDate(value) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date);
}

function formatDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds || 0));
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function formatDurationDelta(milliseconds) {
  const value = Number(milliseconds || 0);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  const formatted = absolute >= 1000 && absolute < 60_000 && absolute % 1000 === 0
    ? `${absolute / 1000} s`
    : formatDuration(absolute);
  return `${sign}${formatted}`;
}

function jiraId(test) {
  return (test.tags || [])
    .map((tag) => String(tag).replace(/^@/, "").toUpperCase())
    .find((tag) => /^[A-Z][A-Z0-9]+-\d+$/.test(tag)) || "Sin ticket";
}

function buildStatusSummary(run) {
  const counts = Object.fromEntries(STATUS_DEFINITIONS.map(([key]) => [key, 0]));
  for (const test of run.tests || []) {
    const status = effectiveStatus(run, test);
    counts[Object.hasOwn(counts, status) ? status : "other"] += 1;
  }
  return counts;
}

function buildAssessment(counts, total) {
  const classified = ["environment_error", "precondition_error", "outdated_test", "reported"]
    .reduce((sum, key) => sum + counts[key], 0);
  if (counts.failed > 0) {
    return {
      title: "NO APROBADO",
      color: COLORS.red,
      text: `La corrida conserva ${counts.failed} ${counts.failed === 1 ? "fallo funcional sin clasificar" : "fallos funcionales sin clasificar"}. Se recomienda completar el análisis antes de avanzar.`,
    };
  }
  if (classified > 0 || counts.omitted > 0) {
    return {
      title: "APROBADO CON OBSERVACIONES",
      color: COLORS.amber,
      text: `No quedan fallos funcionales abiertos, pero existen ${classified} resultados clasificados y ${counts.omitted} omitidos que requieren seguimiento.`,
    };
  }
  return {
    title: "APROBADO",
    color: COLORS.green,
    text: `Las ${total} ejecuciones finalizaron sin fallos funcionales ni observaciones abiertas.`,
  };
}

function featureRows(run) {
  const groups = new Map();
  for (const test of run.tests || []) {
    const name = test.feature || test.spec || "Sin Feature";
    const row = groups.get(name) || { name, total: 0, passed: 0, failed: 0, classified: 0 };
    const status = effectiveStatus(run, test);
    row.total += 1;
    if (status === "passed") row.passed += 1;
    else if (status === "failed") row.failed += 1;
    else row.classified += 1;
    groups.set(name, row);
  }
  return [...groups.values()].sort((left, right) => right.failed - left.failed || left.name.localeCompare(right.name));
}

function createDocument(run) {
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    lang: "es-AR",
    pdfVersion: "1.5",
    subset: "PDF/UA",
    tagged: true,
    info: {
      Title: `Informe ejecutivo de calidad — ${run.projectName || "Elmulo Reporter"}`,
      Author: "Elmulo Reporter",
      Subject: `Resultados de la corrida ${run.id || "sin identificador"}`,
      Keywords: "calidad, pruebas, Cypress, Elmulo Reporter",
      Creator: "Elmulo Reporter",
      Producer: "PDFKit",
      CreationDate: new Date(),
    },
    margins: { top: 96, right: 34, bottom: 54, left: 34 },
    size: "A4",
  });
  doc.registerFont("Noto", FONT_PATH);
  doc.registerFont("NotoBold", FONT_PATH);
  doc.font("Noto");
  const root = doc.struct("Document");
  doc.addStructure(root);
  return { doc, root };
}

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

class Layout {
  constructor(doc, root, run) {
    this.doc = doc;
    this.root = root;
    this.run = run;
    this.section = root;
    this.contentBottom = 784;
    this.pageNumber = 0;
  }

  addPage(subtitle = "Secciones seleccionadas del informe") {
    this.doc.addPage();
    this.pageNumber += 1;
    this.doc.save().rect(0, 0, this.doc.page.width, this.doc.page.height).fill(COLORS.paper);
    this.doc.rect(0, 0, this.doc.page.width, 8).fill(COLORS.teal).restore();
    this.doc.font("NotoBold").fontSize(9).fillColor(COLORS.teal)
      .text("ELMULO REPORTER", 34, 27, { structParent: this.root, structType: "H2" });
    this.doc.font("NotoBold").fontSize(20).fillColor(COLORS.ink)
      .text("Informe ejecutivo de calidad", 34, 43, { structParent: this.root, structType: "H1" });
    this.doc.font("Noto").fontSize(8.5).fillColor(COLORS.muted)
      .text(subtitle, 34, 70, { structParent: this.root, structType: "P" });
    this.doc.roundedRect(466, 31, 95, 28, 14).fill("#E2F6F5");
    this.doc.font("NotoBold").fontSize(9).fillColor(COLORS.tealDark)
      .text(String(this.run.environment || "N/D").toUpperCase(), 472, 40, {
        align: "center", width: 83, structParent: this.root, structType: "Span",
      });
    this.doc.y = 105;
  }

  ensure(height, options = {}) {
    if (!this.doc.page || this.doc.y + height > this.contentBottom) {
      this.addPage(options.subtitle);
      return true;
    }
    if (options.avoidResidual && this.contentBottom - (this.doc.y + height) < 55) {
      this.addPage(options.subtitle);
      return true;
    }
    return false;
  }

  startSection(title, subtitle, estimatedHeight = 90) {
    this.ensure(49 + estimatedHeight, { subtitle, avoidResidual: estimatedHeight < 140 });
    this.section = this.doc.struct("Sect");
    this.root.add(this.section);
    this.doc.font("NotoBold").fontSize(14).fillColor(COLORS.ink)
      .text(title, 34, this.doc.y, { structParent: this.section, structType: "H2" });
    this.doc.moveDown(0.25);
    this.doc.font("Noto").fontSize(8).fillColor(COLORS.muted)
      .text(subtitle, 34, this.doc.y, { structParent: this.section, structType: "P" });
    this.doc.moveDown(1);
  }

  paragraph(text, options = {}) {
    this.doc.font(options.bold ? "NotoBold" : "Noto")
      .fontSize(options.size || 8.5)
      .fillColor(options.color || COLORS.ink)
      .text(String(text ?? ""), options.x || 34, options.y ?? this.doc.y, {
        width: options.width || 527,
        lineGap: options.lineGap ?? 2,
        structParent: options.structParent || this.section,
        structType: options.structType || "P",
      });
  }

  gap(value = 14) {
    this.doc.y += value;
  }

  finishFooters() {
    const range = this.doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      this.doc.switchToPage(index);
      const previousBottomMargin = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 8;
      this.doc.save();
      this.doc.moveTo(34, 807).lineTo(561, 807).strokeColor(COLORS.line).lineWidth(0.7).stroke();
      this.doc.font("Noto").fontSize(7).fillColor(COLORS.muted)
        .text(`Elmulo Reporter V2 — ${this.run.id || "sin identificador"}`, 34, 815, {
          width: 400, lineBreak: false,
        });
      this.doc.font("NotoBold").text(`Página ${index + 1} de ${range.count}`, 475, 815, {
        width: 86, align: "right", lineBreak: false,
      });
      this.doc.restore();
      this.doc.page.margins.bottom = previousBottomMargin;
    }
  }
}

function metricCards(layout, metrics) {
  const { doc, section } = layout;
  const top = doc.y;
  metrics.forEach(([label, value, color], index) => {
    const x = 34 + index * 106;
    doc.roundedRect(x, top, 98, 58, 8).fill(COLORS.white);
    doc.rect(x, top, 4, 58).fill(color);
    doc.font("NotoBold").fontSize(7.5).fillColor(COLORS.muted)
      .text(label, x + 14, top + 12, { width: 76, structParent: section, structType: "Span" });
    doc.font("NotoBold").fontSize(14).fillColor(COLORS.ink)
      .text(String(value), x + 14, top + 30, { width: 76, structParent: section, structType: "Span" });
  });
  doc.y = top + 70;
}

function drawCover(layout, run, counts) {
  const { doc, root } = layout;
  doc.addPage();
  layout.pageNumber += 1;
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.paper);
  doc.rect(0, 0, doc.page.width, 14).fill(COLORS.teal);
  doc.font("NotoBold").fontSize(10).fillColor(COLORS.teal)
    .text("ELMULO REPORTER", 50, 82, { structParent: root, structType: "H2" });
  doc.font("NotoBold").fontSize(30).fillColor(COLORS.ink)
    .text("Informe ejecutivo\nde calidad", 50, 126, {
      lineGap: 4, structParent: root, structType: "H1",
    });
  doc.font("Noto").fontSize(11).fillColor(COLORS.muted)
    .text(`${run.projectName || "Proyecto"} — ${formatDate(run.startedAt)}`, 50, 222, {
      width: 480, structParent: root, structType: "P",
    });
  const assessment = buildAssessment(counts, (run.tests || []).length);
  doc.roundedRect(50, 288, 495, 126, 12).fill(COLORS.white);
  doc.rect(50, 288, 8, 126).fill(assessment.color);
  doc.font("NotoBold").fontSize(15).fillColor(assessment.color)
    .text(assessment.title, 78, 315, { structParent: root, structType: "H2" });
  doc.font("Noto").fontSize(10).fillColor(COLORS.ink)
    .text(assessment.text, 78, 349, {
      width: 430, lineGap: 4, structParent: root, structType: "P",
    });
  const metadata = [
    ["Corrida", run.id || "Sin identificador"],
    ["Ambiente", run.environment || "Sin ambiente"],
    ["Duración total", formatDuration(run.durationMs)],
    ["Generado", formatDate(new Date().toISOString())],
  ];
  metadata.forEach(([label, value], index) => {
    const y = 475 + index * 48;
    doc.font("NotoBold").fontSize(8).fillColor(COLORS.muted)
      .text(label, 50, y, { structParent: root, structType: "Span" });
    doc.font("NotoBold").fontSize(10).fillColor(COLORS.ink)
      .text(String(value), 50, y + 16, { width: 495, structParent: root, structType: "P" });
  });
}

function summarySection(layout, run, counts, showAssessment) {
  layout.startSection("Resumen ejecutivo", "Indicadores principales y evaluación general", showAssessment ? 160 : 70);
  const total = (run.tests || []).length;
  const cases = new Set((run.tests || []).map((test) => test.caseId || test.id)).size;
  const passRate = total ? Math.round((counts.passed / total) * 1000) / 10 : 0;
  metricCards(layout, [
    ["Casos", cases, COLORS.blue],
    ["Ejecuciones", total, COLORS.teal],
    ["Exitosas", counts.passed, COLORS.green],
    ["Fallidas", counts.failed, COLORS.red],
    ["Éxito", `${passRate}%`, COLORS.purple],
  ]);
  if (!showAssessment) return;
  const assessment = buildAssessment(counts, total);
  const height = 76;
  layout.doc.roundedRect(34, layout.doc.y, 527, height, 9).fill(COLORS.white);
  layout.doc.rect(34, layout.doc.y, 7, height).fill(assessment.color);
  const top = layout.doc.y;
  layout.doc.font("NotoBold").fontSize(11).fillColor(assessment.color)
    .text(assessment.title, 56, top + 14, { structParent: layout.section, structType: "H3" });
  layout.doc.font("Noto").fontSize(8.3).fillColor(COLORS.ink)
    .text(assessment.text, 56, top + 35, {
      width: 480, lineGap: 2, structParent: layout.section, structType: "P",
    });
  layout.doc.y = top + height + 16;
}

function statusSection(layout, run, counts) {
  layout.startSection("Distribución por estado", "Resultados automáticos y clasificaciones manuales", 120);
  const total = (run.tests || []).length;
  let cursor = 34;
  STATUS_DEFINITIONS.forEach(([key, , color]) => {
    const width = total ? (counts[key] / total) * 527 : 0;
    if (width > 0) layout.doc.rect(cursor, layout.doc.y, width, 18).fill(color);
    cursor += width;
  });
  const top = layout.doc.y + 31;
  STATUS_DEFINITIONS.forEach(([key, label, color], index) => {
    const x = 34 + (index % 4) * 132;
    const y = top + Math.floor(index / 4) * 37;
    layout.doc.circle(x + 4, y + 5, 4).fill(color);
    layout.doc.font("NotoBold").fontSize(7).fillColor(COLORS.ink)
      .text(label, x + 14, y, { width: 110, structParent: layout.section, structType: "Span" });
    layout.doc.font("Noto").fontSize(6.8).fillColor(COLORS.muted)
      .text(`${counts[key]} — ${total ? Math.round((counts[key] / total) * 100) : 0}%`, x + 14, y + 13, {
        width: 110, structParent: layout.section, structType: "Span",
      });
  });
  layout.doc.y = top + 82;
}

function recommendationSection(layout, run, counts) {
  layout.startSection("Recomendación y pendientes", "Decisión ejecutiva y seguimiento necesario", 130);
  const assessment = buildAssessment(counts, (run.tests || []).length);
  const top = layout.doc.y;
  layout.doc.roundedRect(34, top, 527, 82, 9).fill(COLORS.white);
  layout.doc.rect(34, top, 7, 82).fill(assessment.color);
  layout.doc.font("NotoBold").fontSize(11).fillColor(assessment.color)
    .text(assessment.title, 56, top + 15, { structParent: layout.section, structType: "H3" });
  layout.doc.font("Noto").fontSize(8).fillColor(COLORS.ink)
    .text(assessment.text, 56, top + 38, {
      width: 475, lineGap: 2, structParent: layout.section, structType: "P",
    });
  const failed = (run.tests || []).filter((test) => effectiveStatus(run, test) === "failed");
  const missingComments = failed.filter((test) => !run.annotations?.[test.id]?.comment).length;
  const missingTickets = failed.filter((test) => !run.annotations?.[test.id]?.ticket).length;
  layout.doc.font("NotoBold").fontSize(8).fillColor(COLORS.ink)
    .text(`${missingComments} fallos sin comentario`, 50, top + 96, {
      width: 240, structParent: layout.section, structType: "P",
    })
    .text(`${missingTickets} fallos sin ticket`, 315, top + 96, {
      width: 230, structParent: layout.section, structType: "P",
    });
  layout.doc.y = top + 130;
}

function contextSection(layout, run) {
  const fields = [
    ["Corrida", run.id || "Sin identificador"],
    ["Ambiente", run.environment || "Sin ambiente"],
    ["Inicio", formatDate(run.startedAt)],
    ["Duración", formatDuration(run.durationMs)],
    ["Navegador", `${run.browser?.name || "Sin navegador"} ${run.browser?.version || ""}`.trim()],
    ["Cypress", run.cypressVersion || "Sin versión"],
    ["Tags", run.tagExpression || "Sin filtro de tags"],
    ["Rama", run.source?.branch || "Sin rama"],
    ["Commit", run.source?.commit || "Sin commit"],
    ["Pipeline", run.source?.pipelineId || "Sin pipeline"],
  ];
  const columnWidth = 256;
  const columnGap = 15;
  const innerWidth = columnWidth - 24;
  const rows = [];
  for (let index = 0; index < fields.length; index += 2) {
    const row = fields.slice(index, index + 2);
    const valueHeights = row.map(([, value]) => {
      layout.doc.font("Noto").fontSize(8);
      return layout.doc.heightOfString(String(value), { width: innerWidth, lineGap: 1 });
    });
    rows.push({ fields: row, height: Math.max(52, 34 + Math.max(...valueHeights)) });
  }

  const estimatedHeight = rows.reduce((sum, row) => sum + row.height + 8, 0);
  layout.startSection("Contexto de la corrida", "Información técnica de la ejecución", estimatedHeight);
  for (const row of rows) {
    layout.ensure(row.height + 8, { subtitle: "Continuación del contexto de la corrida" });
    const top = layout.doc.y;
    row.fields.forEach(([label, value], columnIndex) => {
      const x = 34 + columnIndex * (columnWidth + columnGap);
      layout.doc.roundedRect(x, top, columnWidth, row.height, 7).fill(COLORS.white);
      layout.doc.font("NotoBold").fontSize(7.5).fillColor(COLORS.muted)
        .text(label, x + 12, top + 10, {
          width: innerWidth, lineBreak: false, structParent: layout.section, structType: "P",
        });
      layout.doc.font("Noto").fontSize(8).fillColor(COLORS.ink)
        .text(String(value), x + 12, top + 25, {
          width: innerWidth, lineGap: 1, structParent: layout.section, structType: "P",
        });
    });
    layout.doc.y = top + row.height + 8;
  }
}

function splitTextLines(doc, value, width, font = "Noto", size = 7.2) {
  const text = String(value ?? "");
  doc.font(font).fontSize(size);
  const lines = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words.length ? words : [""]) {
      let pieces = [word];
      if (doc.widthOfString(word) > width) {
        pieces = [];
        let piece = "";
        for (const character of word) {
          if (piece && doc.widthOfString(piece + character) > width) {
            pieces.push(piece);
            piece = character;
          } else piece += character;
        }
        if (piece) pieces.push(piece);
      }
      for (const piece of pieces) {
        const candidate = line ? `${line} ${piece}` : piece;
        if (line && doc.widthOfString(candidate) > width) {
          lines.push(line);
          line = piece;
        } else line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function tableSection(layout, options) {
  const rows = options.rows || [];
  if (!rows.length) {
    layout.startSection(options.title, options.subtitle, 68);
    const top = layout.doc.y;
    layout.doc.roundedRect(34, top, 527, 52, 8).fill("#E2F6F5");
    layout.doc.font("NotoBold").fontSize(8.5).fillColor(COLORS.tealDark)
      .text(options.empty, 50, top + 19, {
        width: 495, structParent: layout.section, structType: "P",
      });
    layout.doc.y = top + 68;
    return;
  }

  let continued = false;
  for (const row of rows) {
    const values = options.values(row).map((value) => String(value ?? ""));
    const widths = options.widths;
    const lineSets = values.map((value, index) =>
      splitTextLines(layout.doc, value, widths[index] - 12, index === 0 ? "NotoBold" : "Noto", 7.1));
    const maxLines = Math.max(...lineSets.map((lines) => lines.length));
    let lineOffset = 0;
    while (lineOffset < maxLines) {
      const availableHeight = layout.doc.page
        ? layout.contentBottom - layout.doc.y - 38
        : 0;
      const maxLinesHere = Math.max(1, Math.floor((availableHeight - 12) / 10));
      const take = Math.min(maxLines - lineOffset, maxLinesHere, 55);
      const rowHeight = Math.max(28, take * 10 + 12);
      if (!layout.doc.page || layout.doc.y + rowHeight + 38 > layout.contentBottom) {
        layout.startSection(
          continued ? `${options.title} — continuación` : options.title,
          options.subtitle,
          Math.min(120, rowHeight + 30),
        );
        continued = true;
        drawTableHeader(layout, options);
      } else if (!continued) {
        layout.startSection(options.title, options.subtitle, Math.min(150, rowHeight + 40));
        drawTableHeader(layout, options);
        continued = true;
      }
      const top = layout.doc.y;
      if ((options._stripeIndex || 0) % 2 === 0) {
        layout.doc.rect(34, top, 527, rowHeight).fill(COLORS.stripe);
      }
      let x = 34;
      lineSets.forEach((lines, index) => {
        const fragment = lines.slice(lineOffset, lineOffset + take).join("\n");
        layout.doc.font(index === 0 ? "NotoBold" : "Noto").fontSize(7.1).fillColor(COLORS.ink)
          .text(fragment, x + 6, top + 6, {
            width: widths[index] - 12,
            lineGap: 1.5,
            structParent: layout.section,
            structType: "TD",
          });
        x += widths[index];
      });
      layout.doc.y = top + rowHeight;
      options._stripeIndex = (options._stripeIndex || 0) + 1;
      lineOffset += take;
    }
  }
  layout.gap(14);
}

function drawTableHeader(layout, options) {
  const top = layout.doc.y;
  layout.doc.roundedRect(34, top, 527, 25, 5).fill(COLORS.ink);
  let x = 34;
  options.headers.forEach((label, index) => {
    layout.doc.font("NotoBold").fontSize(6.8).fillColor(COLORS.white)
      .text(label, x + 6, top + 8, {
        width: options.widths[index] - 12,
        structParent: layout.section,
        structType: "TH",
      });
    x += options.widths[index];
  });
  layout.doc.y = top + 25;
}

function comparisonSection(layout, run) {
  layout.startSection("Comparación con la corrida anterior", "Cambios del mismo ambiente", 95);
  const trends = run.trends?.runs || [];
  const currentIndex = trends.findIndex((item) => item.id === run.id);
  const previous = currentIndex > 0 ? trends[currentIndex - 1] : trends.at(-2);
  const current = trends.find((item) => item.id === run.id) || trends.at(-1);
  if (!previous || !current) {
    const top = layout.doc.y;
    layout.doc.roundedRect(34, top, 527, 58, 8).fill(COLORS.white);
    layout.paragraph("Todavía no hay otra corrida comparable en este ambiente.", {
      x: 50, y: top + 21, width: 495, bold: true,
    });
    layout.doc.y = top + 74;
    return;
  }
  const classified = (item) => ["environment_error", "precondition_error", "outdated_test", "reported"]
    .reduce((sum, key) => sum + Number(item[key] || 0), 0);
  const cards = [
    ["Exitosas", Number(current.passed || 0), Number(previous.passed || 0), COLORS.green, false],
    ["Fallidas", Number(current.failed || 0), Number(previous.failed || 0), COLORS.red, false],
    ["Clasificadas", classified(current), classified(previous), COLORS.amber, false],
    ["Duración", Number(current.duration_ms ?? run.durationMs), Number(previous.duration_ms || 0), COLORS.blue, true],
  ];
  const top = layout.doc.y;
  cards.forEach(([label, value, previousValue, color, isDuration], index) => {
    const x = 34 + index * 132;
    layout.doc.roundedRect(x, top, 122, 78, 8).fill(COLORS.white);
    layout.doc.rect(x, top, 122, 4).fill(color);
    layout.doc.font("NotoBold").fontSize(7).fillColor(COLORS.muted)
      .text(label, x + 11, top + 14, { width: 100, structParent: layout.section, structType: "Span" });
    layout.doc.font("NotoBold").fontSize(11).fillColor(COLORS.ink)
      .text(isDuration ? formatDuration(value) : String(value), x + 11, top + 32, {
        width: 100, structParent: layout.section, structType: "Span",
      });
    const delta = value - previousValue;
    const deltaText = isDuration ? formatDurationDelta(delta) : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta)}`;
    layout.doc.font("Noto").fontSize(6.4).fillColor(COLORS.muted)
      .text(`${deltaText} vs. anterior`, x + 11, top + 56, {
        width: 100, structParent: layout.section, structType: "P",
      });
  });
  layout.doc.y = top + 94;
}

async function buildExecutivePdf(run, options = {}) {
  if (!run || !Array.isArray(run.tests)) {
    throw new Error("La corrida no contiene resultados exportables.");
  }
  const requested = Array.isArray(options.sections) ? options.sections : DEFAULT_PDF_SECTIONS;
  const sections = new Set(requested.filter((section) => PDF_SECTIONS.includes(section)));
  if (!sections.size) throw new Error("Seleccioná al menos una sección para exportar.");

  const { doc, root } = createDocument(run);
  const result = collectPdf(doc);
  const layout = new Layout(doc, root, run);
  const counts = buildStatusSummary(run);
  drawCover(layout, run, counts);

  if (sections.has("summary")) summarySection(layout, run, counts, !sections.has("recommendation"));
  if (sections.has("statusDistribution")) statusSection(layout, run, counts);
  if (sections.has("recommendation")) recommendationSection(layout, run, counts);
  if (sections.has("runContext")) contextSection(layout, run);
  if (sections.has("features")) tableSection(layout, {
    title: "Resultados por Feature",
    subtitle: "Totales y estados agrupados por Feature",
    rows: featureRows(run),
    empty: "No hay Features disponibles en esta corrida.",
    headers: ["Feature", "Total", "Exitosas", "Fallidas", "Clasificadas"],
    widths: [305, 48, 57, 57, 60],
    values: (row) => [row.name, row.total, row.passed, row.failed, row.classified],
  });
  if (sections.has("issues")) tableSection(layout, {
    title: "Problemas que requieren seguimiento",
    subtitle: "Fallos y clasificaciones de la corrida actual",
    rows: (run.tests || []).filter((test) => effectiveStatus(run, test) !== "passed"),
    empty: "No se detectaron problemas abiertos.",
    headers: ["Prueba", "Jira", "Estado", "Duración"],
    widths: [295, 85, 95, 52],
    values: (test) => [
      test.originalTitle || test.title || "Prueba sin nombre",
      jiraId(test),
      STATUS_LABELS[effectiveStatus(run, test)] || "Otro estado",
      formatDuration(test.durationMs),
    ],
  });
  if (sections.has("previousComparison")) comparisonSection(layout, run);
  if (sections.has("recentHistory")) tableSection(layout, {
    title: "Historial reciente",
    subtitle: "Últimas ejecuciones del mismo ambiente",
    rows: (run.trends?.runs || []).slice(-12).reverse(),
    empty: "No hay ejecuciones históricas disponibles.",
    headers: ["Fecha", "Total", "Exitosas", "Fallidas", "% éxito"],
    widths: [290, 52, 62, 62, 61],
    values: (row) => {
      const total = Number(row.total || 0);
      return [
        formatDate(row.started_at), total, Number(row.passed || 0), Number(row.failed || 0),
        `${total ? Math.round((Number(row.passed || 0) / total) * 100) : 0}%`,
      ];
    },
  });
  if (sections.has("flaky")) tableSection(layout, {
    title: "Pruebas inestables",
    subtitle: "Casos que pasaron luego de uno o más reintentos",
    rows: (run.tests || []).filter((test) => test.flaky),
    empty: "No se detectaron pruebas inestables en la corrida actual.",
    headers: ["Prueba", "Detalle"],
    widths: [320, 207],
    values: (test) => [
      test.originalTitle || test.title || "Prueba sin nombre",
      `${test.retries || 0} reintentos — ${test.spec || "Sin especificación"}`,
    ],
  });
  if (sections.has("recurrentFailures")) tableSection(layout, {
    title: "Fallos recurrentes",
    subtitle: "Pruebas con fallos repetidos en el historial",
    rows: run.analytics?.recurrentFailures || [],
    empty: "No se detectaron fallos recurrentes en el historial disponible.",
    headers: ["Prueba", "Detalle"],
    widths: [320, 207],
    values: (test) => [
      test.title || test.originalTitle || "Prueba sin nombre",
      `${test.failures || test.failed || 0} fallos de ${test.executions || 0} ejecuciones — Jira ${test.jira_id || "sin ticket"}`,
    ],
  });
  if (sections.has("slowTests")) tableSection(layout, {
    title: "Pruebas más lentas",
    subtitle: "Ranking histórico por duración",
    rows: run.analytics?.slowest || [],
    empty: "No hay información suficiente para calcular pruebas lentas.",
    headers: ["Prueba", "Detalle"],
    widths: [320, 207],
    values: (test) => [
      test.title || test.originalTitle || "Prueba sin nombre",
      `Promedio ${formatDuration(test.average_duration || test.duration_ms || test.durationMs)} — ${test.spec || "Sin especificación"}`,
    ],
  });

  layout.finishFooters();
  doc.end();
  return result;
}

module.exports = {
  STATUS_DEFINITIONS,
  PDF_SECTIONS,
  DEFAULT_PDF_SECTIONS,
  buildExecutivePdf,
  buildStatusSummary,
  formatDurationDelta,
};
