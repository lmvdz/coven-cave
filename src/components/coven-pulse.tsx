"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "@/styles/coven-pulse.css";
import { Icon } from "@/lib/icon";
import { sessionStatusTone } from "@/lib/session-status";
import { formatCost, formatTokens } from "@/lib/usage-format";

const REFRESH_INTERVAL_MS = 10_000;
const MINIMUM_REFRESH_FEEDBACK_MS = 500;

type DaemonPulseStatus = {
  running?: boolean;
  availability?: string;
  checkedAt?: string;
  target?: { mode?: "local" | "hub" | "unconfigured-hub" };
  executors?: Array<{ ok?: boolean }>;
};

type PulseSession = {
  id?: string;
  status?: string;
  archived_at?: string | null;
};

type PulseSnapshot = {
  daemon: DaemonPulseStatus | null;
  sessions: PulseSession[];
  sessionsDegraded: boolean;
  usage: {
    totalTokens: number;
    costUsd: number;
    tokenObservedTurns: number;
    costObservedTurns: number;
    byHarness: Array<{
      harness: string;
      totalTokens: number;
      costUsd: number;
      tokenObservedTurns: number;
      costObservedTurns: number;
      quotaAvailable: boolean;
    }>;
  } | null;
};

type PulseTab = "overview" | "usage" | "system";
type ExecutorIntent = "pulse:executor-start" | "pulse:executor-stop" | "pulse:executor-restart";
type LocalExecutorPulse = { state: string; owner: string; running: boolean; controllable: boolean };

function connectionLabel(status: DaemonPulseStatus | null): string {
  if (!status) return "Unavailable";
  if (status.running !== true) return "Offline";
  return status.target?.mode === "hub" ? "Hub online" : "Local online";
}

