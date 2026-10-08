import { randomUUID } from "node:crypto";
import { CarrierClient, envelopeSha } from "./pillar.mjs";
import { isOffline, isLoopbackUrl } from "./offline.mjs";

let anonymousInstanceCounter = 0;
const activeLoopbackInstances = new Set();

function refusedCarrier(urls, env) {
  if (!isOffline(env)) return null;
  for (const url of urls ?? []) {
    if (!isLoopbackUrl(url)) return url;
  }
  return null;
}

function offlineError(url) {
  const error = new Error(`offline: refused outbound carrier call to ${url}`);
  error.code = "offline";
  error.carrier = url;
  return error;
}

/**
 * In-memory loopback transport for local unit testing and development.
 * Never performs network operations; assigns stable instance-qualified source IDs.
 * Enforces per-source FIFO execution for live subscriptions.
 */
export class MemoryLoopbackTransport {
  #inboxes = new Map();
  #subscribers = new Map();
  #seq = 0;
  #closed = false;

  constructor(options = {}) {
    if (options.instanceId !== undefined) {
      if (typeof options.instanceId !== "string" || options.instanceId.trim() === "") {
        throw new TypeError("instanceId must be a non-empty string when specified");
      }
      if (activeLoopbackInstances.has(options.instanceId)) {
        const err = new Error(`Duplicate MemoryLoopbackTransport instance qualifier: ${options.instanceId}`);
        err.code = "DUPLICATE_TRANSPORT_INSTANCE";
        throw err;
      }
      this.instanceId = options.instanceId;
    } else {
      anonymousInstanceCounter += 1;
      this.instanceId = `auto-${anonymousInstanceCounter}-${randomUUID().slice(0, 8)}`;
    }

    activeLoopbackInstances.add(this.instanceId);
    this.sourceId = `memory://loopback/${this.instanceId}`;

    this.capabilities = Object.freeze({
      name: "memory",
      canPush: true,
      canPoll: true,
      supportsStreaming: true,
      maxMessageBytes: 64000,
      loopbackSafe: true,
      ...(options.capabilities ?? {})
    });

    this.#inboxes.set(this.sourceId, []);
    this.#subscribers.set(this.sourceId, new Set());
  }

  sources() {
    return [this.sourceId];
  }

  async deliver(envelope, options = {}) {
    if (this.#closed) {
      const err = new Error("Transport is closed");
      err.code = "TRANSPORT_CLOSED";
      throw err;
    }
    if (!envelope || typeof envelope !== "object" || !envelope.id) {
      const err = new Error("Invalid envelope: missing envelope id");
      err.code = "INVALID_ENVELOPE";
      throw err;
    }

    this.#seq += 1;
    const seq = this.#seq;
    const sha = envelopeSha(envelope);
    const item = { seq, envelope: structuredClone(envelope) };

    const queue = this.#inboxes.get(this.sourceId);
    queue.push(item);

    const subs = this.#subscribers.get(this.sourceId);
    if (subs && subs.size > 0) {
      const event = { sourceId: this.sourceId, seq, envelope: structuredClone(envelope) };
      for (const subRecord of subs) {
        // Enqueue onto subscriber's promise tail to guarantee per-subscriber FIFO execution
        subRecord.tail = subRecord.tail
          .then(async () => {
            await subRecord.callback(event);
          })
          .catch(() => {});
      }
    }

    return {
      accepted: true,
      carrier: this.sourceId,
      seq,
      sha,
      duplicate: false,
      all: []
    };
  }

  async fetchInbox(sourceId, options = {}) {
    if (this.#closed) {
      const err = new Error("Transport is closed");
      err.code = "TRANSPORT_CLOSED";
      throw err;
    }
    if (sourceId !== this.sourceId) {
      const err = new Error(`Unknown source ID: ${sourceId}`);
      err.code = "UNKNOWN_SOURCE_ID";
      throw err;
    }

    const since = options.since ?? 0;
    const queue = this.#inboxes.get(this.sourceId) ?? [];
    const matching = queue.filter(item => item.seq > since);

    return {
      sourceId,
      envelopes: matching.map(item => ({
        sourceId,
        seq: item.seq,
        envelope: structuredClone(item.envelope)
      })),
      now: Date.now()
    };
  }

