"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import "@/styles/coven-pulse.css";
import { Icon } from "@/lib/icon";
import { sessionStatusTone } from "@/lib/session-status";
import { formatCost, formatTokens } from "@/lib/usage-format";

const REFRESH_INTERVAL_MS = 10_000;

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
  } | null;
};

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

async function emitPulseIntent(event: "pulse:dismiss" | "pulse:open-cave"): Promise<void> {
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

  const refresh = useCallback(async (signal?: AbortSignal) => {
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
        } : null,
      });
      setError(!daemonResponse.ok && !sessionsResponse.ok && !usageResponse.ok);
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) {
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

  const runningSessions = useMemo(
    () => snapshot?.sessions.filter(
      (session) => !session.archived_at && sessionStatusTone(session.status) === "running",
    ).length ?? 0,
    [snapshot],
  );
  const executors = snapshot?.daemon?.executors ?? [];
  const availableExecutors = executors.filter((executor) => executor.ok === true).length;
  const daemonOnline = snapshot?.daemon?.running === true;
  const tokenLabel = snapshot?.usage?.tokenObservedTurns
    ? formatTokens(snapshot.usage.totalTokens) ?? "Unreported"
    : "Unreported";
  const recordedCostLabel = snapshot?.usage?.costObservedTurns
    ? formatCost(snapshot.usage.costUsd) ?? "$0.00"
    : "Unreported";

  return (
    <main className="coven-pulse" aria-labelledby="coven-pulse-title">
      <header className="coven-pulse__header">
        <div>
          <p className="coven-pulse__eyebrow">Local control room</p>
          <h1 id="coven-pulse-title">Coven Pulse</h1>
        </div>
        <button
          type="button"
          className="coven-pulse__refresh focus-ring"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Refresh Coven Pulse"
        >
          <Icon name="ph:arrow-clockwise-bold" aria-hidden />
        </button>
      </header>

      {error ? (
        <p className="coven-pulse__notice" role="alert">
          Live status is unavailable. Pulse will retry automatically.
        </p>
      ) : null}

      <section className="coven-pulse__connection" aria-label="Coven connection">
        <span
          className={`coven-pulse__signal coven-pulse__signal--${daemonOnline ? "online" : "offline"}`}
          aria-hidden="true"
        />
        <div className="coven-pulse__connection-copy">
          <strong>{loading ? "Checking…" : connectionLabel(snapshot?.daemon ?? null)}</strong>
          <span>{checkedLabel(snapshot?.daemon?.checkedAt)}</span>
        </div>
        <Icon name="ph:heartbeat" aria-hidden />
      </section>

      <section className="coven-pulse__metrics" aria-label="Live Coven activity">
        <article className="coven-pulse__metric">
          <span className="coven-pulse__metric-label">Active sessions</span>
          <strong>{loading ? "—" : runningSessions}</strong>
          <span>{snapshot?.sessionsDegraded ? "Local view" : "Live view"}</span>
        </article>
        <article className="coven-pulse__metric">
          <span className="coven-pulse__metric-label">Executors</span>
          <strong>{loading ? "—" : `${availableExecutors}/${executors.length}`}</strong>
          <span>Configured endpoints</span>
        </article>
        <article className="coven-pulse__metric">
          <span className="coven-pulse__metric-label">Tokens this month</span>
          <strong>{loading ? "—" : tokenLabel}</strong>
          <span>Recorded locally · partial</span>
        </article>
        <article className="coven-pulse__metric">
          <span className="coven-pulse__metric-label">Reported cost</span>
          <strong>{loading ? "—" : recordedCostLabel}</strong>
          <span>Harness-reported · partial</span>
        </article>
      </section>

      <section className="coven-pulse__unavailable" aria-label="Metrics not reported by Coven">
        <div className="coven-pulse__unavailable-row">
          <span>Throughput</span>
          <strong>Unavailable</strong>
        </div>
        <div className="coven-pulse__unavailable-row">
          <span>API equivalent</span>
          <strong>Unreported</strong>
        </div>
        <p>Live throughput and price-catalog estimates need additional harness telemetry.</p>
      </section>

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
