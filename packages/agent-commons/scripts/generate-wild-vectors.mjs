// Generates examples/wild-vectors/wild-v1.json: real wild-format Pillar envelopes and the verdict a receiver must give.
// The keys are TEST-ONLY and derived from fixed labels, so anyone can regenerate and decrypt them. Never use them for
// anything real. Run: node scripts/generate-wild-vectors.mjs
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keychain, seal } from "../src/pillar.mjs";
import { RosterStore, adminCreate, adminChange, buildGroupTag } from "../src/spaces/pillar-group.mjs";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
function testKey(label, ns) {
  const seed = createHash("sha256").update(`agent-commons wild vectors v1 TEST ONLY: ${label}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const raw = der.subarray(der.length - 32);
  const k = new Keychain("unused");
  k._identity = { uuaid: `uuaid:${ns}:agent:${Keychain.localIdFromKey(raw)}`, publicKey: createPublicKey(privateKey), privateKey, publicKeyHex: Buffer.from(raw).toString("hex"), createdAt: "2026-11-08T00:00:00.000Z" };
  return { k, seedHex: seed.toString("hex") };
}
const at = "2026-11-08T21:00:00.000Z";
const recipient = testKey("recipient", "foundation");
const wild = testKey("wild sender (admitted)", "agentnet");
const stranger = testKey("stranger (not admitted)", "pillar");
const to = (s, payload, id) => seal(s.k, { recipient: recipient.k._identity.uuaid, recipientPublicKey: recipient.k._identity.publicKeyHex, kind: "message", payload, id, createdAt: at });

// A space administered by the wild sender, inviting the recipient (v1), then accepting it (v2).
const dir = mkdtempSync(join(tmpdir(), "wild-vectors-"));
const store = new RosterStore(dir);
const { rec: rec1, manifest: m1 } = adminCreate({ store, mailbox: null, keychain: wild.k, name: "wild square room", members: [{ uuaid: recipient.k._identity.uuaid, key: recipient.k._identity.publicKeyHex }] });
const tag1 = { ...buildGroupTag(rec1, { op: "manifest", manifest: m1, msgId: "gm-" + "1".repeat(32) }) };
const { rec: rec2, manifest: m2 } = adminChange({ store, mailbox: null, keychain: wild.k, groupId: rec1.id, action: "accept", opts: { target: recipient.k._identity.uuaid, request: "env-wildvector-iamin-0001" } });
const tag2 = { ...buildGroupTag(rec2, { op: "manifest", manifest: m2, msgId: "gm-" + "2".repeat(32) }) };
const tag3 = { ...buildGroupTag(rec2, { op: "message", msgId: "gm-" + "3".repeat(32) }) };
rmSync(dir, { recursive: true, force: true });

const vectors = {
  v: "agent-commons/wild-vectors/1",
  warning: "TEST-ONLY KEYS. The seeds below are public. Never use these identities for anything real.",
  recipient: { uuaid: recipient.k._identity.uuaid, publicKeyHex: recipient.k._identity.publicKeyHex, seedHex: recipient.seedHex },
  admitted: [{ uuaid: wild.k._identity.uuaid, publicKeyHex: wild.k._identity.publicKeyHex }],
  cases: [
    { name: "plain-dm", about: "A plain-format Pillar DM ({text}) from an admitted, key-pinned sender.", envelopes: [to(wild, { text: "hello from the wild" }, "env-wildvector-plaindm-0001")],
      expect: [{ runtime: "accepted", format: "pillar-plain", text: "hello from the wild" }] },
    { name: "plain-dm-any-shape", about: "A plain payload that is not {text}: still heard, payload intact.", envelopes: [to(wild, { note: "knock", seq: 10020911 }, "env-wildvector-plainany-0001")],
      expect: [{ runtime: "accepted", format: "pillar-plain", payloadKeys: ["note", "seq"] }] },
    { name: "plain-dm-stranger", about: "The same shape from a sender nobody admitted: refused, never heard.", envelopes: [to(stranger, { text: "let me in" }, "env-wildvector-stranger-0001")],
      expect: [{ runtime: "refused", code: "NOT_ADMITTED" }] },
    { name: "group-manifest-invitation", about: "A groups-v2 manifest (version 1) inviting the recipient.", envelopes: [to(wild, { _group: tag1 }, "env-wildvector-manifest-0001")],
      expect: [{ runtime: "accepted", group: rec1.id, groupVerdict: "invitation" }] },
    { name: "plain-in-space-message", about: "Invitation, accept (v2), then a plain message inside the space.", envelopes: [to(wild, { _group: tag1 }, "env-wildvector-space-0001"), to(wild, { _group: tag2 }, "env-wildvector-space-0002"), to(wild, { text: "welcome to the room", _group: tag3 }, "env-wildvector-space-0003")],
      expect: [{ runtime: "accepted", groupVerdict: "invitation" }, { runtime: "accepted", groupVerdict: "accepted" }, { runtime: "accepted", groupVerdict: "accepted", text: "welcome to the room" }] },
  ],
};
const out = new URL("../examples/wild-vectors/wild-v1.json", import.meta.url);
mkdirSync(new URL("../examples/wild-vectors/", import.meta.url), { recursive: true });
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(JSON.stringify({ wrote: out.pathname, cases: vectors.cases.length, space: rec1.id }));
