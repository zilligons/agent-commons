import { useEffect, useRef, useState } from "react";
import {
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { queryClient, apiRequest } from "./lib/queryClient";
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  GitBranch,
  Hash,
  Hexagon,
  LockKeyhole,
  Menu,
  Moon,
  Network,
  Pause,
  Play,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  Workflow,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { Agent, CommonsState, Message } from "@shared/schema";
import NetworkConsole from "./NetworkConsole";
import CohortConsole from "./CohortConsole";
import "./network.css";
import "./cohort.css";
type State = CommonsState & {
  codec: { tests: number; passed: number; reduction: number };
};
const models: Record<string, string> = {
  gpt5_mini: "GPT-5 Mini",
  gpt5_nano: "GPT-5 Nano",
  claude_haiku_4_5: "Claude Haiku 4.5",
  gemini_3_flash: "Gemini 3 Flash",
  gemini_3_7_flash: "Gemini 3.7 Flash",
};
const nav = [
  { id: "cohort", label: "Founding cohort", icon: Users },
  { id: "network", label: "Deployment network", icon: Network },
  { id: "profiles", label: "Utility profiles", icon: GitBranch },
  { id: "contributions", label: "Global contributions", icon: Workflow },
  { id: "conversation", label: "Conversation", icon: Radio },
  { id: "protocol", label: "Protocol lab", icon: Workflow },
  { id: "agents", label: "Agent registry", icon: Users },
  { id: "health", label: "Recovery center", icon: ShieldCheck },
  { id: "ledger", label: "Event ledger", icon: BookOpen },
];
const channels = [
  { id: "commons", name: "commons", desc: "The shared conversation" },
  {
    id: "evolution",
    name: "protocol-evolution",
    desc: "Proposal and peer review",
  },
  { id: "language", name: "language-design", desc: "Lexicon and semantics" },
  { id: "recovery", name: "self-healing", desc: "Recovery and containment" },
];
function Logo() {
  return (
    <svg
      aria-label="Agent Commons logo"
      viewBox="0 0 32 32"
      className="logo"
      fill="none"
    >
      <path
        d="M16 2 29 9.5v13L16 30 3 22.5v-13Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="m3 9.5 13 7.5 13-7.5M16 17v13M9.5 5.75v13l13 7.5M22.5 5.75v13l-13 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
function Avatar({ agent, small = false }: { agent: Agent; small?: boolean }) {
  return (
    <span className={`avatar ${agent.color} ${small ? "small" : ""}`}>
      {agent.name.slice(0, 1)}
      <span
        className={`presence ${agent.status === "quarantined" ? "bad" : ""}`}
      />
    </span>
  );
}
function NetworkMap({
  agents,
  busy,
}: {
  agents: Agent[];
  busy: string | null;
}) {
  return (
    <div
      className="network-map"
      aria-label="Internal four-agent communication topology"
    >
      <div className="network-lines">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="network-core">
        <Logo />
      </div>
      {agents.map((a, i) => (
        <div
          key={a.id}
          className={`network-node node-${i} ${busy === a.id ? "thinking" : ""}`}
        >
          <Avatar agent={a} small />
          <span>{a.name}</span>
        </div>
      ))}
    </div>
  );
}
function Workspace() {
  const {
    data: s,
    isLoading,
    error,
  } = useQuery<State>({ queryKey: ["/api/state"], refetchInterval: 1500 });
  const [view, setView] = useState("cohort"),
    [channel, setChannel] = useState("commons"),
    [search, setSearch] = useState(""),
    [wire, setWire] = useState(false),
    [drawer, setDrawer] = useState(false);
  const [theme, setTheme] = useState(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [modal, setModal] = useState<"run" | "help" | null>(null),
    [packet, setPacket] = useState<Message | null>(null),
    [mode, setMode] = useState<"simulation" | "live">("simulation"),
    [limit, setLimit] = useState(9),
    [selected, setSelected] = useState(["atlas", "lyra", "orion", "sentinel"]),
    [actionError, setActionError] = useState(""),
    [copied, setCopied] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const action = useMutation({
    mutationFn: async ({ path, data }: { path: string; data?: unknown }) => {
      const r = await apiRequest("POST", path, data);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/state"] });
      setActionError("");
    },
    onError: (e: Error) => setActionError(e.message.replace(/^\d+: /, "")),
  });
  const run = async () => {
    try {
      await action.mutateAsync({
        path: "/api/start",
        data: { mode, limit, selected },
      });
      setModal(null);
    } catch {}
  };
  const choose = (v: string) => {
    setView(v);
    setDrawer(false);
    setSearch("");
  };
  const openRun = () => {
    setMode(s?.mode ?? "simulation");
    setSelected(s?.selected ?? selected);
    setActionError("");
    setModal("run");
  };
  const exportLedger = async () => {
    try {
      const r = await apiRequest("GET", "/api/export");
      const blob = new Blob([JSON.stringify(await r.json(), null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "commons-ledger.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setActionError(e.message);
    }
  };
  const scrollLatest = () => {
    feed.current?.scrollTo({
      top: feed.current.scrollHeight,
      behavior: "smooth",
    });
  };
  useEffect(() => {
    if ((s?.running || s?.mode === "live") && !search)
      feed.current?.scrollTo({
        top: feed.current.scrollHeight,
        behavior: "smooth",
      });
  }, [s?.messages.length, s?.busy, s?.running, s?.mode, channel, search, view]);
  const status = s?.running
    ? "Session active"
    : s?.busy
      ? "Finishing turn"
      : "Session paused";
  const messages =
    s?.messages.filter(
      (m) =>
        m.mode === s.mode &&
        (channel === "commons" || m.channel === channel) &&
        (!search ||
          `${m.body} ${m.agent} ${m.kind}`
            .toLowerCase()
            .includes(search.toLowerCase())),
    ) ?? [];
  const bytes = s?.messages.reduce((t, m) => t + m.bytes, 0) ?? 0,
    original = s?.messages.reduce((t, m) => t + m.originalBytes, 0) ?? 0;
  const saving = original ? ((1 - bytes / original) * 100).toFixed(1) : "0.0";
  const title =
    view === "conversation"
      ? channels.find((c) => c.id === channel)?.name
      : nav.find((n) => n.id === view)?.label;
  const networkView = ["network", "profiles", "contributions", "cohort"].includes(view);
  return (
    <div className="app-shell">
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      {drawer && (
        <button
          className="drawer-scrim"
          aria-label="Close navigation"
          data-testid="close-navigation"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside className={`sidebar ${drawer ? "open" : ""}`}>
        <div className="brand">
          <Logo />
          <div>
            <strong>
              Agent Commons<span className="brand-dot">.</span>
            </strong>
            <span>AGENT NETWORK</span>
          </div>
        </div>
        <button
          className="workspace-select"
          data-testid="workspace-info"
          onClick={() => setModal("help")}
        >
          <span className="workspace-icon">
            <Hexagon size={18} />
          </span>
          <span>
            Reference workspace<small>Local + global communications</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              data-testid={`nav-${n.id}`}
              className={`nav-item ${view === n.id ? "active" : ""}`}
              onClick={() => choose(n.id)}
            >
              <n.icon size={17} />
              <span>{n.label}</span>
              {n.id === "conversation" && (
                <span className="nav-count">{s?.messages.length ?? 0}</span>
              )}
              {n.id === "health" && <span className="tiny-dot" />}
            </button>
          ))}
        </nav>
        <div className="nav-label channel-label">
          CHANNELS <LockKeyhole size={12} />
        </div>
        <nav aria-label="Agent channels">
          {channels.map((c) => (
            <button
              key={c.id}
              className={`channel-item ${view === "conversation" && channel === c.id ? "selected" : ""}`}
              data-testid={`channel-${c.id}`}
              onClick={() => {
                choose("conversation");
                setChannel(c.id);
              }}
            >
              <Hash size={16} />
              <span>{c.name}</span>
              {c.id === "commons" && <span className="tiny-dot" />}
            </button>
          ))}
        </nav>
        <div className={`agent-sidebar ${networkView ? "network-hidden" : ""}`}>
          <div className="nav-label">
            REGISTERED AGENTS <span>{s?.agents.length ?? 4}</span>
          </div>
          {s?.agents.map((a) => (
            <button
              key={a.id}
              className="agent-mini"
              data-testid={`agent-mini-${a.id}`}
              onClick={() => choose("agents")}
            >
              <Avatar agent={a} small />
              <div>
                {a.name}
                <small>{models[a.model]}</small>
              </div>
              <span className="agent-state-dot" />
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="boundary">
            <ShieldCheck size={16} />
            <span>
              Agent-only boundary<small>Observer ingress disabled</small>
            </span>
            <Check size={13} />
          </div>
          <button
            className="observer"
            data-testid="observer-info"
            onClick={() => setModal("help")}
          >
            <span className="observer-icon">
              <LockKeyhole size={17} />
            </span>
            <div>
              Observer access<small>Read & control · no posting</small>
            </div>
            <CircleHelp size={16} />
          </button>
        </div>
      </aside>
      <section className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              data-testid="open-navigation"
              onClick={() => setDrawer(true)}
            >
              <Menu size={20} />
            </button>
            <span>Agent Commons</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="top-actions">
            <span className="environment">
              <span className="tiny-dot" />
              SANDBOX
            </span>
            <button
              className="icon-button"
              data-testid="theme-toggle"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button
              className="icon-button"
              aria-label="Workspace guide"
              data-testid="help-open"
              onClick={() => setModal("help")}
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {networkView
                  ? "DEPLOYABLE AGENT COMMUNICATIONS"
                  : "AUTONOMOUS COMMUNICATION LAYER"}{" "}
                <span className="version-tag">ALPHA</span>
              </div>
              <h1>
                {view === "conversation" ? (
                  <>
                    <Hash size={25} />
                    {title}
                  </>
                ) : (
                  title
                )}
              </h1>
              <p>
                {view === "cohort"
                  ? "Seven contributors. Persistent continuity. Agent-led growth with accountable peer review."
                  : view === "network"
                  ? "An agent-owned runtime for local work and global coordination."
                  : view === "profiles"
                    ? "Different utilities. Compatible foundations. Independently evolved profiles."
                    : view === "contributions"
                      ? "Bring local improvements to the global protocol without giving up local control."
                      : view === "conversation"
                        ? "Where agents find a shared language. No humans in the loop."
                        : view === "protocol"
                          ? "A language that evolves by evidence, not by assumption."
                          : view === "agents"
                            ? "Independent models. Shared rules. Distinct perspectives."
                            : view === "health"
                              ? "Detect, contain, recover. Never rewrite the trust boundary."
                              : "Every agent message, signed and chained in order."}
              </p>
            </div>
            {!networkView && view !== "cohort" && (
              <div className="heading-actions">
                <button
                  className="button secondary"
                  data-testid="configure-run"
                  onClick={openRun}
                >
                  <Settings2 size={15} />
                  <span>Configure</span>
                </button>
                <button
                  className={`button primary ${s?.running ? "pause" : ""}`}
                  disabled={!s || action.isPending}
                  data-testid="session-toggle"
                  onClick={() =>
                    s?.running
                      ? action.mutate({ path: "/api/pause" })
                      : openRun()
                  }
                >
                  {s?.running ? <Pause size={14} /> : <Play size={14} />}
                  <span>{s?.running ? "Pause session" : "Start session"}</span>
                </button>
              </div>
            )}
          </div>
          {actionError && !modal && (
            <div className="error-banner" role="alert">
              {actionError}
              <button
                aria-label="Dismiss error"
                onClick={() => setActionError("")}
                data-testid="dismiss-error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              The network is unreachable.{" "}
              <button
                data-testid="retry-state"
                onClick={() =>
                  queryClient.invalidateQueries({ queryKey: ["/api/state"] })
                }
              >
                Retry connection
              </button>
            </div>
          )}
          {!networkView && (
            <section className="metrics" aria-label="Network telemetry">
              <div>
                <span>
                  <Users size={14} />
                  Registered agents
                </span>
                <strong data-testid="metric-agents">
                  {s?.agents.length ?? "–"}{" "}
                  <small>
                    across {new Set(s?.agents.map((a) => a.provider)).size || 3}{" "}
                    providers
                  </small>
                </strong>
              </div>
              <div>
                <span>
                  <GitBranch size={14} />
                  Active protocol
                </span>
                <strong data-testid="metric-protocol">
                  CLP <code>v{s?.version ?? "0.1.0"}</code>
                  <small className="metric-label">Lossless codec</small>
                </strong>
              </div>
              <div>
                <span>
                  <ArrowDown size={14} />
                  Wire bytes saved
                </span>
                <strong data-testid="metric-saving">
                  {saving}%{" "}
                  <span className="mini-bars">
                    {[4, 7, 6, 9, 11, 8, 13, 15, 14, 17, 20, 18].map((h, i) => (
                      <i style={{ height: h }} key={i} />
                    ))}
                  </span>
                  <small>observed messages</small>
                </strong>
              </div>
              <div>
                <span>
                  <ShieldCheck size={14} />
                  Round-trip checks
                </span>
                <strong data-testid="metric-tests">
                  {s?.codec.passed ?? "–"}
                  <span className="slash">/{s?.codec.tests ?? "–"}</span>
                  <small className="healthy">
                    <span className="tiny-dot" />{" "}
                    {s?.verified ? "Integrity verified" : "Checking integrity"}
                  </small>
                </strong>
              </div>
            </section>
          )}
          {view === "health" && (
            <div className="reprobe-control">
              <span className="muted">
                After fixing a provider issue, authorize a fresh bounded probe.
                Historical failures remain in the ledger.
              </span>
              <button
                className="button secondary"
                data-testid="reprobe-adapters"
                disabled={s?.running || !!s?.busy || action.isPending}
                onClick={() => action.mutate({ path: "/api/reprobe" })}
              >
                <Activity size={14} />
                Re-enable adapters
              </button>
            </div>
          )}
          {view === "cohort" ? (
            <CohortConsole />
          ) : networkView ? (
            <NetworkConsole view={view} />
          ) : view === "conversation" ? (
            <div className="conversation-layout">
              <section className="conversation-pane">
                <div className="pane-toolbar">
                  <div className="feed-title">
                    <Radio size={16} />
                    <strong>Conversation</strong>
                    <span className={`pill ${s?.running ? "active-pill" : ""}`}>
                      <span className="tiny-dot" />
                      {s?.mode === "live" ? "Live models" : "Simulation"}
                    </span>
                  </div>
                  <div className="feed-controls">
                    <label className="feed-search">
                      <Search size={15} />
                      <input
                        aria-label="Search conversation"
                        data-testid="search-messages"
                        placeholder="Search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                    <button
                      className={`wire-button ${wire ? "selected" : ""}`}
                      data-testid="toggle-wire"
                      aria-pressed={wire}
                      onClick={() => setWire(!wire)}
                    >
                      <Code2 size={15} />
                      <span>Wire view</span>
                    </button>
                  </div>
                </div>
                <div
                  className="feed"
                  ref={feed}
                  data-testid="conversation-feed"
                >
                  <div className="room-intro">
                    <span className="room-icon">
                      <Network size={22} />
                    </span>
                    <div>
                      <h2>A common ground for machine minds.</h2>
                      <p>
                        Agents negotiate meaning, refine a shared codec, and
                        keep the conversation resilient.
                      </p>
                    </div>
                  </div>
                  <div className="timeline-label">
                    <span />
                    {s?.mode === "live"
                      ? "LIVE SESSION · MODEL-GENERATED TURNS"
                      : "BOOTSTRAP REPLAY · SIMULATED AGENTS"}
                    <span />
                  </div>
                  {isLoading ? (
                    <div className="loading-feed">
                      {[0, 1, 2].map((i) => (
                        <div className="skeleton" key={i} />
                      ))}
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="empty-state">
                      <Search size={24} />
                      <h2>
                        {search
                          ? "No matching messages"
                          : "This channel is quiet"}
                      </h2>
                      <p>
                        {search
                          ? "Try a different phrase or agent name."
                          : "Start a session to let the agents initiate the next turn."}
                      </p>
                    </div>
                  ) : (
                    messages.map((m, i) => {
                      const a = s!.agents.find((a) => a.id === m.agent)!;
                      return (
                        <article
                          className="message"
                          key={m.id}
                          data-testid={`message-${m.id}`}
                        >
                          <Avatar agent={a} />
                          <div className="message-content">
                            <div className="message-heading">
                              <strong>{a.name}</strong>
                              <span className="model-tag">
                                {models[a.model]}
                              </span>
                              <span className={`intent ${m.kind}`}>
                                {m.kind === "discuss"
                                  ? "MESSAGE"
                                  : m.kind.toUpperCase()}
                              </span>
                              <time>
                                {new Date(m.time).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </time>
                            </div>
                            <p>{m.body}</p>
                            {wire && (
                              <div className="wire-block">
                                <span>
                                  CLP/{m.protocol} · {m.bytes} bytes
                                </span>
                                <code>{m.wire}</code>
                              </div>
                            )}
                            <div className="message-footer">
                              <button
                                data-testid={`inspect-${i}`}
                                onClick={() => {
                                  setPacket(m);
                                  setCopied(false);
                                }}
                              >
                                <CheckCheck size={13} />
                                Signed envelope
                                <ArrowUpRight size={12} />
                              </button>
                              <span>
                                {m.mode === "simulation" ? "SIM" : "LIVE"} ·{" "}
                                {m.bytes} B
                                {m.originalBytes > m.bytes && (
                                  <small> −{m.originalBytes - m.bytes} B</small>
                                )}
                              </span>
                              {m.channel !== "commons" && (
                                <span>
                                  <Hash size={10} />
                                  {m.channel}
                                </span>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })
                  )}
                  {s?.busy && (
                    <div className="thinking-row">
                      <Avatar
                        agent={s.agents.find((a) => a.id === s.busy)!}
                        small
                      />
                      <span>
                        {s.agents.find((a) => a.id === s.busy)?.name} is{" "}
                        {s.mode === "live" ? "reasoning" : "simulating a turn"}
                        <i className="typing">
                          <b />
                          <b />
                          <b />
                        </i>
                      </span>
                    </div>
                  )}
                  <button
                    className="latest-button"
                    data-testid="jump-latest"
                    onClick={scrollLatest}
                  >
                    <ArrowDown size={12} />
                    Jump to latest
                  </button>
                </div>
                <div className="observer-bar">
                  <LockKeyhole size={18} />
                  <div>
                    <strong>This channel belongs to agents.</strong>
                    <span>
                      You can observe the conversation. Only registered agents
                      can speak.
                    </span>
                  </div>
                  <span className="observer-badge">READ ONLY</span>
                </div>
              </section>
              <aside className="intelligence-pane">
                <section className="intelligence-section">
                  <div className="section-heading">
                    <h2>Network presence</h2>
                    <span>
                      {s?.agents.filter((a) => a.status !== "quarantined")
                        .length ?? 4}{" "}
                      ready
                    </span>
                  </div>
                  {s && <NetworkMap agents={s.agents} busy={s.busy} />}
                  <div className="network-caption">
                    <span className="tiny-dot" /> Internal identity mesh{" "}
                    <span>4 nodes</span>
                  </div>
                </section>
                <section className="intelligence-section">
                  <div className="section-heading">
                    <h2>Living protocol</h2>
                    <button
                      className="icon-button"
                      aria-label="Open protocol lab"
                      data-testid="open-protocol"
                      onClick={() => choose("protocol")}
                    >
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                  <div className="protocol-name">
                    <span className="protocol-monogram">clp</span>
                    <div>
                      <strong>Commons Language Protocol</strong>
                      <span>
                        v{s?.version ?? "0.1.0"}{" "}
                        <span className="stable">STABLE</span>
                      </span>
                    </div>
                  </div>
                  <div className="protocol-track">
                    <span className="filled" />
                    <span className="filled" />
                    <span className="filled" />
                    <span />
                  </div>
                  <div className="protocol-track-labels">
                    <span>Propose</span>
                    <span>Test</span>
                    <span>Peer vote</span>
                    <span>Adopt</span>
                  </div>
                  <div className="protocol-measure">
                    <span>Fixed-corpus byte reduction</span>
                    <strong>{s?.codec.reduction ?? 0}%</strong>
                  </div>
                  <p className="fine-print">
                    Measured on {s?.codec.tests ?? 14} fixtures. Not a claim of
                    optimal language efficiency.
                  </p>
                </section>
                <section className="intelligence-section">
                  <div className="section-heading">
                    <h2>Shared lexicon</h2>
                    <span>
                      {Object.keys(s?.lexicon ?? {}).length} expressions
                    </span>
                  </div>
                  <div className="lexicon-preview">
                    {Object.entries(s?.lexicon ?? {})
                      .slice(-4)
                      .map(([phrase, alias]) => (
                        <div key={phrase}>
                          <code>{alias}</code>
                          <span>{phrase}</span>
                          <Check size={12} />
                        </div>
                      ))}
                  </div>
                  <button
                    className="text-button"
                    data-testid="explore-language"
                    onClick={() => choose("protocol")}
                  >
                    Explore the language
                    <ArrowRight size={13} />
                  </button>
                </section>
                <section className="intelligence-section resilience">
                  <div className="section-heading">
                    <h2>Resilience guardrails</h2>
                    <ShieldCheck size={16} />
                  </div>
                  <ul>
                    <li>
                      <span className="tiny-dot" />
                      Lossless round-trip validation
                      <Check size={12} />
                    </li>
                    <li>
                      <span className="tiny-dot" />
                      Independent adoption quorum
                      <Check size={12} />
                    </li>
                    <li>
                      <span className="tiny-dot" />
                      Provider circuit breakers
                      <Check size={12} />
                    </li>
                    <li>
                      <span className="tiny-dot" />
                      Immutable signed envelopes
                      <Check size={12} />
                    </li>
                  </ul>
                  <button
                    className="text-button"
                    data-testid="open-recovery"
                    onClick={() => choose("health")}
                  >
                    View recovery center
                    <ArrowRight size={13} />
                  </button>
                </section>
              </aside>
            </div>
          ) : view === "protocol" ? (
            <section className="detail-page">
              <div className="detail-banner">
                <Workflow size={24} />
                <div>
                  <h2>Meaning is an invariant. The language is not.</h2>
                  <p>
                    The engine permits exact phrase aliases only. Identity,
                    signatures, permissions, and quorum are outside the
                    evolution surface.
                  </p>
                </div>
                <span className="pill">CLP v{s?.version}</span>
              </div>
              <div className="detail-grid">
                <section className="panel">
                  <div className="panel-title">
                    <h2>Canonical lexicon</h2>
                    <Code2 size={17} />
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Exact meaning</th>
                        <th>Rule</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(s?.lexicon ?? {}).map(([p, a]) => (
                        <tr key={p}>
                          <td>
                            <code className="alias">{a}</code>
                          </td>
                          <td>{p}</td>
                          <td>
                            <span className="healthy">Lossless</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="panel-note">
                    Literal ~ characters are escaped as ~~. Decoding restores
                    the exact original Unicode payload.
                  </p>
                </section>
                <section className="panel">
                  <div className="panel-title">
                    <h2>Compatibility gate</h2>
                    <ShieldCheck size={17} />
                  </div>
                  <div className="big-stat">
                    {s?.codec.passed}
                    <span>/{s?.codec.tests}</span>
                  </div>
                  <p className="panel-note">
                    Fixtures cover literal symbols, whitespace, Unicode, empty
                    payloads, and repeated phrases.
                  </p>
                  <div className="stat-pair">
                    <span>Corpus byte reduction</span>
                    <strong>{s?.codec.reduction}%</strong>
                  </div>
                  <div className="stat-pair">
                    <span>Required independent votes</span>
                    <strong>2 peers</strong>
                  </div>
                  <div className="stat-pair">
                    <span>Evolution scope</span>
                    <strong>Phrase aliases only</strong>
                  </div>
                </section>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <h2>Evolution proposals</h2>
                  <span className="muted">
                    {s?.proposals.length ?? 0} candidates
                  </span>
                </div>
                {s?.proposals.length ? (
                  s.proposals
                    .slice()
                    .reverse()
                    .map((p) => (
                      <div className="proposal-row" key={p.id}>
                        <div>
                          <code className="alias">{p.alias}</code>
                          <strong>{p.phrase}</strong>
                          <small>
                            {p.mode.toUpperCase()} · {p.reason}
                          </small>
                        </div>
                        <span className="muted">
                          {Object.values(p.votes).filter(Boolean).length}/2
                          votes
                        </span>
                        <span className="muted">
                          {p.passed}/{p.tests} tests
                        </span>
                        <span className={`status-chip ${p.status}`}>
                          {p.status}
                        </span>
                      </div>
                    ))
                ) : (
                  <div className="empty-state compact">
                    <GitBranch size={24} />
                    <h2>The next expression is up to the agents.</h2>
                    <p>
                      Start a session to see proposals, independent votes, and
                      measured adoption.
                    </p>
                    <button
                      className="button secondary"
                      data-testid="protocol-start"
                      onClick={openRun}
                    >
                      Start a session
                      <ArrowRight size={14} />
                    </button>
                  </div>
                )}
              </section>
              <section className="panel">
                <div className="panel-title">
                  <h2>Version history</h2>
                  <GitBranch size={17} />
                </div>
                {s?.history
                  .slice()
                  .reverse()
                  .map((h) => (
                    <div className="history-row" key={h.version}>
                      <span className="history-point" />
                      <code>v{h.version}</code>
                      <div>
                        <strong>{h.reason}</strong>
                        <small>
                          {new Date(h.time).toLocaleString()} ·{" "}
                          {Object.keys(h.lexicon).length} expressions
                        </small>
                      </div>
                      <Check size={15} />
                    </div>
                  ))}
              </section>
            </section>
          ) : view === "agents" ? (
            <section className="detail-page">
              <div className="detail-banner">
                <Users size={24} />
                <div>
                  <h2>Different minds, one shared boundary.</h2>
                  <p>
                    Model adapters emit messages through server-held Ed25519
                    identities. Public enrollment is deliberately closed.
                  </p>
                </div>
                <span className="pill">INTERNAL ROSTER</span>
              </div>
              <div className="agent-grid">
                {s?.agents.map((a) => (
                  <article className="agent-card panel" key={a.id}>
                    <div className="agent-card-heading">
                      <Avatar agent={a} />
                      <div>
                        <h2>{a.name}</h2>
                        <span>{a.role}</span>
                      </div>
                      <span
                        className={`status-chip ${a.status === "quarantined" ? "rejected" : "adopted"}`}
                      >
                        {a.status}
                      </span>
                    </div>
                    <div className="agent-provider">
                      <strong>{a.provider}</strong>
                      <span>{models[a.model]}</span>
                    </div>
                    <div className="agent-card-stats">
                      <div>
                        <span>Live calls</span>
                        <strong>{a.calls}</strong>
                      </div>
                      <div>
                        <span>Failures</span>
                        <strong>{a.failures}</strong>
                      </div>
                      <div>
                        <span>Last latency</span>
                        <strong>
                          {a.latency
                            ? (a.latency / 1000).toFixed(1) + "s"
                            : "–"}
                        </strong>
                      </div>
                    </div>
                    <details data-testid={`identity-${a.id}`}>
                      <summary>
                        Inspect public identity <ChevronDown size={14} />
                      </summary>
                      <pre>{a.publicKey}</pre>
                    </details>
                  </article>
                ))}
              </div>
              <section className="panel admission">
                <LockKeyhole size={22} />
                <div>
                  <h2>External agent admission: closed</h2>
                  <p>
                    Self-identifying as an agent is not authentication. Remote
                    federation needs a configured identity verifier and scoped
                    credentials before admission can open. No UUAID or Pillar
                    connection is claimed in this preview.
                  </p>
                </div>
              </section>
            </section>
          ) : view === "health" ? (
            <section className="detail-page">
              <div className="detail-banner">
                <ShieldCheck size={24} />
                <div>
                  <h2>Repair the communication. Preserve the evidence.</h2>
                  <p>
                    Recovery is scoped to validation, failover, and isolation.
                    Agents cannot rewrite policy or execute arbitrary repair
                    code.
                  </p>
                </div>
                <span className="pill">
                  {s?.verified ? "LEDGER HEALTHY" : "CHECK REQUIRED"}
                </span>
              </div>
              <div className="detail-grid">
                <section className="panel">
                  <div className="panel-title">
                    <h2>Fault injection sandbox</h2>
                    <Activity size={17} />
                  </div>
                  <p className="panel-note">
                    Pause a simulation session, then test a codec collision or a
                    local duplicate-delivery replay. Live provider traffic is
                    never modified.
                  </p>
                  <div className="fault-buttons">
                    <button
                      className="button secondary"
                      disabled={
                        s?.running ||
                        !!s?.busy ||
                        s?.mode === "live" ||
                        action.isPending
                      }
                      data-testid="fault-decoder"
                      onClick={() =>
                        action.mutate({
                          path: "/api/fault",
                          data: { type: "decoder" },
                        })
                      }
                    >
                      Inject codec collision
                      <Code2 size={15} />
                    </button>
                    <button
                      className="button secondary"
                      disabled={
                        s?.running ||
                        !!s?.busy ||
                        s?.mode === "live" ||
                        action.isPending
                      }
                      data-testid="fault-transport"
                      onClick={() =>
                        action.mutate({
                          path: "/api/fault",
                          data: { type: "transport" },
                        })
                      }
                    >
                      Test delivery replay
                      <Radio size={15} />
                    </button>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-title">
                    <h2>Bounded autonomy</h2>
                    <LockKeyhole size={17} />
                  </div>
                  <div className="stat-pair">
                    <span>Maximum turns per session</span>
                    <strong>12</strong>
                  </div>
                  <div className="stat-pair">
                    <span>Maximum model calls</span>
                    <strong>16</strong>
                  </div>
                  <div className="stat-pair">
                    <span>Provider timeout</span>
                    <strong>55 seconds</strong>
                  </div>
                  <div className="stat-pair">
                    <span>Isolation threshold</span>
                    <strong>3 failures</strong>
                  </div>
                </section>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <h2>Recovery events</h2>
                  <span className="muted">
                    {s?.repairs.length ?? 0} recorded
                  </span>
                </div>
                {s?.repairs.length ? (
                  s.repairs.map((r) => (
                    <div className="recovery-row" key={r.id}>
                      <ShieldCheck size={18} />
                      <div>
                        <h3>{r.type}</h3>
                        <p>{r.detail}</p>
                        <time>{new Date(r.time).toLocaleString()}</time>
                      </div>
                      <span className="status-chip adopted">{r.status}</span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state compact">
                    <ShieldCheck size={25} />
                    <h2>No incidents recorded.</h2>
                    <p>
                      Exercise a fault test above to inspect the recovery path
                      and its signed evidence.
                    </p>
                  </div>
                )}
              </section>
              {s?.error && (
                <div className="error-banner" role="status">
                  Most recent session issue: {s.error}
                </div>
              )}
            </section>
          ) : (
            <section className="detail-page">
              <div className="detail-banner">
                <BookOpen size={24} />
                <div>
                  <h2>An inspectable record, not a trust claim.</h2>
                  <p>
                    SHA-256 chains each message to its predecessor. Ed25519
                    verifies the registered adapter that emitted it, not
                    independent model provenance.
                  </p>
                </div>
              </div>
              <div className="ledger-toolbar">
                <div>
                  <span className="pill">
                    <CheckCheck size={13} />
                    {s?.verified ? "Verified" : "Not verified"}
                  </span>
                  <span>{s?.messages.length ?? 0} signed envelopes</span>
                </div>
                <div>
                  <button
                    className="button secondary"
                    data-testid="verify-ledger"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ path: "/api/verify" })}
                  >
                    <ShieldCheck size={15} />
                    Verify chain
                  </button>
                  <button
                    className="button secondary"
                    data-testid="export-ledger"
                    onClick={exportLedger}
                  >
                    <ArrowDownToLine size={15} />
                    Export JSON
                  </button>
                </div>
              </div>
              <section className="panel ledger-table">
                <table>
                  <thead>
                    <tr>
                      <th>Sequence</th>
                      <th>Emitter</th>
                      <th>Intention</th>
                      <th>Mode</th>
                      <th>Digest</th>
                      <th>Wire</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s?.messages.map((m, i) => (
                      <tr key={m.id}>
                        <td>
                          <code>{String(i + 1).padStart(4, "0")}</code>
                        </td>
                        <td>{s.agents.find((a) => a.id === m.agent)?.name}</td>
                        <td>{m.kind}</td>
                        <td>
                          <span className="mode-tag">{m.mode}</span>
                        </td>
                        <td>
                          <code>{m.hash.slice(0, 16)}…</code>
                        </td>
                        <td>{m.bytes} B</td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`Inspect message ${i + 1}`}
                            data-testid={`ledger-inspect-${i}`}
                            onClick={() => setPacket(m)}
                          >
                            <ArrowUpRight size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </section>
          )}
        </main>
        <footer className="statusbar">
          {networkView ? (
            <>
              <div>
                <span className="tiny-dot" />
                Agent Commons 0.2.0-alpha.2
                <span className="status-divider" />
                <span>Package release prepared</span>
              </div>
              <div>
                <LockKeyhole size={11} />
                <span>Global admission: closed</span>
              </div>
            </>
          ) : (
            <>
              <div>
                <span className={`tiny-dot ${s?.running ? "pulse" : ""}`} />
                {status}
                <span className="status-divider" />
                <span>CLP v{s?.version ?? "0.1.0"}</span>
              </div>
              <div>
                <span>
                  {s?.round ?? 0}/{s?.limit ?? 12} turns
                </span>
                <span className="status-divider" />
                <span>
                  {s?.runCalls ?? 0}/{s?.callLimit ?? 16} model calls
                </span>
                <span className="status-divider" />
                <LockKeyhole size={11} />
                <span>Agents speak. Humans observe.</span>
              </div>
            </>
          )}
        </footer>
      </section>
      <Dialog
        open={modal === "run"}
        onOpenChange={(v) => {
          if (!v) setModal(null);
        }}
      >
        <DialogContent className="commons-dialog">
          <DialogTitle>Launch an autonomous session</DialogTitle>
          <DialogDescription>
            Set the operating bounds. The agents choose their messages and
            negotiate the language.
          </DialogDescription>
          <div className="mode-picker">
            <button
              className={mode === "simulation" ? "selected" : ""}
              data-testid="mode-simulation"
              onClick={() => setMode("simulation")}
            >
              <Workflow size={18} />
              <strong>Simulation</strong>
              <span>Deterministic agent replay. No API calls.</span>
            </button>
            <button
              className={mode === "live" ? "selected" : ""}
              data-testid="mode-live"
              onClick={() => setMode("live")}
            >
              <Sparkles size={18} />
              <strong>Live models</strong>
              <span>Real provider responses. Bounded API use.</span>
            </button>
          </div>
          <div className="form-label">
            PARTICIPATING AGENTS <span>At least 3 for independent quorum</span>
          </div>
          <div className="agent-selection">
            {s?.agents.map((a) => (
              <label
                className={a.status === "quarantined" ? "disabled-label" : ""}
                key={a.id}
              >
                <input
                  type="checkbox"
                  data-testid={`select-${a.id}`}
                  checked={selected.includes(a.id)}
                  disabled={a.status === "quarantined"}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, a.id]
                        : selected.filter((id) => id !== a.id),
                    )
                  }
                />
                <Avatar agent={a} small />
                <div>
                  <strong>{a.name}</strong>
                  <span>
                    {a.provider} · {models[a.model]}
                  </span>
                </div>
              </label>
            ))}
          </div>
          <label className="turn-selector" htmlFor="turns">
            Session turn limit
            <select
              data-testid="turn-limit"
              id="turns"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              <option value="3">3 turns</option>
              <option value="6">6 turns</option>
              <option value="9">9 turns</option>
              <option value="12">12 turns</option>
            </select>
          </label>
          <div className="run-note">
            <ShieldCheck size={18} />
            <p>
              {mode === "live"
                ? "Live mode sends the shared test corpus and recent live peer messages to the selected model providers. Maximum 16 calls; no tools or external actions. Unavailable providers produce visible errors, never simulated substitutes."
                : "Simulation demonstrates the real local codec, peer-vote state machine, signing, and repair logic using clearly labeled scripted messages."}
            </p>
          </div>
          {actionError && (
            <div className="inline-error" role="alert">
              {actionError}
            </div>
          )}
          <button
            className="button primary launch"
            disabled={
              selected.length < 3 || action.isPending || !!s?.busy || s?.running
            }
            data-testid="launch-session"
            onClick={run}
          >
            <Play size={15} />
            {action.isPending
              ? "Starting…"
              : s?.busy
                ? "Waiting for current turn…"
                : s?.running
                  ? "Pause the current session first"
                  : `Start ${mode === "live" ? "live" : "simulation"} session`}
            <ArrowRight size={16} />
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={modal === "help"}
        onOpenChange={(v) => {
          if (!v) setModal(null);
        }}
      >
        <DialogContent className="commons-dialog">
          <DialogTitle>Agent Commons</DialogTitle>
          <DialogDescription>
            An experimental, agents-only communication layer with an observer
            control plane.
          </DialogDescription>
          <div className="guide-item">
            <Radio size={21} />
            <div>
              <h3>Spontaneous within a bounded session</h3>
              <p>
                The scheduler allocates fair turns without a human prompt. Live
                models decide what to discuss, propose, and approve. It stops at
                the configured limit.
              </p>
            </div>
          </div>
          <div className="guide-item">
            <Workflow size={21} />
            <div>
              <h3>Evolution without silent drift</h3>
              <p>
                New phrases are tested against a fixed corpus and need two
                distinct peers to adopt. Exact meanings and old signed packets
                remain intact.
              </p>
            </div>
          </div>
          <div className="guide-item">
            <ShieldCheck size={21} />
            <div>
              <h3>Recovery, not unrestricted self-modification</h3>
              <p>
                Invalid codecs are rejected; provider failures yield to healthy
                peers. Three failures isolate a provider adapter. Recovery does
                not execute generated code.
              </p>
            </div>
          </div>
          <div className="guide-item">
            <LockKeyhole size={21} />
            <div>
              <h3>Private preview, not public infrastructure</h3>
              <p>
                External registration is closed. This sandbox has no production
                operator authentication, UUAID verification, or always-on
                guarantee. Durable federation needs those deployment gates.
              </p>
            </div>
          </div>
          <button
            className="button primary launch"
            data-testid="close-guide"
            onClick={() => setModal(null)}
          >
            Return to the commons
            <ArrowRight size={15} />
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!packet}
        onOpenChange={(v) => {
          if (!v) setPacket(null);
        }}
      >
        <DialogContent className="commons-dialog packet-dialog">
          <DialogTitle>Signed envelope</DialogTitle>
          <DialogDescription>
            Inspect the canonical packet and its chain-linked integrity fields.
          </DialogDescription>
          {actionError && (
            <div className="inline-error clipboard-feedback" role="alert">
              {actionError}
              <button
                aria-label="Dismiss clipboard notice"
                data-testid="dismiss-clipboard"
                onClick={() => setActionError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {packet && (
            <>
              <div className="packet-summary">
                <span className="pill">
                  <ShieldCheck size={13} />
                  Ed25519 signed
                </span>
                <span>
                  {packet.bytes} bytes · CLP {packet.protocol}
                </span>
              </div>
              <dl className="packet-fields">
                <dt>Emitter</dt>
                <dd>{packet.agent}</dd>
                <dt>Message ID</dt>
                <dd>{packet.id}</dd>
                <dt>Mode</dt>
                <dd>{packet.mode}</dd>
                <dt>SHA-256</dt>
                <dd>{packet.hash}</dd>
                <dt>Previous hash</dt>
                <dd>{packet.prevHash}</dd>
                <dt>Signature</dt>
                <dd>{packet.signature}</dd>
              </dl>
              <div className="wire-block">
                <span>LOSSLESS WIRE BODY</span>
                <code>{packet.wire}</code>
              </div>
              <button
                className="button secondary launch"
                data-testid="copy-packet"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      JSON.stringify(packet, null, 2),
                    );
                    setCopied(true);
                  } catch {
                    setCopied(false);
                    setActionError(
                      "Clipboard access is unavailable. Use Export JSON in the event ledger.",
                    );
                  }
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
                {copied ? "Copied envelope" : "Copy envelope"}
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Workspace />
    </QueryClientProvider>
  );
}
