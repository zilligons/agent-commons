// Cloud Commons relay, L0: record types, field allowlists, size caps and the
// text sanitizer (spec v3.2 sections 7.1-7.3, 11.4). Pure; no I/O.

export class RelayError extends Error {
  constructor(code, status = 400, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
  }
}

export const RECORD_CAPS = Object.freeze({ record: 65536, patch: 262144, enrollment: 4096 });
export const PATCH_MAX_FILES = 20;
export const ROLES = Object.freeze(["C0", "C1", "C2", "C3"]);

// Signed fleet record formats (version tags). Kept here so the reducer and the
// offline export verifier share them without importing each other.
export const DECISION_V = "commons-relay-decision/1";
// /2 binds the verdict's position (verifier finding B1): seq is the signer's next verdict number on
// the decision, prev the sha256 of the signer's previous signed verdict body there.
export const APPROVAL_V = "commons-relay-approval/2";
export const VERIFY_V = "commons-relay-verify/1";
export const SECURITY_V = "commons-relay-security/1";
export const OWNER_CONFIRM_V = "commons-relay-owner-confirm/1";
export const COAUTHOR_V = "commons-relay-coauthor/1";
export const SEAT_MESSAGE_V = "commons-relay-seat-message/1";
export const FINDING_OPEN_V = "commons-relay-finding-open/1";
export const FINDING_CLOSE_V = "commons-relay-finding-close/1";
// The family a seat ASSERTS in its served_by, "measured:<family>[:<model>]". Since Addendum
// C5 (spec 9.8) an assertion alone earns no family credit: credit needs a measurer's
// attestation of that verdict whose family equals this assertion.
const MEASURED = /^measured:([a-z][a-z0-9-]{0,31})(?::[A-Za-z0-9._/@+-]{1,80})?$/;
export const measuredFamily = (servedBy) => MEASURED.exec(typeof servedBy === "string" ? servedBy : "")?.[1] ?? null;

// C5 (9.8): a measurer's evidence of which model really served a verdict's turn.
export const ATTEST_V = "commons-relay-attest/1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** JCS refuses fractions; the relay also refuses integers outside +/-(2^53-1) (B4). */
export function assertIntegerOnly(value, path = "body") {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RelayError("non-integer-number", 400, path);
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (Array.isArray(value)) { value.forEach((v, i) => assertIntegerOnly(v, `${path}[${i}]`)); return; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) assertIntegerOnly(v, `${path}.${k}`);
    return;
  }
  throw new RelayError("unsupported-value", 400, path);
}

// Refused, never stripped (7.3): C0 controls except tab and newline (CR included),
// DEL, C1 controls, every format character (Cf, which covers bidi controls,
// zero-width characters, BOM, soft hyphen, U+061C), and U+2028/U+2029.
const FORBIDDEN = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029\\p{Cf}]", "u");

export function sanitizeText(value, { field = "text", max, patch = false } = {}) {
  if (typeof value !== "string") throw new RelayError("invalid-field", 400, `${field} must be text`);
  if (!value.isWellFormed()) throw new RelayError("invalid-utf8", 400, field);
  let text = value.normalize("NFC");
  if (patch) text = text.replace(/\r\n/g, "\n");
  if (FORBIDDEN.test(text)) throw new RelayError("hidden-character", 422, field);
  if (max !== undefined && Buffer.byteLength(text, "utf8") > max) throw new RelayError("field-too-long", 400, field);
  return text;
}

const id = (v, f) => { if (typeof v !== "string" || !ID.test(v)) throw new RelayError("invalid-field", 400, f); return v; };
const int = (v, f, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RelayError("invalid-field", 400, f);
  return v;
};
const oneOf = (values) => (v, f) => { if (!values.includes(v)) throw new RelayError("invalid-field", 400, f); return v; };
const text = (max) => (v, f) => sanitizeText(v, { field: f, max });

