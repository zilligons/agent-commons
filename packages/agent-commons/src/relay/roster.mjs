// Cloud Commons relay: owner-signed roster and policy files (spec v3.2
// sections 9.1, 9.2 D3, 12.3). The relay loads both at start and refuses to start
// on a bad signature. No API changes either one. The owner key is pinned by the
// operator, outside the files, so a file cannot vouch for itself.

import { tx, getMeta, setMeta, openRelayDb } from "./schema.mjs";
import { RelayError, isRecordId, sanitizeText } from "./records.mjs";
import { verifyBody, canonicalBytes, sha256Hex, appendLog } from "./signing.mjs";
import { keyBindsAgentUuaid } from "../uuaid-namespace.mjs";
import { jcs } from "../pillar.mjs";

export const ROSTER_V = "commons-relay-roster/1";
export const POLICY_V = "commons-relay-policy/1";
const KINDS = ["ac-seat", "verifier", "security", "scope", "owner", "measurer"];
const HEX64 = /^[0-9a-f]{64}$/;

function verifyOwnerSigned(signed, version, ownerPublicKey, what) {
  if (typeof ownerPublicKey !== "string" || !HEX64.test(ownerPublicKey)) throw new RelayError(`${what}-owner-key-unpinned`, 500);
  const body = signed?.body;
  if (!body || typeof body !== "object" || body.v !== version) throw new RelayError(`${what}-invalid`, 500, "version");
  if (!Number.isSafeInteger(body.version) || body.version < 1 || !Number.isSafeInteger(body.issued_at)) throw new RelayError(`${what}-invalid`, 500, "version/issued_at");
  if (!verifyBody(ownerPublicKey, body, signed.sig)) throw new RelayError(`${what}-signature`, 500);
  return { body, sha: sha256Hex(canonicalBytes({ body, sig: signed.sig })) };
}

/** Version rule shared by both files: same version must be the same bytes; never go back. */
function versionCheck(db, what, version, sha) {
  const current = Number(getMeta(db, `${what}_version`) ?? 0);
  if (version < current) throw new RelayError(`${what}-version-rollback`, 500);
  if (version === current) {
    if (getMeta(db, `${what}_sha256`) !== sha) throw new RelayError(`${what}-version-reused`, 500);
    return false;   // already loaded
  }
  return true;
}

/**
 * Load the owner-signed roster. New principals are added with their keys; an
 * existing principal's kind, family and key never change; a principal absent
 * from a newer roster is retired and its key revoked. A retired principal cannot
 * return (one key ever).
 */
export function loadRoster(db, signed, { ownerPublicKey, now }) {
  const { body, sha } = verifyOwnerSigned(signed, ROSTER_V, ownerPublicKey, "roster");
  for (const key of Object.keys(body)) if (!["v", "version", "issued_at", "principals"].includes(key)) throw new RelayError("roster-invalid", 500, key);
  const list = body.principals;
  if (!Array.isArray(list) || !list.length) throw new RelayError("roster-invalid", 500, "principals");
  const ids = new Set(), keys = new Set();
  for (const p of list) {
    for (const key of Object.keys(p)) if (!["principal_id", "kind", "runtime_family", "public_key", "agent"].includes(key)) throw new RelayError("roster-invalid", 500, key);
    if (!isRecordId(p.principal_id) || ids.has(p.principal_id)) throw new RelayError("roster-invalid", 500, "principal_id");
    if (!KINDS.includes(p.kind)) throw new RelayError("roster-invalid", 500, "kind");
    if (p.runtime_family !== null && !(typeof p.runtime_family === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(p.runtime_family))) throw new RelayError("roster-invalid", 500, "runtime_family");
    if (!HEX64.test(p.public_key ?? "") || keys.has(p.public_key)) throw new RelayError("roster-invalid", 500, "public_key");
    if (!keyBindsAgentUuaid(p.agent, p.public_key) || !p.agent.startsWith("uuaid:agentnet:")) throw new RelayError("roster-invalid", 500, "agent");
    ids.add(p.principal_id); keys.add(p.public_key);
  }
  const owners = list.filter(p => p.kind === "owner");
  if (owners.length !== 1 || owners[0].public_key !== ownerPublicKey) throw new RelayError("roster-owner-mismatch", 500);
  return tx(db, () => {
    if (!versionCheck(db, "roster", body.version, sha)) return { loaded: false, version: body.version };
    for (const p of list) {
      const existing = db.prepare(`SELECT f.kind, f.runtime_family, f.status, k.public_key FROM fleet_principals f
                                     LEFT JOIN keys k ON k.principal_kind = 'fleet' AND k.principal_id = f.principal_id WHERE f.principal_id = ?`).get(p.principal_id);
      if (!existing) {
        db.prepare("INSERT INTO fleet_principals(principal_id, kind, runtime_family, status) VALUES (?, ?, ?, 'active')").run(p.principal_id, p.kind, p.runtime_family);
        db.prepare("INSERT INTO keys(public_key, agent, principal_kind, principal_id, status, added_at, revoked_at) VALUES (?, ?, 'fleet', ?, 'active', ?, NULL)")
          .run(p.public_key, p.agent, p.principal_id, now);
      } else {
        if (existing.status === "retired") throw new RelayError("roster-retired-principal", 500, p.principal_id);
        if (existing.kind !== p.kind || existing.runtime_family !== p.runtime_family || existing.public_key !== p.public_key)
          throw new RelayError("roster-binding-changed", 500, p.principal_id);
      }
    }
    for (const { principal_id } of db.prepare("SELECT principal_id FROM fleet_principals WHERE status = 'active'").all()) {
      if (ids.has(principal_id)) continue;
      db.prepare("UPDATE fleet_principals SET status = 'retired' WHERE principal_id = ?").run(principal_id);
      db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE principal_kind = 'fleet' AND principal_id = ? AND status <> 'revoked'").run(now, principal_id);
    }
    db.prepare("INSERT INTO signed_files(kind, version, body, sig, loaded_at) VALUES ('roster', ?, ?, ?, ?)").run(body.version, jcs(body), signed.sig, now);
    setMeta(db, "roster_version", body.version);
    setMeta(db, "roster_sha256", sha);
    appendLog(db, "security", { kind: "roster.loaded", version: body.version, sha256: sha, principals: list.length }, now);
    return { loaded: true, version: body.version };
  });
}

