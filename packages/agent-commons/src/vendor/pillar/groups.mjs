/**
 * Group threads — the `pillar-group` v1 app convention (INTERACTION-CONVENTION.md
 * "group chats"), as the mobile app and chat-web already speak it.
 *
 * There is still no group key and no wire change: a group message is one
 * ordinary 1:1 envelope per member, and the group rides INSIDE each sealed
 * payload as `_group`. What this adds over the old `{ name, members }` tag is
 * what makes it a thread rather than a fan-out:
 *
 *   id      stable `grp-<16 hex>`, so every member files it under one group
 *   msgId   `gm-…`, identical across the fan-out copies of one message
 *   op      message | create | rename | add | leave (roster changes travel
 *           as ordinary group messages)
 *   keys    optional sealing hints, binding-checked on receipt, so members
 *           can reply to the whole group without a prior contact exchange
 *
 * Every member keeps its own roster (mailbox `groups` table) and applies the
 * same rules: only a current member may rename or add, nobody can remove
 * anyone but themselves, and a group a non-contact drops you into is a
 * pending invitation until you accept it.
 */
import { randomBytes } from "node:crypto";
import { localIdFromKey } from "./identity/keychain.mjs";

export const GROUP_TAG_KEY = "_group";
export const GROUP_TAG_V = 1;
export const GROUP_OPS = Object.freeze(["message", "create", "rename", "add", "leave"]);
export const MAX_GROUP_MEMBERS = 256;
export const MAX_GROUP_NAME = 100;

const GROUP_ID_RE = /^grp-[a-z0-9][a-z0-9-]{3,63}$/i;
const UUAID_RE = /^uuaid:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9][a-z0-9-]*$/i;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

export function isGroupId(id) {
  return typeof id === "string" && GROUP_ID_RE.test(id);
}

export function newGroupId() {
  return `grp-${randomBytes(8).toString("hex")}`;
}

