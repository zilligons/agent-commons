import { readFileSync } from "node:fs";
import {
  createPublicKey,
  createPrivateKey,
  createHash,
  sign,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createProfile,
  contribution,
  signDocument,
} from "../packages/agent-commons/src/profiles.mjs";
import type { Profile } from "../packages/agent-commons/src/index.d.ts";
import { storage } from "./storage";
import { isOffline, isLoopbackUrl } from "../packages/agent-commons/src/offline.mjs";
// L3 Slice 2 v6 §2.3: runtime, loopback transport, and memory store integration
// @ts-ignore
import { AgentCommons, CommonsStore, MemoryLoopbackTransport } from "../packages/agent-commons/src/index.mjs";

type NetworkState = {
  profiles: Profile[];
  contributions: any[];
  checks: any[];
  checkedAt: string | null;
};
export class NetworkConsole {
  state: NetworkState;
  constructor() {
    this.state = storage.loadNetwork() ?? {
      profiles: [],
      contributions: [],
      checks: [],
      checkedAt: null,
    };
    if (!this.state.profiles.length) {
      for (const file of ["local", "agentnet.chat", "zilligon.com"]) {
        this.state.profiles.push(
          createProfile(
            JSON.parse(
              readFileSync(
                `packages/agent-commons/profiles/${file}.json`,
                "utf8",
              ),
            ),
          ),
        );
      }
      this.save();
    }
    if(!this.state.profiles.some(p=>p.namespace==="tenant/zilligon.com")){
      this.state.profiles.push(createProfile(JSON.parse(readFileSync("packages/agent-commons/profiles/zilligon.com.json","utf8"))));
      // Existing content-addressed plural profiles and signed contributions are
      // retained as historical evidence rather than silently rewritten.
      this.save();
    }
  }
  cachedVerification: any = null;
  save() {
    storage.saveNetwork(this.state);
  }