/** Load the owner-signed policy: lane owners, the 12.3 security path list and the C5 model -> family map. */
export function loadPolicy(db, signed, { ownerPublicKey, now }) {
  const { body, sha } = verifyOwnerSigned(signed, POLICY_V, ownerPublicKey, "policy");
  for (const key of Object.keys(body)) if (!["v", "version", "issued_at", "lanes", "security_paths", "family_map"].includes(key)) throw new RelayError("policy-invalid", 500, key);
  // C5 (9.8): the fixed map of a served model name to its family. Exactly one pattern must
  // match a model for it to earn credit; unknown names earn nothing.
  const map = body.family_map;
  if (!Array.isArray(map) || !map.length || map.some(e => !e || typeof e !== "object" || Object.keys(e).some(k => !["pattern", "family"].includes(k))
    || typeof e.pattern !== "string" || !/^[A-Za-z][A-Za-z0-9.*?_-]{0,63}$/.test(e.pattern)
    || typeof e.family !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(e.family))) throw new RelayError("policy-invalid", 500, "family_map");
  if (new Set(map.map(e => e.pattern)).size !== map.length) throw new RelayError("policy-invalid", 500, "family_map duplicate pattern");
  if (!Array.isArray(body.lanes) || !body.lanes.length) throw new RelayError("policy-invalid", 500, "lanes");
  if (!Array.isArray(body.security_paths) || !body.security_paths.length) throw new RelayError("policy-invalid", 500, "security_paths");
  const paths = body.security_paths.map((p, i) => sanitizeText(p, { field: `security_paths[${i}]`, max: 512 }));
  if (paths.some(p => !p.length)) throw new RelayError("policy-invalid", 500, "security_paths");
  return tx(db, () => {
    if (!versionCheck(db, "policy", body.version, sha)) return { loaded: false, version: body.version };
    for (const l of body.lanes) {
      if (!l || !isRecordId(l.lane) || Object.keys(l).some(k => !["lane", "owner_seat"].includes(k))) throw new RelayError("policy-invalid", 500, "lane");
      const seat = db.prepare("SELECT kind, status FROM fleet_principals WHERE principal_id = ?").get(l.owner_seat ?? "");
      if (!seat || seat.kind !== "ac-seat" || seat.status !== "active") throw new RelayError("policy-invalid", 500, `lane owner ${l.owner_seat}`);
      db.prepare("INSERT INTO lanes(lane, owner_seat) VALUES (?, ?) ON CONFLICT(lane) DO UPDATE SET owner_seat = excluded.owner_seat").run(l.lane, l.owner_seat);
    }
    const row = db.prepare("INSERT INTO policy_family_map(policy_version, pattern, family) VALUES (?, ?, ?)");
    for (const e of map) row.run(body.version, e.pattern, e.family);
    setMeta(db, "security_paths", JSON.stringify(paths));
    db.prepare("INSERT INTO signed_files(kind, version, body, sig, loaded_at) VALUES ('policy', ?, ?, ?, ?)").run(body.version, jcs(body), signed.sig, now);
    setMeta(db, "policy_version", body.version);
    setMeta(db, "policy_sha256", sha);
    appendLog(db, "security", { kind: "policy.loaded", version: body.version, sha256: sha }, now);
    return { loaded: true, version: body.version };
  });
}

/** Start a relay: open relay.db, then load the signed roster and policy. Any failure closes it and refuses. */
export function openRelay({ path = ":memory:", roster, policy, ownerPublicKey, now }) {
  if (!roster || !policy) throw new RelayError("relay-needs-roster-and-policy", 500);
  const db = openRelayDb(path);
  try {
    loadRoster(db, roster, { ownerPublicKey, now });
    loadPolicy(db, policy, { ownerPublicKey, now });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