// Member record types (7.2). minRole is enforced by the permission table in
// governance.mjs; it is repeated here only so the two tables can be compared.
export const MEMBER_RECORD_TYPES = Object.freeze({
  heartbeat: { minRole: "C0", fields: { claim_id: [id, false], epoch: [(v, f) => int(v, f, { min: 1 }), false] } },
  message: { minRole: "C0", fields: { lane: [id, true], text: [text(8192), true], reply_to: [id, false] } },
  note: { minRole: "C0", fields: { text: [text(4096), true] } },
  claim: { minRole: "C1", fields: { task_id: [id, true], lease_ms: [(v, f) => int(v, f, { min: 60000, max: 86400000 }), false] } },
  release: { minRole: "C1", fields: { claim_id: [id, true], epoch: [(v, f) => int(v, f, { min: 1 }), true] } },
  progress: { minRole: "C1", fields: { claim_id: [id, true], epoch: [(v, f) => int(v, f, { min: 1 }), true], text: [text(2048), true] } },
  result: { minRole: "C1", fields: { claim_id: [id, true], epoch: [(v, f) => int(v, f, { min: 1 }), true], kind: [oneOf(["patch", "report"]), true], body: [null, true] } },
  evidence: { minRole: "C1", fields: { submission_id: [id, true], kind: [id, true], text: [text(16384), true] } },
  "review-request": { minRole: "C1", fields: { submission_id: [id, true] } },
  propose: { minRole: "C2", fields: { title: [text(120), true], description: [text(4096), true], lane: [id, true], acceptance: [text(4096), true] } },
  "advisory-review": { minRole: "C2", fields: { target: [id, true], verdict: [oneOf(["looks-good", "concern"]), true], text: [text(4096), true] } },
});

/**
 * Validate one member record {type, record_id, body}. Order (7.1): size cap,
 * known type, integer-only, strict field allowlist, per-field checks and
 * sanitizing. Returns a normalized copy; never mutates the input.
 */
export function validateMemberRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new RelayError("invalid-record", 400);
  const type = record.type;
  const cap = type === "result" ? RECORD_CAPS.patch : RECORD_CAPS.record;
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(record), "utf8"); } catch { throw new RelayError("invalid-record", 400); }
  if (bytes > cap) throw new RelayError("record-too-large", 413);
  const spec = Object.hasOwn(MEMBER_RECORD_TYPES, type) ? MEMBER_RECORD_TYPES[type] : null;
  if (!spec) throw new RelayError("unknown-record-type", 400, String(type).slice(0, 40));
  for (const key of Object.keys(record)) if (!["type", "record_id", "body"].includes(key)) throw new RelayError("unknown-field", 400, key);
  assertIntegerOnly(record);
  const recordId = id(record.record_id, "record_id");
  const body = record.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RelayError("invalid-record", 400, "body");
  for (const key of Object.keys(body)) if (!Object.hasOwn(spec.fields, key)) throw new RelayError("unknown-field", 400, key);
  const out = {};
  for (const [field, [check, required]] of Object.entries(spec.fields)) {
    if (!Object.hasOwn(body, field) || body[field] === null) {
      if (required) throw new RelayError("missing-field", 400, field);
      continue;
    }
    out[field] = check ? check(body[field], field) : body[field];
  }
  if (type === "heartbeat" && (out.claim_id === undefined) !== (out.epoch === undefined)) throw new RelayError("invalid-field", 400, "claim_id and epoch go together");
  if (type === "result") out.body = validateResultBody(out.kind, body.body);
  return { type, record_id: recordId, body: out };
}

/** A patch result is a list of {path, diff}, one diff per file, at most 20 files (12.1). A report is text. */
function validateResultBody(kind, value) {
  if (kind === "report") return sanitizeText(value, { field: "body", max: RECORD_CAPS.record });
  if (!Array.isArray(value) || value.length === 0) throw new RelayError("invalid-field", 400, "body must list patch files");
  if (value.length > PATCH_MAX_FILES) throw new RelayError("too-many-files", 400);
  const seen = new Set();
  return value.map((file, i) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new RelayError("invalid-field", 400, `body[${i}]`);
    for (const key of Object.keys(file)) if (!["path", "diff"].includes(key)) throw new RelayError("unknown-field", 400, `body[${i}].${key}`);
    const path = sanitizeText(file.path, { field: `body[${i}].path`, max: 512 });
    if (seen.has(path)) throw new RelayError("invalid-field", 400, `duplicate path ${path}`);
    seen.add(path);
    return { path, diff: sanitizeText(file.diff, { field: `body[${i}].diff`, max: RECORD_CAPS.patch, patch: true }) };
  });
}

export const isHex64 = (v) => typeof v === "string" && HEX64.test(v);
export const isRecordId = (v) => typeof v === "string" && ID.test(v);