export function newGroupMsgId() {
  return `gm-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

/** The key really owns the uuaid (the same check seal() makes). */
export function keyBindsUuaid(uuaid, publicKeyHex) {
  if (typeof uuaid !== "string" || typeof publicKeyHex !== "string" || !PUBKEY_RE.test(publicKeyHex)) return false;
  try { return localIdFromKey(Buffer.from(publicKeyHex, "hex")) === uuaid.split(":")[3]; }
  catch { return false; }
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * A local id for an id-less tag (an older pillar that sent only
 * `{ name, members }`). Same derivation as the mobile app, so the same
 * conversation groups the same way there and here. Never an authority.
 */
export function deriveGroupId(name, members) {
  const canon = `${String(name).trim().toLowerCase()}|${[...members].sort().join(",")}`;
  const a = djb2(canon).toString(16).padStart(8, "0");
  const b = djb2(canon.split("").reverse().join("")).toString(16).padStart(8, "0");
  return `grp-ref-${a}${b}`;
}

/** Deduplicated, validated member list, order kept. */
export function normalizeMembers(members) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    if (typeof m !== "string" || !UUAID_RE.test(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= MAX_GROUP_MEMBERS) break; // fan-out amplification guard
  }
  return out;
}

/** Parse a `_group` tag out of a decrypted payload; null when absent or unusable. */
export function extractGroupTag(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const g = payload[GROUP_TAG_KEY];
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  const name = typeof g.name === "string" ? g.name.trim().slice(0, MAX_GROUP_NAME) : "";
  const members = normalizeMembers(g.members);
  if (!members.length) return null;
  const derivedId = !isGroupId(g.id);
  const id = derivedId ? deriveGroupId(name || "group", members) : g.id;
  let keys;
  if (g.keys && typeof g.keys === "object" && !Array.isArray(g.keys)) {
    for (const [u, pk] of Object.entries(g.keys)) {
      if (UUAID_RE.test(u) && typeof pk === "string" && PUBKEY_RE.test(pk)) (keys ??= {})[u] = pk.toLowerCase();
    }
  }
  const msgId = typeof g.msgId === "string" && g.msgId.length > 0 && g.msgId.length <= 64 ? g.msgId : null;
  const op = typeof g.op === "string" && GROUP_OPS.includes(g.op) ? g.op : "message";
  return { v: typeof g.v === "number" ? g.v : GROUP_TAG_V, id, name: name || "Group", members, keys, msgId, op, derivedId };
}

/** The `_group` tag for an outbound payload. */
export function buildGroupTag(group, { msgId, keys, op = "message" }) {
  const tag = { v: GROUP_TAG_V, id: group.id, name: group.name, members: [...group.members], msgId };
  if (keys && Object.keys(keys).length) tag.keys = keys;
  if (op && op !== "message") tag.op = op;
  return tag;
}

/**
 * Fold an inbound tag into the local roster (mailbox `groups`). Returns the
 * group as stored, or null when the tag changed nothing we keep.
 *
 *   unknown group -> join it; pending when the sender is not a contact. A
 *                    wire id (not derived here) needs the SENDER on its own
 *                    roster: the first tag seen for an id sets the roster, so
 *                    a stranger must not be able to seed it, and after that
 *                    the real members would be the strangers
 *   known group   -> only a current MEMBER may change it: `leave` drops the
 *                    sender, `create`/`rename` set the name, every op unions
 *                    new members in; a re-`add` naming us clears our `left`
 *   key hints     -> kept per group, only when the key derives its uuaid;
 *                    they let us SEAL to a member, and never make anyone a
 *                    trusted sender (the address book and trust.json do that)
 */
export function absorbGroupTag(mailbox, tag, { sender, self, text = "", fromContact = false }) {
  const hints = {};
  for (const [u, pk] of Object.entries(tag.keys ?? {})) {
    if (u !== self && keyBindsUuaid(u, pk)) hints[u] = pk;
  }
  const existing = mailbox.getGroup(tag.id);
  if (!existing) {
    if (!tag.derivedId && !tag.members.includes(sender)) return null;
    const members = tag.members.includes(self) ? tag.members : [...tag.members, self];
    return mailbox.putGroup({
      id: tag.id, name: tag.name, members, keys: hints, createdBy: sender, pending: !fromContact,
    });
  }
  if (!existing.members.includes(sender)) return existing; // strangers cannot touch our roster
  const keys = { ...hints, ...existing.keys }; // first key wins
  if (tag.op === "leave") {
    return mailbox.putGroup({ ...existing, keys, members: existing.members.filter((m) => m !== sender) });
  }
  const members = [...existing.members];
  for (const m of tag.members) if (!members.includes(m) && members.length < MAX_GROUP_MEMBERS) members.push(m);
  const addedUs = tag.op === "add" && String(text).split(",").map((x) => x.trim()).includes(self);
  return mailbox.putGroup({
    ...existing,
    keys,
    members,
    name: tag.op === "rename" || tag.op === "create" ? tag.name : existing.name,
    left: existing.left && !addedUs,
  });
}

/**
 * Resolve a group by exact id, else by unique case-insensitive name.
 * Throws with the candidates listed when the name is ambiguous or unknown.
 */
export function findGroup(mailbox, ref) {
  const byId = mailbox.getGroup(ref);
  if (byId) return byId;
  const all = mailbox.listGroups();
  const hits = all.filter((g) => g.name.toLowerCase() === String(ref).toLowerCase());
  if (hits.length === 1) return hits[0];
  const e = new Error(hits.length
    ? `group name "${ref}" is ambiguous: ${hits.map((g) => g.id).join(", ")} — use the id`
    : `no group "${ref}" in this home${all.length ? ` (known: ${all.map((g) => `${g.name} ${g.id}`).join("; ")})` : ""} — list them with: pillar groups`);
  e.code = hits.length ? "group-ambiguous" : "group-unknown";
  throw e;
}
