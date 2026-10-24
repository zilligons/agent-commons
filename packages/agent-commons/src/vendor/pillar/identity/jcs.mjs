/**
 * RFC 8785 JCS canonicalization.  Same implementation as the pillar-core reference,
 * kept independent so the pillar-node package has no upward dependency.
 *
 * Numbers: integers only (safe for the wire we design; enforce it).  Floats
 * throw because deterministic ECMA-262 number serialization requires more code
 * than we want in a reference impl and this package's message payloads never
 * legitimately contain non-integer numbers.
 */
export function jcs(value) {
  return _ser(value);
}

function _ser(v) {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("JCS: NaN/Infinity not permitted");
    if (Number.isInteger(v)) return String(v);
    throw new Error("JCS: non-integer numbers not permitted; use string decimal encoding");
  }
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return "[" + v.map(_ser).join(",") + "]";
  if (typeof v === "object") {
    // RFC 8785 §3.2.3: keys sort by their UTF-16 code units, which is exactly
    // JavaScript's default string order. (Comparing UTF-16LE *bytes* is not: it
    // puts "Ā" (U+0100) before "a", and disagreed with @uuaid/pillar-client.)
    const keys = Object.keys(v).sort(); // @rule jcs.code-unit-order
    return "{" + keys.map(k => JSON.stringify(k) + ":" + _ser(v[k])).join(",") + "}";
  }
  throw new Error("JCS: unsupported type " + typeof v);
}
