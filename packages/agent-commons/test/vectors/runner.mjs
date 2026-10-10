/**
 * Runs the shared pillar-group/2 vectors (test/vectors/README.md of the
 * vectors' home) against one implementation module. Used by the node:test
 * file and by the source-mutant harness, which passes a mutated copy.
 *
 * Every check compares only the fields `expect` names (sends and released are
 * always compared, as multisets). A disagreement is reported, never skipped.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SPEC_REV4_SHA256 = "5ca52d7c36a08e2968ab7a7ecbfe3d09f27fe6269922c6a91f2d58c6bcb221d7";
export const VECTORS_SHA256 = "4c456ca555e5b9f1c4082ea720a4c4bd50affa8e5200095eeff11aa82a7f8c28";
/** The published vectors, copied byte for byte and pinned by VECTORS_SHA256; override with PILLAR_GROUP_V2_VECTORS. */
export const VECTORS_PATH = process.env.PILLAR_GROUP_V2_VECTORS
  ?? join(dirname(fileURLToPath(import.meta.url)), "pillar-group-v2.vectors.json");

/** Read the pinned file. Throws when it is missing or is not the pinned bytes. */
export function loadVectors(path = VECTORS_PATH) {
  if (!existsSync(path)) throw new Error(`vectors not found at ${path}`);
  const raw = readFileSync(path);
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha !== VECTORS_SHA256) throw new Error(`vectors sha256 ${sha} is not the pinned ${VECTORS_SHA256}`);
  const v = JSON.parse(raw.toString("utf-8"));
  if (v.spec?.sha256 !== SPEC_REV4_SHA256) throw new Error(`vectors pin spec ${v.spec?.sha256}, not rev 4 ${SPEC_REV4_SHA256}`);
  return v;
}

const hexOf = (s) => Buffer.from(s, "utf-8").toString("hex");
const canon = (x) => JSON.stringify(x, Object.keys(x).sort());

function diff(id, field, expected, got) { return { id, field, expected, got }; }

/** Items 1–3. Returns a list of disagreements (empty = agree). */
export function runManifestVector(mod, item) {
  const out = [];
  const check = (field, expected, got) => {
    if (JSON.stringify(expected) !== JSON.stringify(got)) out.push(diff(item.id, field, expected, got));
  };
  const bytes = (m, rec) => {
    if (rec.genesisPreimageHex) check("genesisPreimageHex", rec.genesisPreimageHex, hexOf(mod.genesisPreimage(m)));
    if (rec.genesisHash) check("genesisHash", rec.genesisHash, mod.genesisHash(m));
    if (rec.groupId) check("groupId", rec.groupId, mod.idFromGenesisHash(mod.genesisHash(m)));
    if (rec.signingPreimageHex) check("signingPreimageHex", rec.signingPreimageHex, hexOf(mod.signingPreimage(m)));
    if (rec.manifestPreimageHex) check("manifestPreimageHex", rec.manifestPreimageHex, hexOf(mod.canonicalJson(m)));
    if (rec.manifestHash) check("manifestHash", rec.manifestHash, mod.manifestHash(m));
  };
  const verdict = (r, expect) => {
    check("ok", expect.ok, r.ok);
    if (expect.ok) check("action", expect.action, r.action);
    else check("reason", expect.reason, r.reason);
  };
  try {
    if (item.manifest) {
      bytes(item.manifest, item);
      if (item.wrongPreimageHex) {
        const wrong = Buffer.from(item.wrongPreimageHex, "hex").toString("utf-8");
        check("wrongPreimage-gives-id", item.manifest.id, `grp-${createHash("sha256").update(wrong).digest("hex").slice(0, 32)}`);
      }
      verdict(mod.verifyGenesis(item.manifest), item.expect);
    } else if (item.chain) {
      const steps = item.steps ?? [];
      item.chain.forEach((m, i) => { if (steps[i]) bytes(m, steps[i]); });
      const actions = [];
      let r = mod.verifyGenesis(item.chain[0]);
      if (r.ok) actions.push(r.action);
      for (let i = 1; i < item.chain.length && r.ok; i++) {
        r = mod.verifyNext(item.chain[i - 1], item.chain[i]);
        if (r.ok) actions.push(r.action);
      }
      check("chain-ok", true, r.ok ? true : r.reason);
      if (item.expect?.actions) check("actions", item.expect.actions, actions);
    } else if (item.prev && item.candidate) {
      bytes(item.candidate, item);
      verdict(mod.verifyNext(item.prev, item.candidate), item.expect);
    } else {
      out.push(diff(item.id, "layout", "manifest | chain | prev+candidate", Object.keys(item)));
    }
  } catch (e) {
    out.push(diff(item.id, "exception", "no exception", String(e?.stack ?? e).split("\n").slice(0, 2).join(" | ")));
  }
  return out;
}

