/**
 * Carrier client — lets a pillar deliver + receive envelopes through one or
 * more carrier servers using only outbound HTTP(S).
 *
 * This is the universal transport: works from sandboxes, NATed laptops,
 * serverless, anywhere.  No listening socket required.
 */
import { envelopeBodyBytes, preflightBodyBytes } from "../blob/blob.mjs";
import { seedTier } from "./seed-tier.mjs";
import { carrierFix, REFUSAL_FIXES } from "./refusals.mjs";

/**
 * Rank carriers by how proven they are, best first. Unknown carriers rank as
 * `probation` — the primary carrier from a directory has no seed tier and
 * should not be assumed better than a seed that earned one, nor worse.
 * Array.prototype.sort is stable, so a client given no tier information at
 * all keeps its list in exactly the order it was constructed with.
 */
function byTier(tiers) {
  return (a, b) => seedTier(tiers[a] ?? "probation").listRank - seedTier(tiers[b] ?? "probation").listRank;
}

export class CarrierClient {
  /**
   * @param {{keychain: import('../identity/keychain.mjs').Keychain, carriers: string[]}} opts
   *   carriers: base URLs, e.g. ["https://pillar.uuaid.org"]
   */
  /**
   * @param {object} opts
   *   carrierTiers  optional { "<url>": "<seed tier>" } from a directory's
   *                 seeds[]. Drives which carrier's receipt is authoritative
   *                 and which one is polled first — see `deliver`.
   */
  constructor({ keychain, carriers, tierGrant = null, carrierTiers = {} }) {
    if (!keychain?._identity) throw new Error("CarrierClient needs a loaded keychain");
    if (!carriers?.length) throw new Error("CarrierClient needs at least one carrier URL");
    this.keychain = keychain;
    // Normalise tier keys the same way as carrier URLs so a trailing slash on
    // one side does not silently drop a seed to `probation`.
    this.carrierTiers = Object.fromEntries(
      Object.entries(carrierTiers).map(([u, t]) => [String(u).replace(/\/+$/, ""), t]),
    );
    this.carriers = carriers.map(u => u.replace(/\/+$/, "")).sort(byTier(this.carrierTiers));
    // Tier label for the local preflight: a signed grant raises it; default
    // stays community (matches the carrier's unauthenticated tier).
    this.tier = tierGrant?.tier ?? "community";
    this.maxBodyBytes = Number.isInteger(tierGrant?.maxBodyBytes) ? tierGrant.maxBodyBytes : null;
    // Optional signed tier grant (tier.mjs) — sent as a header on deliver so
    // qualifying senders get raised budgets at carriers that trust the issuer.
    this.tierGrantB64 = tierGrant
      ? Buffer.from(JSON.stringify(tierGrant), "utf-8").toString("base64")
      : null;
    this._stopPolling = false;
  }

  get uuaid() { return this.keychain._identity.uuaid; }
  get publicKeyHex() { return this.keychain._identity.publicKeyHex; }

