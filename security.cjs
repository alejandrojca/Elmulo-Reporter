const DEFAULT_MAX_TEXT_LENGTH = 20_000;
const SECRET_PATTERN =
  /((?:authorization|api[-_]?key|token|secret|password|passwd|cookie|set-cookie)\s*[:=]\s*)([^\s,;]+)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;

function redactSecrets(value) {
  return String(value ?? "")
    .replace(BEARER_PATTERN, "$1[REDACTADO]")
    .replace(SECRET_PATTERN, "$1[REDACTADO]")
    .replace(CARD_PATTERN, (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 13 ? `[TARJETA ****${digits.slice(-4)}]` : candidate;
    });
}

function sanitizeText(value, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
  return redactSecrets(value)
    .replace(/\u0000/g, "")
    .slice(0, maxLength);
}

function sanitizeLogEntry(entry = {}) {
  return {
    name: sanitizeText(entry.name || "command", 120),
    message: sanitizeText(entry.message || "", 8_000),
    timestamp: Number.isFinite(Date.parse(entry.timestamp || ""))
      ? new Date(entry.timestamp).toISOString()
      : new Date().toISOString(),
  };
}

function normalizeActor(value) {
  return sanitizeText(value || "Usuario local", 120).trim() || "Usuario local";
}

function isAllowedAttachment(mimeType) {
  return new Set([
    "application/json",
    "application/pdf",
    "image/jpeg",
    "image/png",
    "text/csv",
    "text/plain",
    "video/mp4",
  ]).has(String(mimeType || "").toLowerCase());
}

module.exports = {
  DEFAULT_MAX_TEXT_LENGTH,
  isAllowedAttachment,
  normalizeActor,
  redactSecrets,
  sanitizeLogEntry,
  sanitizeText,
};