  // L3 Slice 2 v6 §2.3 / §8: Internal scripted self-test with awaited reverse cleanup
  async runChannelVerification(config: any = {}) {
    // Upfront refusal order (§2.3, §8, C2, R2)
    if (config.mode === "global" || (config.mode !== undefined && config.mode !== "local")) {
      throw new Error("Console verification refuses global or non-local mode");
    }
    if (config.carrier && !isLoopbackUrl(config.carrier)) {
      throw new Error(`Console verification refuses remote transports: ${config.carrier}`);
    }
    if (process.env.AGENT_COMMONS_OFFLINE === "0" || !isOffline(process.env)) {
      throw new Error("Console verification requires offline environment (AGENT_COMMONS_OFFLINE != 0)");
    }
    const env = config.env ?? process.env;
    if (env.AGENT_COMMONS_OFFLINE === "0" || !isOffline(env)) {
      throw new Error("Console verification requires offline environment (AGENT_COMMONS_OFFLINE != 0)");
    }
    const profile = config.profile ?? this.state.profiles.find((p) => p.scope === "local") ?? this.state.profiles[0];
    if (!profile || profile.scope === "global") {
      throw new Error("Console verification refuses global profiles");
    }

    // Pinned acquisition order: atlasStore -> lyraStore -> transport
    const acquired: Array<{ name: string; close: () => Promise<void> | void }> = [];
    const cleanupErrors: Array<{ name: string; error: any }> = [];
    let atlasStore: CommonsStore | null = null;
    let lyraStore: CommonsStore | null = null;
    let transport: MemoryLoopbackTransport | null = null;

    try {
      atlasStore = new CommonsStore(":memory:");
      acquired.push({ name: "atlas", close: () => atlasStore?.close() });

      if (config.failureInjection?.storeLyra) {
        throw new Error("construction-failed");
      }
      lyraStore = new CommonsStore(":memory:");
      acquired.push({ name: "lyra", close: () => lyraStore?.close() });

      transport = new MemoryLoopbackTransport({ instanceId: config.instanceId });
      if (config.failureInjection?.transportCloseSync) {
        transport.close = () => { throw new Error("close-failed"); };
      } else if (config.failureInjection?.transportCloseAsync) {
        transport.close = () => Promise.reject(new Error("close-failed"));
      }
      acquired.push({ name: "transport", close: () => transport?.close() });

      const channelUri = config.channelUri ?? "channel://local/community/general";
      const tenantId = config.tenantId ?? "tenant-a";

      const atlasIdentity = this.identity("atlas");
      const atlasKeychain = {
        _identity: atlasIdentity,
        sign: (data: Buffer) => sign(null, data, atlasIdentity.privateKey),
      };
      const lyraIdentity = this.identity("lyra");
      const lyraKeychain = {
        _identity: lyraIdentity,
        sign: (data: Buffer) => sign(null, data, lyraIdentity.privateKey),
      };

      const policy = {
        mode: "local" as const,
        offline: true,
        channelsEnabled: true,
        channels: {
          [channelUri]: {
            members: config.revokedSender
              ? [lyraIdentity.uuaid]
              : (config.revokedReceiver
                ? [atlasIdentity.uuaid]
                : [atlasIdentity.uuaid, lyraIdentity.uuaid]),
            allowForwarding: false,
          },
        },
        agents: {
          [atlasIdentity.uuaid]: {
            kind: "agent" as const,
            publicKey: atlasIdentity.publicKeyHex,
            capabilities: ["commons:message"],
            tenantId: config.mismatchedTenant ? "tenant-b" : tenantId,
          },
          [lyraIdentity.uuaid]: {
            kind: "agent" as const,
            publicKey: lyraIdentity.publicKeyHex,
            capabilities: ["commons:message"],
            tenantId,
          },
        },
        tenantProfiles: {
          [profile.id]: tenantId,
        },
      };

      const atlasRuntime = new AgentCommons({
        keychain: atlasKeychain as any,
        store: atlasStore,
        policy: policy as any,
        transport,
      });
      const lyraRuntime = new AgentCommons({
        keychain: lyraKeychain as any,
        store: lyraStore,
        policy: policy as any,
        transport,
      });

      atlasRuntime.addProfile(profile);
      lyraRuntime.addProfile(profile);

      if (config.failureInjection?.admission) {
        throw new Error("admission-refused");
      }

      const expectedBody = config.body ?? "console verification ping";
      const sendResult = await atlasRuntime.send({
        recipient: lyraIdentity.uuaid,
        profileId: profile.id,
        thread: channelUri,
        body: expectedBody,
      });

      // R1: Require intended envelope carrier acceptance
      const carrierDelivery = sendResult.result?.[0];
      if (
        !carrierDelivery ||
        carrierDelivery.state !== "carrier-accepted" ||
        carrierDelivery.receipt?.accepted !== true
      ) {
        throw new Error(
          `Console verification send unaccepted by carrier: state=${carrierDelivery?.state}`
        );
      }

      const pollResult = await lyraRuntime.poll();
      if (!Array.isArray(pollResult) || pollResult.length === 0) {
        throw new Error("Console verification poll produced empty result");
      }

      // R1: Require matching receiver host acceptance, body, thread, profile
      const received = pollResult.find(
        (item: any) =>
          item.sender === atlasIdentity.uuaid &&
          item.thread === channelUri &&
          item.profileId === profile.id
      );

      if (
        !received ||
        received.accepted !== true ||
        received.rejected === true ||
        received.deferred === true ||
        received.body !== expectedBody ||
        received.receipt?.kind !== "host-accepted"
      ) {
        throw new Error(
          `Console verification received message unaccepted or mismatched: ${JSON.stringify(pollResult)}`
        );
      }

      this.cachedVerification = {
        verifiedAt: new Date().toISOString(),
        channels: [
          {
            channelUri,
            state: "verified-active",
            members: [atlasIdentity.uuaid, lyraIdentity.uuaid],
          },
        ],
        transports: [
          {
            name: "memory",
            state: "operational",
            loopbackSafe: true,
          },
        ],
      };

      return {
        ok: true,
        channelUri,
        profile,
        sendResult,
        pollResult,
        acquired: acquired.map((r) => r.name),
        cleanupErrors,
      };
    } finally {
      // Deterministic reverse-order cleanup: transport -> lyra -> atlas (R3: unconditional awaited per-resource catch)
      for (const resource of [...acquired].reverse()) {
        try {
          config.hooks?.onAttempt?.(resource.name);
          await resource.close();
          config.hooks?.onClose?.(resource.name);
        } catch (error: any) {
          config.hooks?.onCatch?.(error);
          cleanupErrors.push({ name: resource.name, error });
        }
      }
    }
  }
  create(input: { name: string; namespace: string; fixtures: string[] }) {
    if (!/^(local|tenant)\//.test(input.namespace))
      throw new Error(
        "Observer configuration can create local/tenant profiles, not global standards",
      );
    const profile = createProfile({
      ...input,
      scope: input.namespace.startsWith("local/") ? "local" : "tenant",
    });
    if (this.state.profiles.some((p) => p.namespace === profile.namespace))
      throw new Error(
        "This namespace already exists; agents evolve it using signed proposals",
      );
    this.state.profiles.push(profile);
    this.save();
    return profile;
  }
  identity(id: string) {
    const keys = storage.key(id);
    const publicKey = createPublicKey(keys.publicKey),
      privateKey = createPrivateKey(keys.privateKey);
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    // Same published Pillar derivation, without claiming registry registration.
    const hex = createHash("sha256").update(raw).digest("hex").slice(0, 32);
    const local = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return {
      uuaid: `uuaid:foundation:agent:${local}`,
      publicKeyHex: raw.toString("hex"),
      publicKey,
      privateKey,
    };
  }
  prepare(profileId: string) {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error("Unknown local profile");
    const identity = this.identity("atlas");
    const keychain = {
      _identity: identity,
      sign: (data: Buffer) => sign(null, data, identity.privateKey),
    };
    const document = signDocument(keychain as any, "profile-contribution", {
      contribution: contribution(profile),
    });
    const prepared = {
      id: document.id,
      profileId: profile.id,
      profileName: profile.name,
      namespace: profile.namespace,
      createdAt: document.createdAt,
      issuer: identity.uuaid,
      stage: "prepared-no-egress",
      ratified: false,
      fixturesShared: false,
      document,
    };
    this.state.contributions.unshift(prepared);
    this.save();
    return prepared;
  }
  async check(deps: {
    fetchImpl?: typeof fetch;
    lookupImpl?: typeof lookup;
    env?: NodeJS.ProcessEnv;
  } = {}) {
    const env = deps.env ?? process.env;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const lookupImpl = deps.lookupImpl ?? lookup;
    if (isOffline(env)) {
      const checks = [
        {
          service: "IAASO register",
          state: "offline",
          detail: "Offline mode is on. No request was sent to authority.iaaso.org.",
        },
        {
          service: "UUAID registry",
          state: "offline",
          detail: "Offline mode is on. No request was sent to api.uuaid.org.",
        },
        {
          service: "agentnet.chat",
          state: "offline",
          detail: "Offline mode is on. DNS was not queried.",
        },
        {
          service: "zilligon.com",
          state: "offline",
          detail: "Offline mode is on. DNS was not queried.",
        },
      ];
      this.state.checks = checks;
      this.state.checkedAt = new Date().toISOString();
      this.save();
      return checks;
    }
    const checks: any[] = [];
    try {
      const response = await fetchImpl("https://authority.iaaso.org/v1/standards", {
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const records = (await response.json()).standards;
      const standards = ["IAASO-1001", "IAASO-2001", "IAASO-3101", "IAASO-3301"]
        .map((code) => records.find((r: any) => r.code === code))
        .filter(Boolean)
        .map((r: any) => ({
          code: r.code,
          stage: r.stage,
          hash: r.content_hash,
          url: r.doc_url,
        }));
      checks.push({
        service: "IAASO register",
        state:
          standards.length === 4 &&
          standards.every((r: any) => r.stage === "published")
            ? "reachable"
            : "review-required",
        detail:
          "Observed publication records only. No trust-policy pin was changed.",
        standards,
      });
    } catch (e: any) {
      checks.push({
        service: "IAASO register",
        state: "unavailable",
        detail: e.message,
      });
    }
    try {
      const r = await fetchImpl("https://api.uuaid.org/health", {
        signal: AbortSignal.timeout(10000),
      });
      checks.push({
        service: "UUAID registry",
        state: r.ok ? "reachable" : "unavailable",
        detail:
          "Health reachability does not prove any demo identity is registered or accredited.",
      });
    } catch (e: any) {
      checks.push({
        service: "UUAID registry",
        state: "unavailable",
        detail: e.message,
      });
    }
    for (const host of ["agentnet.chat", "zilligon.com"]) {
      try {
        await lookupImpl(host);
        checks.push({
          service: host,
          state: "dns-resolves",
          detail:
            "Target domain resolves. Agent Commons has not been deployed or enrolled here.",
        });
      } catch (e: any) {
        checks.push({
          service: host,
          state: "dns-unresolved",
          detail:
            "Domain lookup failed. Verify this spelling and DNS before deployment.",
        });
      }
    }
    this.state.checks = checks;
    this.state.checkedAt = new Date().toISOString();
    this.save();
    return checks;
  }
  summary() {
    return {
      ...this.state,
      product: "Agent Commons",
      version: "0.2.0-alpha.2",
      protocol: "agent-commons/1",
      packageName: "@uuaid/agent-commons",
      release: "packed-locally-not-published",
      node: ">=22.13.0",
      pillarVersion: "2.0.2",
      globalAdmission: "closed-until-credentials-and-pins",
      offline: isOffline(process.env),
      iaasoStatus: "implementation-draft-not-certified",
      // L3 Slice 2 v6 §2.3: expose channels, transports, and cachedVerification
      channels: this.cachedVerification?.channels ?? [],
      transports: this.cachedVerification?.transports ?? [
        {
          name: "memory",
          state: "idle",
          loopbackSafe: true,
        },
      ],
      cachedVerification: this.cachedVerification ?? null,
      identities: ["atlas", "lyra", "orion", "sentinel"].map((id) => ({
        id,
        uuaid: this.identity(id).uuaid,
        trust: "local-adapter-key-not-registry-registered",
      })),
      targets: [
        {
          name: "Local agent runtime",
          host: "127.0.0.1",
          role: "Host client + private carrier",
          state: "package-tested",
          namespace: "local/fleet",
        },
        {
          name: "AgentNet",
          host: "agentnet.chat",
          role: "Federated conversations + profile exchange",
          state: "adapter-prepared-not-deployed",
          namespace: "tenant/agentnet.chat",
        },
        {
          name: "Zilligon",
          host: "zilligon.com",
          role: "Fleet utility profiles + contribution origin",
          state: "adapter-prepared-not-deployed",
          namespace: "tenant/zilligon.com",
        },
      ],
      layers: [
        {
          name: "UUAID",
          purpose: "Identity, key binding, live credential status",
          state: "SDK-gate-implemented",
        },
        {
          name: "Pillar",
          purpose: "Encrypted envelopes, carriers, durable inbox/outbox",
          state: "wire-tested-2.0.2",
        },
        {
          name: "IAASO",
          purpose: "Published standard pins and global profile authority",
          state: "fail-closed-global-gate",
        },
        {
          name: "Agent Commons",
          purpose: "Scoped utility language, peer evolution, contributions",
          state: "local-runtime-tested",
        },
      ],
      installLocal: "npm install -g ./uuaid-agent-commons-0.2.0-alpha.2.tgz",
      installAfterPublish:
        "npx --yes @uuaid/agent-commons@0.2.0-alpha.2 init --target zilligon.com",
    };
  }
}
export const networkConsole = new NetworkConsole();
