import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/derivation-vectors.json", import.meta.url), "utf8")).vectors;
const keychainHref = process.env.L7_KEYCHAIN_MODULE
  ? pathToFileURL(process.env.L7_KEYCHAIN_MODULE).href
  : new URL("../src/vendor/pillar/identity/keychain.mjs", import.meta.url).href;
const { localIdFromKey } = await import(keychainHref);

test("recorded vectors match vendored localIdFromKey", () => {
  assert.equal(vectors.length, 3);
  for (const vector of vectors) {
    assert.equal(vector.uuaid, `uuaid:foundation:agent:${vector.localId}`);
    const got = localIdFromKey(Buffer.from(vector.rawPublicHex, "hex"));
    assert.equal(got, vector.localId, `vendored derivation mismatch for ${vector.id}`);
  }
});
