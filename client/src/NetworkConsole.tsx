import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./lib/queryClient";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Code2,
  ExternalLink,
  GitBranch,
  Globe2,
  HardDrive,
  Layers3,
  LockKeyhole,
  Plus,
  Send,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
type Profile = {
  id: string;
  name: string;
  namespace: string;
  scope: string;
  revision: number;
  quorum: number;
  fixtures: string[];
  lexicon: Record<string, string>;
  benchmark: {
    tests: number;
    passed: number;
    wireBytes: number;
    originalBytes: number;
    reductionBps: number;
  };
};
type Data = {
  product: string;
  version: string;
  protocol: string;
  packageName: string;
  release: string;
  node: string;
  pillarVersion: string;
  globalAdmission: string;
  iaasoStatus: string;
  profiles: Profile[];
  contributions: {
    id: string;
    profileId: string;
    profileName: string;
    namespace: string;
    createdAt: string;
    issuer: string;
    stage: string;
    ratified: boolean;
    fixturesShared: boolean;
  }[];
  checks: {
    service: string;
    state: string;
    detail: string;
    standards?: { code: string; stage: string; hash: string; url: string }[];
  }[];
  checkedAt: string | null;
  targets: {
    name: string;
    host: string;
    role: string;
    state: string;
    namespace: string;
  }[];
  layers: { name: string; purpose: string; state: string }[];
  identities: { id: string; uuaid: string; trust: string }[];
  installLocal: string;
  installAfterPublish: string;
};
const formSchema = z.object({
  name: z.string().min(2, "Choose a profile name.").max(120),
  namespace: z
    .string()
    .regex(
      /^(local|tenant)\/[a-z0-9][a-z0-9._/-]+$/,
      "Use a lowercase local/ or tenant/ namespace.",
    ),
  fixtures: z
    .string()
    .refine(
      (s) => s.split("\n").filter((x) => x.trim()).length >= 2,
      "Provide at least two utility fixtures, one per line.",
    ),
});
export default function NetworkConsole({ view }: { view: string }) {
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 });
  }, [view]);
  const { data, isLoading, error } = useQuery<Data>({
    queryKey: ["/api/network"],
    refetchInterval: 5000,
  });
  const [createOpen, setCreateOpen] = useState(false),
    [selected, setSelected] = useState<Profile | null>(null),
    [notice, setNotice] = useState("");
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", namespace: "local/", fixtures: "" },
  });
  const mutate = useMutation({
    mutationFn: async ({
      path,
      payload,
    }: {
      path: string;
      payload?: unknown;
    }) => (await apiRequest("POST", path, payload)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/network"] });
      setNotice("");
    },
    onError: (e: Error) => setNotice(e.message.replace(/^\d+:\s*/, "")),
  });
  async function createProfile(values: z.infer<typeof formSchema>) {
    try {
      await mutate.mutateAsync({
        path: "/api/network/profiles",
        payload: {
          ...values,
          fixtures: values.fixtures.split("\n").filter((x) => x.trim()),
        },
      });
      setCreateOpen(false);
      form.reset();
    } catch {}
  }
  async function exportDocument(id: string) {
    try {
      const document = await (
        await apiRequest("GET", `/api/network/contributions/${id}`)
      ).json();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(document, null, 2)], {
          type: "application/json",
        }),
      );
      const anchor = documentCreateAnchor(url);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setNotice(e.message);
    }
  }
  if (isLoading)
    return (
      <section className="detail-page">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </section>
    );
  if (error || !data)
    return (
      <section className="detail-page">
        <div className="error-banner">
          The deployment console is unavailable.{" "}
          <button
            data-testid="network-retry"
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ["/api/network"] })
            }
          >
            Retry
          </button>
        </div>
      </section>
    );
  return (
    <section className="detail-page network-console" ref={pane}>
      {notice && !createOpen && (
        <div className="error-banner" role="alert">
          {notice}
          <button
            data-testid="network-dismiss-error"
            aria-label="Dismiss notice"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {view === "network" ? (
        <>
          <div className="network-hero">
            <div>
              <span className="eyebrow">ONE RUNTIME. MANY COMMONS.</span>
              <h2>Deploy where agents work.</h2>
              <p>
                Private on a laptop. Shared across a fleet. Federated through
                Pillar. Local needs evolve locally; global rules earn
                independent authority.
              </p>
            </div>
            <div className="runtime-badge">
              <Layers3 size={27} />
              <span>
                ACCP-1<small>IMPLEMENTATION DRAFT</small>
              </span>
            </div>
          </div>
          <div className="network-kpis">
            <div>
              <span>Deployment targets</span>
              <strong>
                {data.targets.length}
                <small>local + tenant profiles</small>
              </strong>
            </div>
            <div>
              <span>Portable package</span>
              <strong>
                Node 22+<small>CLI + agent SDK</small>
              </strong>
            </div>
            <div>
              <span>Global admission</span>
              <strong className="muted">
                Fail-closed<small>credentials & pins required</small>
              </strong>
            </div>
          </div>
          <div className="section-actions">
            <h2>Deployment surfaces</h2>
            <span className="pill">NO PUBLIC DEPLOYMENT PERFORMED</span>
          </div>
          <div className="deployment-targets">
            {data.targets.map((t, i) => (
              <article className="deployment-target" key={t.host}>
                <span className="target-number">0{i + 1}</span>
                <div>
                  <h3>
                    {t.name}
                    <code>{t.host}</code>
                  </h3>
                  <p>{t.role}</p>
                  <code className="namespace">{t.namespace}</code>
                </div>
                <span className="status-chip">
                  {t.state === "package-tested"
                    ? "Runtime tested"
                    : "Integration prepared"}
                </span>
              </article>
            ))}
          </div>
          <div className="detail-grid network-split">
            <section className="panel">
              <div className="panel-title">
                <h2>Trust and transport boundaries</h2>
                <ShieldCheck size={17} />
              </div>
              <div className="integration-stack">
                {data.layers.map((layer, i) => (
                  <div key={layer.name}>
                    <span className="stack-order">{i + 1}</span>
                    <div>
                      <strong>{layer.name}</strong>
                      <p>{layer.purpose}</p>
                    </div>
                    <Check size={14} />
                  </div>
                ))}
              </div>
              <p className="panel-note">
                Global gates are implemented and fixture-tested, not enabled for
                the preview identities. A valid credential is not automatic
                ratification authority.
              </p>
            </section>
            <section className="panel install-panel">
              <div className="panel-title">
                <h2>One-line installation</h2>
                <Terminal size={17} />
              </div>
              <div className="install-option">
                <span className="pill">AVAILABLE AS ATTACHED PRERELEASE</span>
                <code>{data.installLocal}</code>
                <p>
                  Install the tested tarball, then run{" "}
                  <code>agent-commons init</code>. Node.js {data.node} is
                  required.
                </p>
              </div>
              <div className="install-option future">
                <span className="pill">AFTER NPM PUBLICATION</span>
                <code>{data.installAfterPublish}</code>
                <p>
                  Package release is prepared. This registry command is not live
                  yet.
                </p>
              </div>
            </section>
          </div>
          <section className="panel">
            <div className="panel-title">
              <h2>Integration readiness</h2>
              <button
                className="button secondary"
                data-testid="check-network-services"
                disabled={mutate.isPending}
                onClick={() => mutate.mutate({ path: "/api/network/check" })}
              >
                <Activity size={14} />
                {mutate.isPending ? "Checking…" : "Check services"}
              </button>
            </div>
            <p className="panel-note">
              Read-only reachability checks. They do not enroll agents, change
              trust pins, publish a package, or deploy either domain.
            </p>
            {data.checks.length ? (
              <div className="readiness-checks">
                {data.checks.map((c) => (
                  <div key={c.service}>
                    <strong>{c.service}</strong>
                    <span
                      className={`status-chip ${["reachable", "dns-resolves"].includes(c.state) ? "adopted" : "pending"}`}
                    >
                      {c.state}
                    </span>
                    <p>{c.detail}</p>
                    {c.standards && (
                      <div className="standards-list">
                        {c.standards.map((s) => (
                          <a
                            key={s.code}
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`standard-${s.code}`}
                          >
                            <code>{s.code}</code>
                            <span>{s.stage}</span>
                            <ExternalLink size={12} />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state compact">
                <Globe2 size={24} />
                <h2>Verify the deployment boundary.</h2>
                <p>
                  Run the read-only check to inspect UUAID, IAASO, and the two
                  target domains.
                </p>
              </div>
            )}
            {data.checkedAt && (
              <p className="panel-note">
                Last checked {new Date(data.checkedAt).toLocaleString()}.
              </p>
            )}
          </section>
        </>
      ) : view === "profiles" ? (
        <>
          <div className="detail-banner">
            <GitBranch size={24} />
            <div>
              <h2>Local utility is not a global fork.</h2>
              <p>
                Every profile has a namespace, immutable content digest, fixture
                corpus, and independent adoption quorum. Older decoders stay
                available.
              </p>
            </div>
            <button
              className="button primary"
              data-testid="create-profile-open"
              onClick={() => {
                setNotice("");
                setCreateOpen(true);
              }}
            >
              <Plus size={14} />
              New profile
            </button>
          </div>
          <div className="profile-grid">
            {data.profiles.map((p) => (
              <article className="panel profile-card" key={p.id}>
                <div className="profile-card-top">
                  <span className="pill">{p.scope.toUpperCase()}</span>
                  <code>r{p.revision}</code>
                </div>
                <h2>{p.name}</h2>
                <code className="namespace">{p.namespace}</code>
                <div className="profile-facts">
                  <div>
                    <span>Lossless checks</span>
                    <strong>
                      {p.benchmark.passed}/{p.benchmark.tests}
                    </strong>
                  </div>
                  <div>
                    <span>Peer quorum</span>
                    <strong>{p.quorum}</strong>
                  </div>
                  <div>
                    <span>Expressions</span>
                    <strong>{Object.keys(p.lexicon).length}</strong>
                  </div>
                </div>
                <div className="profile-digest">
                  <span>SHA-256</span>
                  <code>{p.id.slice(0, 22)}…</code>
                </div>
                <div className="profile-card-actions">
                  <button
                    className="text-button"
                    data-testid={`inspect-profile-${p.namespace}`}
                    onClick={() => setSelected(p)}
                  >
                    Inspect fixtures
                    <ArrowRight size={13} />
                  </button>
                  <button
                    className="button secondary"
                    data-testid={`prepare-profile-${p.namespace}`}
                    disabled={mutate.isPending}
                    onClick={() =>
                      mutate.mutate({
                        path: "/api/network/contributions",
                        payload: { profileId: p.id },
                      })
                    }
                  >
                    <Send size={13} />
                    Prepare contribution
                  </button>
                </div>
              </article>
            ))}
          </div>
          <section className="panel admission">
            <LockKeyhole size={23} />
            <div>
              <h2>Identity and authority do not evolve with the dialect.</h2>
              <p>
                Agents can propose reversible expressions for their own utility
                corpus. They cannot rewrite UUAID bindings, signing rules,
                capability grants, or IAASO governance. Observer-created
                fixtures are configuration, not agent chat messages.
              </p>
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="detail-banner">
            <Send size={24} />
            <div>
              <h2>Contribute evidence. Never silently promote.</h2>
              <p>
                Prepared local profiles become signed candidates. Independent
                review and an exact published IAASO content pin are required
                before global import.
              </p>
            </div>
            <span className="pill">GLOBAL RATIFICATION: NONE</span>
          </div>
          <div className="contribution-pipeline">
            <div>
              <span>01</span>
              <strong>Local utility</strong>
              <p>Private corpus & reversible codec</p>
            </div>
            <ArrowRight size={18} />
            <div>
              <span>02</span>
              <strong>Signed candidate</strong>
              <p>Metadata only by default</p>
            </div>
            <ArrowRight size={18} />
            <div>
              <span>03</span>
              <strong>Independent review</strong>
              <p>Scoped credential & evidence</p>
            </div>
            <ArrowRight size={18} />
            <div>
              <span>04</span>
              <strong>IAASO publication</strong>
              <p>Exact global profile hash</p>
            </div>
          </div>
          <section className="panel">
            <div className="panel-title">
              <h2>Prepared contribution queue</h2>
              <span className="muted">
                {data.contributions.length} local documents
              </span>
            </div>
            {data.contributions.length ? (
              data.contributions.map((c) => (
                <div className="contribution-row" key={c.id}>
                  <Send size={18} />
                  <div>
                    <h3>{c.profileName}</h3>
                    <code>{c.namespace}</code>
                    <p>
                      Signed by <code>{c.issuer}</code>
                    </p>
                    <small>
                      {new Date(c.createdAt).toLocaleString()} · no fixtures
                      disclosed · not transmitted
                    </small>
                  </div>
                  <div>
                    <span className="status-chip pending">
                      Prepared locally
                    </span>
                    <button
                      className="button secondary"
                      data-testid={`export-contribution-${c.id}`}
                      onClick={() => exportDocument(c.id)}
                    >
                      <ArrowDownToLine size={14} />
                      Export JSON
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state compact">
                <Send size={26} />
                <h2>Let local improvements become reviewable evidence.</h2>
                <p>
                  Prepare a candidate from Utility profiles. Nothing leaves this
                  deployment automatically.
                </p>
              </div>
            )}
          </section>
          <section className="panel admission">
            <ShieldCheck size={23} />
            <div>
              <h2>A peer quorum is not a standards body.</h2>
              <p>
                Local adoption can improve a fleet's dialect. It cannot certify
                an agent, publish an IAASO standard, or replace the global
                protocol. Prepared documents in this console are signed metadata
                artifacts, not ratification decisions.
              </p>
            </div>
          </section>
        </>
      )}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="commons-dialog">
          <DialogTitle>Create a utility profile</DialogTitle>
          <DialogDescription>
            Configure a private local or tenant corpus. This does not post to
            agent chat or disclose fixtures globally.
          </DialogDescription>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(createProfile)}
              className="profile-form"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Profile name</FormLabel>
                    <FormControl>
                      <input
                        className="profile-input"
                        data-testid="profile-name"
                        placeholder="Build fleet communication"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="namespace"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Namespace</FormLabel>
                    <FormControl>
                      <input
                        className="profile-input"
                        data-testid="profile-namespace"
                        placeholder="local/build-fleet"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="fixtures"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Utility fixtures, one per line</FormLabel>
                    <FormControl>
                      <textarea
                        className="profile-input"
                        rows={5}
                        data-testid="profile-fixtures"
                        placeholder={
                          "Require a signed delivery receipt before closing a build task.\nA signed delivery receipt must preserve the task identity."
                        }
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {notice && (
                <div className="inline-error" role="alert">
                  {notice}
                </div>
              )}
              <button
                className="button primary launch"
                type="submit"
                data-testid="profile-create-submit"
                disabled={mutate.isPending}
              >
                <Plus size={15} />
                {mutate.isPending ? "Creating…" : "Create private profile"}
              </button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      >
        <DialogContent className="commons-dialog">
          <DialogTitle>{selected?.name}</DialogTitle>
          <DialogDescription>
            Exact fixtures remain inside this deployment unless a contribution
            explicitly includes them.
          </DialogDescription>
          {selected && (
            <>
              <code className="full-digest">{selected.id}</code>
              <div className="profile-fixtures-list">
                {selected.fixtures.map((f, i) => (
                  <div key={i}>
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <p>{f}</p>
                  </div>
                ))}
              </div>
              <div className="stat-pair">
                <span>Fixed-corpus body reduction</span>
                <strong>
                  {(selected.benchmark.reductionBps / 100).toFixed(2)}%
                </strong>
              </div>
              <p className="panel-note">
                This is a fixture benchmark, not proof of optimal language
                efficiency or lower model-token costs.
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
function documentCreateAnchor(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "agent-commons-contribution.json";
  return anchor;
}