  subscribe(sourceId, onEnvelope) {
    if (this.#closed) {
      const err = new Error("Transport is closed");
      err.code = "TRANSPORT_CLOSED";
      throw err;
    }
    if (sourceId !== this.sourceId) {
      const err = new Error(`Unknown source ID: ${sourceId}`);
      err.code = "UNKNOWN_SOURCE_ID";
      throw err;
    }
    if (typeof onEnvelope !== "function") {
      throw new TypeError("onEnvelope callback must be a function");
    }

    const subRecord = {
      callback: onEnvelope,
      tail: Promise.resolve()
    };

    const subs = this.#subscribers.get(this.sourceId);
    subs.add(subRecord);

    return () => {
      subs.delete(subRecord);
    };
  }

  async close() {
    this.#closed = true;
    activeLoopbackInstances.delete(this.instanceId);
    for (const subs of this.#subscribers.values()) {
      subs.clear();
    }
    this.#subscribers.clear();
    for (const queue of this.#inboxes.values()) {
      queue.length = 0;
    }
    this.#inboxes.clear();
  }
}

/**
 * Adapter wrapping the package-owned guarded CarrierClient to conform to MessageTransport.
 * Enforces offline refusal before ANY delivery or fetch, including for injected clients.
 * Normalizes delivery receipts to include accepted: true and annotates inbox items with sourceId.
 */
export class PillarCarrierTransport {
  constructor(options = {}) {
    this._offlineEnv = options.env ?? options.client?._offlineEnv ?? process.env;
    this.client = options.client ?? new CarrierClient({
      keychain: options.keychain,
      carriers: options.carriers,
      env: this._offlineEnv
    });
    this.capabilities = Object.freeze({
      name: "pillar",
      canPush: false,
      canPoll: true,
      supportsStreaming: false,
      maxMessageBytes: 512000,
      loopbackSafe: false,
      ...(options.capabilities ?? {})
    });
  }

  sources() {
    return this.client.carriers ?? [];
  }

  async deliver(envelope, options = {}) {
    // Enforce offline refusal before invoking any injected or vendored client
    if (isOffline(this._offlineEnv)) {
      const declared = this.sources();
      if (declared.length === 0) {
        throw offlineError("unspecified");
      }
      const blocked = refusedCarrier(declared, this._offlineEnv)
        ?? (envelope?.carrier ? refusedCarrier([envelope.carrier], this._offlineEnv) : null);
      if (blocked) throw offlineError(blocked);
    }

    const res = await this.client.deliver(envelope, options);
    const targetSources = this.sources().length ? this.sources() : (envelope?.carrier ? [envelope.carrier] : []);
    return {
      accepted: true,
      carrier: res.carrier ?? targetSources[0] ?? "unknown",
      seq: res.seq,
      sha: res.sha ?? envelopeSha(envelope),
      duplicate: res.duplicate ?? false,
      all: res.all ?? []
    };
  }

  async fetchInbox(sourceId, options = {}) {
    // Enforce offline refusal before invoking any injected or vendored client
    if (isOffline(this._offlineEnv)) {
      if (!sourceId) {
        throw offlineError("unspecified");
      }
      const blocked = refusedCarrier([sourceId], this._offlineEnv);
      if (blocked) throw offlineError(blocked);
    }

    const knownSources = this.sources();
    if (knownSources.length > 0 && !knownSources.includes(sourceId)) {
      const err = new Error(`Unexpected source ID: ${sourceId}`);
      err.code = "UNEXPECTED_SOURCE_ID";
      throw err;
    }

    const res = await this.client.fetchInbox(sourceId, options);
    return {
      sourceId,
      envelopes: (res.envelopes ?? []).map(item => ({
        sourceId,
        seq: item.seq,
        envelope: item.envelope
      })),
      now: res.now ?? Date.now()
    };
  }

  async close() {
    // CarrierClient is stateless HTTP; no persistent resource to tear down.
  }
}
