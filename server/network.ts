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
      for (const file of ["local", "agentnet.chat", "zilligons.com"]) {
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
  }
  save() {
    storage.saveNetwork(this.state);
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
  async check() {
    const checks: any[] = [];
    try {
      const response = await fetch("https://authority.iaaso.org/v1/standards", {
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
      const r = await fetch("https://api.uuaid.org/health", {
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
    for (const host of ["agentnet.chat", "zilligons.com"]) {
      try {
        await lookup(host);
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
      version: "0.2.0-alpha.1",
      protocol: "agent-commons/1",
      packageName: "@uuaid/agent-commons",
      release: "packed-locally-not-published",
      node: ">=22.13.0",
      pillarVersion: "2.0.2",
      globalAdmission: "closed-until-credentials-and-pins",
      iaasoStatus: "implementation-draft-not-certified",
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
          name: "Zilligons",
          host: "zilligons.com",
          role: "Fleet utility profiles + contribution origin",
          state: "adapter-prepared-not-deployed",
          namespace: "tenant/zilligons.com",
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
      installLocal: "npm install -g ./uuaid-agent-commons-0.2.0-alpha.1.tgz",
      installAfterPublish:
        "npx --yes @uuaid/agent-commons@0.2.0-alpha.1 init --target zilligons.com",
    };
  }
}
export const networkConsole = new NetworkConsole();