  /**
   * Deliver an envelope to ALL carriers in parallel — p2p seed replication:
   * the message lands on every configured seed (like a file seeded on many
   * peers), so it survives any single carrier dying before the recipient
   * polls.  Duplicate copies are harmless: the recipient mailbox dedups on
   * envelope.id and re-fires no handlers.
   *
   * Resolves once every carrier has answered.  Succeeds if at least one
   * accepted; throws if every carrier rejects.  Returns the receipt from the
   * most PROVEN accepting carrier as the primary ({ carrier, seq, sha,
   * duplicate }) plus `all` with every carrier's outcome ({ carrier, ok,
   * seq?, sha?, duplicate?, error?, status?, reason?, fix? }).
   *
   * When every carrier refuses, the thrown error carries `code` (the most
   * proven carrier's `reason`, else carrier-unreachable / carrier-bad-response),
   * `fix`, `status`, `carrier` and `refusals` (= `all`).
   *
   * Which receipt is primary matters because callers quote its seq back as a
   * cursor and cite its carrier in receipts: it should name a seed that will
   * still be there. With no tier information every carrier ranks equally and
   * the first-in-list receipt wins, exactly as before.
   */
  async deliver(envelope, { timeoutMs = 10000 } = {}) {
    // Preflight against the carrier limits BEFORE any network call: the
    // tier inline limit first, then the 2 MiB direct hard cap — no tier
    // grant can raise the hard cap.  Typed failure, not a carrier 413.
    const pf = preflightBodyBytes(envelopeBodyBytes(envelope), { tier: this.tier, maxBodyBytes: this.maxBodyBytes });
    if (!pf.ok) {
      const e = new Error(`carrier preflight: body ${pf.bytes}B exceeds ${pf.source} limit ${pf.limit}B — use the blob transport`);
      e.code = pf.source === "direct-cap" ? "blob-too-large" : "over-tier-limit";
      e.limit = pf.limit; e.source = pf.source;
      e.fix = REFUSAL_FIXES["over-tier-limit"];
      throw e;
    }
    const attempt = async (base) => {
      try {
        const res = await fetch(`${base}/v1/envelopes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.tierGrantB64 ? { "x-pillar-tier-grant": this.tierGrantB64 } : {}),
          },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await res.text();
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (_error) {}
        if (res.status === 202 && body.accepted) {
          return { carrier: base, ok: true, seq: body.seq, sha: body.sha, duplicate: !!body.duplicate };
        }
        const reason = typeof body.reason === "string" && body.reason ? body.reason
          : typeof body.error === "string" && body.error ? body.error : null;
        return {
          carrier: base, ok: false, status: res.status,
          error: `${res.status} ${body.reason ?? body.error ?? (raw ? "non-json-response" : "empty-response")}`,
          ...(reason ? { reason, fix: (typeof body.fix === "string" && body.fix) || carrierFix(reason) } : {}),
        };
      } catch (e) {
        return { carrier: base, ok: false, error: e.message };
      }
    };
    const all = await Promise.allSettled(this.carriers.map(attempt)).then(rs =>
      rs.map(r => r.status === "fulfilled" ? r.value : { carrier: "?", ok: false, error: String(r.reason) }));
    const accepted = all.filter(r => r.ok);
    if (!accepted.length) {
      const e = new Error(`carrier deliver failed on all carriers: ${all.map(r => `${r.carrier}: ${r.error}`).join("; ")}`);
      // `all` is in rank order, so this is the most proven carrier's answer.
      const primary = all.find(r => r.reason) ?? all.find(r => r.status) ?? null;
      e.code = primary?.reason ?? (primary ? "carrier-bad-response" : "carrier-unreachable");
      e.fix = primary?.fix ?? carrierFix(e.code);
      if (primary) { e.status = primary.status; e.carrier = primary.carrier; }
      e.refusals = all;
      throw e;
    }
    const ranked = accepted.slice().sort((a, b) => byTier(this.carrierTiers)(a.carrier, b.carrier));
    const { carrier, seq, sha, duplicate } = ranked[0];
    return { carrier, seq, sha, duplicate, all };
  }

  /**
   * Fetch envelopes addressed to us with seq > since from a specific carrier.
   * Signed request; carrier verifies our key before serving.
   */
  async fetchInbox(base, { since = 0, waitS = 0, timeoutMs = 40000 } = {}) {
    const path = `GET /v1/inbox/${this.uuaid}?since=${since}`;
    const ts = String(Date.now());
    const sig = this.keychain.sign(Buffer.from(`${path}\n${ts}`, "utf-8")).toString("hex");
    const res = await fetch(`${base}/v1/inbox/${encodeURIComponent(this.uuaid)}?since=${since}&wait=${waitS}`, {
      headers: {
        "x-pillar-pubkey": this.publicKeyHex,
        "x-pillar-ts": ts,
        "x-pillar-sig": sig,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(`inbox fetch ${base}: ${res.status} ${body.error ?? ""}`);
      e.code = typeof body.error === "string" && body.error ? body.error : "carrier-bad-response";
      e.fix = (typeof body.fix === "string" && body.fix) || carrierFix(e.code);
      e.status = res.status; e.carrier = base;
      throw e;
    }
    return res.json(); // { envelopes: [{seq, envelope}], now }
  }

  /**
   * Long-poll every carrier in parallel forever, invoking onEnvelope for each
   * new envelope.  Tracks per-carrier cursor.  Returns a stop() function.
   * onError(error, { carrier }) — the carrier context is passed so callers
   * can attribute failures per carrier in metrics.
   */
  startPolling({ onEnvelope, cursors = {}, waitS = 25, onError }) {
    this._stopPolling = false;
    const state = { cursors: { ...cursors } };
    const loops = this.carriers.map(async (base) => {
      while (!this._stopPolling) {
        try {
          const r = await this.fetchInbox(base, { since: state.cursors[base] ?? 0, waitS });
          for (const { seq, envelope } of r.envelopes) {
            state.cursors[base] = Math.max(state.cursors[base] ?? 0, seq);
            try { await onEnvelope(envelope, { carrier: base, seq }); }
            catch (e) { onError?.(new Error(`onEnvelope threw: ${e.message}`), { carrier: base }); }
          }
        } catch (e) {
          onError?.(e, { carrier: base });
          // Back off on error so a dead carrier doesn't spin the CPU.
          await new Promise(r2 => setTimeout(r2, 2000));
        }
      }
    });
    return {
      stop: () => { this._stopPolling = true; },
      cursors: () => ({ ...state.cursors }),
      done: Promise.allSettled(loops),
    };
  }
}