function checkedLabel(value: string | undefined): string {
  if (!value) return "Not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not checked";
  return `Checked ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

async function emitPulseIntent(event: "pulse:dismiss" | "pulse:open-cave" | ExecutorIntent): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event);
  } catch {
    if (event === "pulse:dismiss") window.close();
  }
}

export function CovenPulse() {
  const [snapshot, setSnapshot] = useState<PulseSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<PulseTab>("overview");
  const [localExecutor, setLocalExecutor] = useState<LocalExecutorPulse | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const startedAt = performance.now();
    setRefreshing(true);
    try {
      const [daemonResponse, sessionsResponse, usageResponse] = await Promise.all([
        fetch("/api/daemon/status", { cache: "no-store", signal }),
        fetch("/api/sessions/list", { cache: "no-store", signal }),
        fetch("/api/chat/usage?scope=all", { cache: "no-store", signal }),
      ]);
      const daemon = daemonResponse.ok
        ? await daemonResponse.json().catch(() => null) as DaemonPulseStatus | null
        : null;
      const sessionsPayload = sessionsResponse.ok
        ? await sessionsResponse.json().catch(() => null) as {
            sessions?: PulseSession[];
            degraded?: boolean;
          } | null
        : null;
      const usagePayload = usageResponse.ok
        ? await usageResponse.json().catch(() => null) as {
            snapshot?: { totals?: { totalTokens?: number; costUsd?: number } };
            coverage?: { tokenObservedTurns?: number; costObservedTurns?: number };
            usageByHarness?: Array<{
              harness?: string;
              totals?: { totalTokens?: number; costUsd?: number };
              tokenObservedTurns?: number;
              costObservedTurns?: number;
              quota?: { availability?: string };
            }>;
          } | null
        : null;
      if (signal?.aborted) return;
      setSnapshot({
        daemon,
        sessions: Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : [],
        sessionsDegraded: sessionsPayload?.degraded === true,
        usage: usagePayload?.snapshot?.totals && usagePayload.coverage ? {
          totalTokens: usagePayload.snapshot.totals.totalTokens ?? 0,
          costUsd: usagePayload.snapshot.totals.costUsd ?? 0,
          tokenObservedTurns: usagePayload.coverage.tokenObservedTurns ?? 0,
          costObservedTurns: usagePayload.coverage.costObservedTurns ?? 0,
          byHarness: Array.isArray(usagePayload.usageByHarness)
            ? usagePayload.usageByHarness.flatMap((row) => row.harness ? [{
                harness: row.harness,
                totalTokens: row.totals?.totalTokens ?? 0,
                costUsd: row.totals?.costUsd ?? 0,
                tokenObservedTurns: row.tokenObservedTurns ?? 0,
                costObservedTurns: row.costObservedTurns ?? 0,
                quotaAvailable: row.quota?.availability === "authoritative",
              }] : [])
            : [],
        } : null,
      });
      setError(!daemonResponse.ok && !sessionsResponse.ok && !usageResponse.ok);
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) {
        const remaining = MINIMUM_REFRESH_FEEDBACK_MS - (performance.now() - startedAt);
        if (remaining > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, remaining));
        }
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    }, REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") void emitPulseIntent("pulse:dismiss");
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<LocalExecutorPulse>("pulse:executor-status", (event) => {
        setLocalExecutor(event.payload);
        setAction(null);
      }))
      .then((dispose) => { unlisten = dispose; })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const controlExecutor = useCallback((intent: ExecutorIntent) => {
    setAction(intent);
    void emitPulseIntent(intent);
  }, []);

  const controlDaemon = useCallback(async (restart: boolean) => {
    setAction(restart ? "daemon-restart" : "daemon-start");
    try {
      await fetch("/api/daemon/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restart }),
      });
      await refresh();
    } finally {
      setAction(null);
    }
  }, [refresh]);

  const runningSessions = useMemo(
    () => snapshot?.sessions.filter(
      (session) => !session.archived_at && sessionStatusTone(session.status) === "running",
    ).length ?? 0,
    [snapshot],
  );
  const executors = snapshot?.daemon?.executors ?? [];
  const availableExecutors = executors.filter((executor) => executor.ok === true).length;
  const daemonOnline = snapshot?.daemon?.running === true;
  const hasUsageReports = Boolean(
    snapshot?.usage && (snapshot.usage.tokenObservedTurns || snapshot.usage.costObservedTurns),
  );
  const tokenLabel = snapshot?.usage?.tokenObservedTurns
    ? formatTokens(snapshot.usage.totalTokens) ?? "Unreported"
    : "Unreported";
  const recordedCostLabel = snapshot?.usage?.costObservedTurns
    ? formatCost(snapshot.usage.costUsd) ?? "$0.00"
    : "Unreported";
  const harnessUsage = snapshot?.usage?.byHarness ?? [];
  const largestHarnessTotal = Math.max(1, ...harnessUsage.map((row) => row.totalTokens));

  return (
    <main className="coven-pulse" aria-labelledby="coven-pulse-title">
      <header className="coven-pulse__header">
        <h1 id="coven-pulse-title">Pulse</h1>
        <button
          type="button"
          className="coven-pulse__refresh focus-ring"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-busy={refreshing}
          aria-label="Refresh Coven Pulse"
        >
          <Icon name="ph:arrow-clockwise-bold" aria-hidden />
        </button>
      </header>

      <nav className="coven-pulse__tabs" aria-label="Pulse views">
        {(["overview", "usage", "system"] as const).map((view) => (
          <button
            key={view}
            type="button"
            className="focus-ring"
            aria-current={tab === view ? "page" : undefined}
            onClick={() => setTab(view)}
          >
            {view}
          </button>
        ))}
      </nav>

      {error ? (
        <p className="coven-pulse__notice" role="alert">
          Live status is unavailable. Pulse will retry automatically.
        </p>
      ) : null}

      {tab === "overview" ? (
        <section className="coven-pulse__overview" aria-label="Coven overview">
          <div className={`coven-pulse__orb coven-pulse__orb--${daemonOnline ? "online" : "offline"}`}>
            <Icon name="ph:heartbeat" aria-hidden />
            <strong>{loading ? "…" : connectionLabel(snapshot?.daemon ?? null)}</strong>
          </div>
          <div className="coven-pulse__stat-strip">
            <article><Icon name="ph:chats-circle" aria-hidden /><strong>{loading ? "—" : runningSessions}</strong><span>Active</span></article>
            <article><Icon name="ph:hard-drives" aria-hidden /><strong>{loading ? "—" : `${availableExecutors}/${executors.length}`}</strong><span>Executors</span></article>
            <article><Icon name="ph:lightning-bold" aria-hidden /><strong>—</strong><span>tok/s</span></article>
          </div>
          <div className="coven-pulse__usage-glance">
            <span>Month</span>
            <strong>{loading ? "—" : hasUsageReports ? tokenLabel : "No reports"}</strong>
            <span>{hasUsageReports ? recordedCostLabel : ""}</span>
          </div>
        </section>
      ) : null}

      {tab === "usage" ? (
        <section className="coven-pulse__usage" aria-label="Usage by harness">
          {harnessUsage.length ? harnessUsage.map((row) => (
            <article key={row.harness} className="coven-pulse__harness">
              <div><strong>{row.harness}</strong><span>{formatTokens(row.totalTokens) ?? "—"}</span></div>
              <progress className="coven-pulse__bar" max={largestHarnessTotal} value={row.totalTokens} aria-label={`${row.harness} relative recorded usage`} />
              <div><span>{row.costObservedTurns ? formatCost(row.costUsd) ?? "$0.00" : "Cost —"}</span><span>{row.quotaAvailable ? "Quota live" : "OAuth quota —"}</span></div>
            </article>
          )) : (
            <div className="coven-pulse__visual-empty"><Icon name="ph:chart-bar" aria-hidden /><strong>No harness reports</strong><span>Usage appears after a measured run.</span></div>
          )}
        </section>
      ) : null}

      {tab === "system" ? (
        <section className="coven-pulse__system" aria-label="System health">
          <div className="coven-pulse__system-row"><span className={`coven-pulse__signal coven-pulse__signal--${daemonOnline ? "online" : "offline"}`} /><strong>{snapshot?.daemon?.target?.mode === "hub" ? "Hub" : "Daemon"}</strong><span>{connectionLabel(snapshot?.daemon ?? null)}</span></div>
          {snapshot?.daemon?.target?.mode !== "hub" ? (
            <div className="coven-pulse__controls">
              <button className="focus-ring" type="button" disabled={action !== null || daemonOnline} onClick={() => void controlDaemon(false)}>Start</button>
              <button className="focus-ring" type="button" disabled={action !== null || !daemonOnline} onClick={() => void controlDaemon(true)}>Restart</button>
            </div>
          ) : null}
          <div className="coven-pulse__system-row"><span className={`coven-pulse__signal coven-pulse__signal--${localExecutor?.running ? "online" : "offline"}`} /><strong>Executor</strong><span>{localExecutor ? `${localExecutor.owner} · ${localExecutor.state}` : "Checking"}</span></div>
          <div className="coven-pulse__controls">
            <button className="focus-ring" type="button" disabled={action !== null || !localExecutor?.controllable || localExecutor.running} onClick={() => controlExecutor("pulse:executor-start")}>Start</button>
            <button className="focus-ring" type="button" disabled={action !== null || !localExecutor?.controllable || !localExecutor.running} onClick={() => controlExecutor("pulse:executor-stop")}>Stop</button>
            <button className="focus-ring" type="button" disabled={action !== null || !localExecutor?.controllable || !localExecutor.running} onClick={() => controlExecutor("pulse:executor-restart")}>Restart</button>
          </div>
          <div className="coven-pulse__system-row"><span className={`coven-pulse__signal coven-pulse__signal--${executors.length && availableExecutors === executors.length ? "online" : "offline"}`} /><strong>Fleet endpoints</strong><span>{executors.length ? `${availableExecutors}/${executors.length}` : "Not configured"}</span></div>
          <div><span className={`coven-pulse__signal coven-pulse__signal--${snapshot?.sessionsDegraded ? "offline" : "online"}`} /><strong>Sessions</strong><span>{snapshot?.sessionsDegraded ? "Local view" : "Live view"}</span></div>
          <p>{checkedLabel(snapshot?.daemon?.checkedAt)}</p>
        </section>
      ) : null}

      <footer className="coven-pulse__footer">
        <button type="button" className="focus-ring" onClick={() => void emitPulseIntent("pulse:open-cave")}>
          Open Cave
        </button>
        <button type="button" className="focus-ring" onClick={() => void emitPulseIntent("pulse:dismiss")}>
          Close
        </button>
      </footer>

      <p className="sr-only" role="status" aria-live="polite">
        {refreshing ? "Refreshing Coven Pulse." : "Coven Pulse is up to date."}
      </p>
    </main>
  );
}