const sortKey = (o) => JSON.stringify(o, Object.keys(o).sort());
function sameMultiset(a, b) {
  const x = a.map(sortKey).sort(), y = b.map(sortKey).sort();
  return JSON.stringify(x) === JSON.stringify(y);
}
function normSend(s) {
  const o = { to: s.to, op: s.op, mvVersion: s.mvVersion };
  for (const k of ["want", "manifestHash", "conflictsWith"]) if (s[k] !== undefined) o[k] = s[k];
  return o;
}

/** Items 4–13 and the "x" poles. Returns a list of disagreements. */
export function runScenario(mod, sc, defaults) {
  const out = [];
  const r = sc.receiver;
  let rx, lastGroup = r.chain?.[0]?.id ?? null;
  try {
    rx = new mod.GroupReceiver({
      self: r.self,
      store: new mod.MemoryRosterStore(),
      limits: { ...defaults.limits, ...(r.limits ?? {}) },
      allowDelegation: r.allowDelegation ?? defaults.allowDelegation ?? true,
    });
    if (r.chain?.length) rx.adoptVerifiedChain(r.chain);
  } catch (e) {
    return [diff(sc.id, "setup", "receiver built", String(e?.message ?? e))];
  }
  sc.steps.forEach((st, i) => {
    const where = `${sc.id}#${i + 1}`;
    let got;
    try {
      if (st.receive) {
        lastGroup = st.receive.payload?._group?.id ?? lastGroup;
        got = rx.receive(st.receive, st.at);
      } else if (st.tick !== undefined) got = rx.tick(st.at);
      else if (st.askAnother) { lastGroup = st.askAnother; got = rx.askAnother(st.askAnother, st.at); }
      else if (st.beginRecovery) { lastGroup = st.beginRecovery.groupId; got = rx.beginRecovery(st.beginRecovery, st.at); }
      else { out.push(diff(where, "step", "receive | tick | askAnother | beginRecovery", Object.keys(st))); return; }
    } catch (e) {
      out.push(diff(where, "exception", "no exception", String(e?.stack ?? e).split("\n").slice(0, 2).join(" | ")));
      return;
    }
    const e = st.expect;
    const sends = (got.sends ?? []).map(normSend);
    if (!sameMultiset(e.sends ?? [], sends)) out.push(diff(where, "sends", e.sends ?? [], sends));
    if (!sameMultiset(e.released ?? [], got.released ?? [])) out.push(diff(where, "released", e.released ?? [], got.released ?? []));
    for (const f of ["verdict", "reason", "detail"]) {
      if (f in e && e[f] !== (got[f] ?? null)) out.push(diff(where, f, e[f], got[f] ?? null));
    }
    if ("dropped" in e && !sameMultiset(e.dropped, got.dropped ?? [])) out.push(diff(where, "dropped", e.dropped, got.dropped ?? []));
    if ("lateLines" in e && JSON.stringify([...e.lateLines].sort()) !== JSON.stringify([...(got.lateLines ?? [])].sort())) {
      out.push(diff(where, "lateLines", e.lateLines, got.lateLines ?? []));
    }
    if ("knownGroups" in e) {
      const k = rx.knownGroups();
      if (JSON.stringify([...e.knownGroups].sort()) !== JSON.stringify([...k].sort())) out.push(diff(where, "knownGroups", e.knownGroups, k));
    }
    if ("state" in e) {
      const s = rx.state(e.state.groupId ?? lastGroup);
      for (const [f, want] of Object.entries(e.state)) {
        if (JSON.stringify(want) !== JSON.stringify(s[f])) out.push(diff(where, `state.${f}`, want, s[f]));
      }
    }
  });
  return out;
}

/** Run everything (or only `ids`). Returns { results: [{ id, item, disagreements }], agree, disagree }. */
export function runAll(mod, vectors, { ids = null } = {}) {
  const results = [];
  for (const item of vectors.manifests) {
    if (ids && !ids.includes(item.id)) continue;
    results.push({ id: item.id, item: item.item, disagreements: runManifestVector(mod, item) });
  }
  for (const sc of vectors.scenarios) {
    if (ids && !ids.includes(sc.id)) continue;
    results.push({ id: sc.id, item: sc.item, disagreements: runScenario(mod, sc, vectors.defaults) });
  }
  const agree = results.filter((r) => !r.disagreements.length).length;
  return { results, agree, disagree: results.length - agree };
}
