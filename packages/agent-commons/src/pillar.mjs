// Unmodified upstream modules are covered by NOTICE and PROVENANCE.json.
// CarrierClient is wrapped here. The vendored module stays byte-identical to
// @uuaid/pillar 2.0.2. Offline refusal happens before any vendored method runs.
import { CarrierClient as VendoredCarrierClient } from "./vendor/pillar/net/carrier-client.mjs";
import { isLoopbackUrl, isOffline } from "./offline.mjs";

export { Keychain, localIdFromKey } from "./vendor/pillar/identity/keychain.mjs";
export { jcs } from "./vendor/pillar/identity/jcs.mjs";
export { seal, open, decrypt, envelopeSha, ENVELOPE_VERSION } from "./vendor/pillar/net/envelope.mjs";

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

export class CarrierClient extends VendoredCarrierClient {
  constructor(options = {}) {
    super(options);
    // Upstream pillar 2.0.2 does not store env. The package seam does.
    this._offlineEnv = options.env ?? process.env;
  }

  async deliver(envelope, options) {
    const blocked = refusedCarrier(this.carriers, this._offlineEnv);
    if (blocked) throw offlineError(blocked);
    return super.deliver(envelope, options);
  }

  async fetchInbox(base, options) {
    const blocked = refusedCarrier([base], this._offlineEnv);
    if (blocked) throw offlineError(blocked);
    return super.fetchInbox(base, options);
  }

  startPolling(options = {}) {
    const blocked = refusedCarrier(this.carriers, this._offlineEnv);
    if (blocked) {
      const error = offlineError(blocked);
      options.onError?.(error, { carrier: blocked });
      const cursors = { ...(options.cursors ?? {}) };
      return {
        stop() {},
        cursors: () => ({ ...cursors }),
        done: Promise.resolve([]),
      };
    }
    return super.startPolling(options);
  }
}
