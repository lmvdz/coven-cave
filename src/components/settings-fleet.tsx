"use client";

import "@/styles/settings-fleet.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAnnouncer } from "@/components/ui/live-region";
import { RelativeTime } from "@/components/ui/relative-time";
import { Icon, type IconName } from "@/lib/icon";
import { settingsGroupId } from "@/lib/settings-group-id";

type FleetRole = "hub" | "executor" | "both";
type FleetLifecycle = "stopped" | "running" | "draining";
type LocalNode = {
  deviceId: string;
  role: FleetRole;
  lifecycle: FleetLifecycle;
  executorShared: boolean;
  capabilities: string[];
  acceptingJobs: boolean;
  generation: number;
  updatedAt: string;
  nextAction: string;
};
type Candidate = {
  id: string;
  name: string;
  os: string | null;
  online: boolean;
  reachable: boolean;
  roles: FleetRole[];
  protocolVersions: string[];
  pairingAvailable: boolean;
  authenticated: boolean;
  error?: string;
};
type TrustedNode = { nodeId: string; enrolledAt: string; lastSeenAt: string; revokedAt: string | null };
type PairingRequest = {
  requestId: string;
  nodeId: string;
  state: "pending";
  expiresAt: string;
  createdAt: string;
};
type FleetJob = {
  jobId: string;
  targetNodeId: string;
  state: "queued" | "leased" | "completed" | "failed";
  result: { stdout?: string; stderr?: string; error?: string | null } | null;
  createdAt: string;
  completedAt: string | null;
};
type Snapshot = {
  ok: true;
  local: LocalNode;
  trusted: TrustedNode[];
  incoming: PairingRequest[];
  jobs: FleetJob[];
  tailscale: { available: boolean; error: string | null };
  candidates: Candidate[];
};
type Enrollment = { credential: string; expiresAt: string; singleUse: true };
type Outbound = { operationId: string; requestId: string; expiresAt: string; candidateName: string };

const ROLES: Array<{ id: FleetRole; label: string; description: string; icon: IconName }> = [
  { id: "hub", label: "Hub", description: "Approve devices and coordinate trusted work.", icon: "ph:share-network-bold" },
  { id: "executor", label: "Executor", description: "Run shared work when you explicitly enable sharing.", icon: "ph:terminal-window-bold" },
  { id: "both", label: "Both", description: "Coordinate the fleet and make this device available for work.", icon: "ph:circles-three-plus" },
];

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function candidateStateLabel(candidate: Candidate): string {
  if (candidate.authenticated) {
    return candidate.roles.includes("hub") || candidate.roles.includes("both")
      ? "Connected to hub"
      : "Authenticated";
  }
  if (!candidate.reachable) return candidate.online ? "No service" : "Offline";
  if (candidate.roles.includes("executor") || candidate.roles.includes("both")) return "Executor reachable";
  if (candidate.roles.includes("hub")) return "Hub reachable";
  return "Coven reachable";
}

async function postFleet(body: object): Promise<unknown> {
  const response = await fetch("/api/fleet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error || "The fleet operation failed. Retry.");
  return payload.result;
}

function StateDot({ tone, label }: { tone: "success" | "warning" | "neutral"; label: string }) {
  return <span className="settings-fleet-state"><span data-tone={tone} aria-hidden="true" />{label}</span>;
}

export function FleetSection() {
  const { announce } = useAnnouncer();
  const confirm = useConfirm();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<string>("");
  const [credential, setCredential] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [outbound, setOutbound] = useState<Outbound | null>(null);

  const refresh = useCallback(async (announceResult = false) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/fleet", { cache: "no-store" });
      const payload = await response.json() as Snapshot | { ok: false; error?: string };
      if (!response.ok || !payload.ok) throw new Error("error" in payload ? payload.error : undefined);
      setSnapshot(payload);
      setSelectedCandidate((current) => current || payload.candidates.find((item) => item.reachable)?.id || "");
      if (announceResult) announce("Fleet status refreshed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fleet status is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [announce]);

  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = useCallback(async (key: string, body: object, success: string) => {
    setBusy(key);
    setError(null);
    try {
      const result = await postFleet(body);
      announce(success);
      await refresh();
      return result;
    } catch (cause) {
      const nextError = cause instanceof Error ? cause.message : "The fleet operation failed. Retry.";
      setError(nextError);
      announce(nextError, "assertive");
      return null;
    } finally {
      setBusy(null);
    }
  }, [announce, refresh]);

  const activeTrusted = useMemo(
    () => snapshot?.trusted.filter((node) => node.revokedAt === null) ?? [],
    [snapshot],
  );
  const selected = snapshot?.candidates.find((candidate) => candidate.id === selectedCandidate) ?? null;
  const hasExecutorRole = snapshot?.local.role === "executor" || snapshot?.local.role === "both";
  const hasHubRole = snapshot?.local.role === "hub" || snapshot?.local.role === "both";

  const setRole = async (role: FleetRole) => {
    await mutate(`role:${role}`, { action: "role", role }, `Device role changed to ${role}.`);
  };

  const lifecycle = async (action: "start" | "stop" | "restart" | "drain" | "resume") => {
    await mutate(`lifecycle:${action}`, { action: "lifecycle", lifecycle: action }, `Fleet ${action} completed.`);
  };

  const createEnrollment = async () => {
    const result = await mutate("create-enrollment", { action: "create-enrollment" }, "Single-use enrollment credential created.");
    if (result) setEnrollment(result as Enrollment);
  };

  const enroll = async () => {
    if (!selected || !credential.trim()) return;
    const result = await mutate(
      "enroll",
      { action: "enroll", candidateId: selected.id, credential: credential.trim() },
      `Paired with ${selected.name}.`,
    );
    if (result) setCredential("");
  };

  const startPairing = async () => {
    if (!selected) return;
    const result = await mutate(
      "request-pairing",
      { action: "request-pairing", candidateId: selected.id },
      `Pairing approval requested from ${selected.name}.`,
    );
    if (result) setOutbound({ ...(result as Omit<Outbound, "candidateName">), candidateName: selected.name });
  };

  const checkPairing = async () => {
    if (!outbound) return;
    const result = await mutate(
      "poll-pairing",
      { action: "poll-pairing", operationId: outbound.operationId },
      "Pairing status checked.",
    ) as { state?: string } | null;
    if (result?.state === "approved") {
      setOutbound(null);
      announce(`Paired with ${outbound.candidateName}.`);
    }
  };

  const decide = async (request: PairingRequest, decision: "approve" | "deny") => {
    const approved = decision === "approve" && !(await confirm({
      title: `Trust ${shortId(request.nodeId)}?`,
      body: "Only approve a device you recognize. Tailscale membership alone does not grant access.",
      confirmLabel: "Approve device",
    }));
    if (approved) return;
    await mutate(
      `${decision}:${request.requestId}`,
      { action: "decide-pairing", requestId: request.requestId, decision },
      decision === "approve" ? "Pairing request approved." : "Pairing request denied.",
    );
  };

  const revoke = async (node: TrustedNode) => {
    const accepted = await confirm({
      title: `Revoke ${shortId(node.nodeId)}?`,
      body: "This device will no longer be able to reconnect. Pair it again to restore access.",
      confirmLabel: "Revoke device",
      danger: true,
    });
    if (!accepted) return;
    await mutate(`revoke:${node.nodeId}`, { action: "revoke", nodeId: node.nodeId }, "Device access revoked.");
  };

  const dispatchSystemInfo = async (node: TrustedNode) => {
    await mutate(
      `dispatch:${node.nodeId}`,
      { action: "dispatch-system-info", nodeId: node.nodeId },
      "System information task queued for the executor.",
    );
  };

  if (loading && !snapshot) {
    return <section className="settings-fleet" aria-busy="true" role="status"><p className="settings-fleet-loading">Loading fleet status…</p></section>;
  }
  if (!snapshot) {
    return (
      <section className="settings-fleet">
        <ErrorState
          headline="Fleet setup unavailable"
          subtitle={error || "Start the Coven daemon, then retry."}
          actions={<Button variant="secondary" onClick={() => void refresh()}>Retry</Button>}
        />
      </section>
    );
  }

  return (
    <section className="settings-fleet" aria-labelledby="settings-fleet-title">
      <header className="settings-fleet-hero">
        <span className="settings-fleet-hero-icon" aria-hidden="true"><Icon name="ph:share-network-bold" width={20} /></span>
        <div>
          <p>Settings · Fleet</p>
          <h1 id="settings-fleet-title">Fleet</h1>
          <span>Connect trusted Coven devices over your Tailscale network.</span>
        </div>
        <Button variant="secondary" size="sm" leadingIcon="ph:arrows-clockwise" loading={loading} onClick={() => void refresh(true)}>
          Refresh
        </Button>
      </header>

      <div className="settings-fleet-boundary" role="note">
        <Icon name="ph:shield-warning" width={16} aria-hidden />
        <div><strong>Tailscale finds devices; Coven decides trust.</strong><span>A device must still be explicitly approved or use a short-lived credential.</span></div>
      </div>

      {error ? <div className="settings-fleet-error" role="alert">{error}</div> : null}

      <section id={settingsGroupId("This device")} data-settings-group className="settings-fleet-section" aria-labelledby="fleet-this-device">
        <div className="settings-fleet-rule"><h2 id="fleet-this-device">THIS DEVICE</h2><span /></div>
        <div className="settings-fleet-local-card">
          <div className="settings-fleet-local-summary">
            <div>
              <strong>{shortId(snapshot.local.deviceId)}</strong>
              <span>Updated <RelativeTime iso={snapshot.local.updatedAt} fallback="just now" /></span>
            </div>
            <StateDot
              tone={snapshot.local.lifecycle === "running" ? "success" : snapshot.local.lifecycle === "draining" ? "warning" : "neutral"}
              label={snapshot.local.lifecycle}
            />
          </div>
          <div className="settings-fleet-role-grid">
            {ROLES.map((role) => (
              <button
                type="button"
                key={role.id}
                className="settings-fleet-role focus-ring"
                aria-pressed={snapshot.local.role === role.id}
                data-selected={snapshot.local.role === role.id || undefined}
                disabled={busy !== null}
                onClick={() => void setRole(role.id)}
              >
                <Icon name={role.icon} width={16} aria-hidden />
                <strong>{role.label}</strong>
                <span>{role.description}</span>
              </button>
            ))}
          </div>
          <div className="settings-fleet-controls" aria-label="Fleet lifecycle">
            {snapshot.local.lifecycle === "stopped" ? (
              <Button variant="secondary" size="sm" leadingIcon="ph:play-fill" loading={busy === "lifecycle:start"} onClick={() => void lifecycle("start")}>Start</Button>
            ) : (
              <Button variant="secondary" size="sm" leadingIcon="ph:stop-fill" loading={busy === "lifecycle:stop"} onClick={() => void lifecycle("stop")}>Stop</Button>
            )}
            {snapshot.local.lifecycle === "draining" ? (
              <Button variant="secondary" size="sm" leadingIcon="ph:play" loading={busy === "lifecycle:resume"} onClick={() => void lifecycle("resume")}>Resume</Button>
            ) : hasExecutorRole && snapshot.local.lifecycle === "running" ? (
              <Button variant="secondary" size="sm" leadingIcon="ph:pause" loading={busy === "lifecycle:drain"} onClick={() => void lifecycle("drain")}>Drain</Button>
            ) : null}
            <Button variant="ghost" size="sm" leadingIcon="ph:arrows-clockwise" loading={busy === "lifecycle:restart"} onClick={() => void lifecycle("restart")}>Restart</Button>
          </div>
          <div className="settings-fleet-sharing">
            <div><strong>Share this executor</strong><span>{hasExecutorRole ? "Allow trusted hubs to send work while this device is running." : "Choose executor or both to make this device available."}</span></div>
            <button
              type="button"
              role="switch"
              aria-checked={snapshot.local.executorShared}
              aria-label="Share this executor"
              disabled={!hasExecutorRole || busy !== null}
              className={`settings-switch focus-ring${snapshot.local.executorShared ? " is-on" : ""}`}
              onClick={() => void mutate("sharing", { action: "sharing", enabled: !snapshot.local.executorShared }, snapshot.local.executorShared ? "Executor sharing disabled." : "Executor sharing enabled.")}
            ><span className="settings-switch__knob" aria-hidden /></button>
          </div>
          <p className="settings-fleet-availability" role="status">
            {snapshot.local.acceptingJobs ? "Available for trusted work." : snapshot.local.nextAction === "enable-sharing" ? "Running, but executor sharing is off." : `Not accepting work while ${snapshot.local.lifecycle}.`}
          </p>
          <p className="settings-fleet-capabilities">
            Capabilities · {snapshot.local.capabilities.length > 0 ? snapshot.local.capabilities.join(", ") : "none reported"}
          </p>
        </div>
      </section>

      <section id={settingsGroupId("Find devices")} data-settings-group className="settings-fleet-section" aria-labelledby="fleet-find-devices">
        <div className="settings-fleet-rule"><h2 id="fleet-find-devices">FIND DEVICES</h2><span /></div>
        {!snapshot.tailscale.available ? (
          <ErrorState compact headline="Tailscale unavailable" subtitle={`${snapshot.tailscale.error || "Open Tailscale and sign in."} Then refresh devices.`} />
        ) : snapshot.candidates.length === 0 ? (
          <EmptyState compact icon="ph:share-network" headline="No tailnet devices found" subtitle="Bring the other device online, then refresh." />
        ) : (
          <div className="settings-fleet-candidates" role="list" aria-label="Tailscale devices">
            {snapshot.candidates.map((candidate) => (
              <button
                type="button"
                role="listitem"
                key={candidate.id}
                className="settings-fleet-candidate focus-ring"
                data-selected={selectedCandidate === candidate.id || undefined}
                aria-pressed={selectedCandidate === candidate.id}
                onClick={() => setSelectedCandidate(candidate.id)}
              >
                <span className="settings-fleet-device-icon" aria-hidden><Icon name="ph:desktop" width={16} /></span>
                <span className="settings-fleet-candidate-copy"><strong>{candidate.name}</strong><span>{candidate.os || "Unknown OS"} · {candidate.reachable ? candidate.roles.join(" + ") || "Coven" : candidate.error || "Coven not detected"}</span></span>
                <StateDot tone={candidate.authenticated ? "success" : candidate.reachable ? "warning" : "neutral"} label={candidateStateLabel(candidate)} />
              </button>
            ))}
          </div>
        )}
        {selected ? (
          <div className="settings-fleet-pair-card">
            <div>
              <strong>{selected.authenticated ? `Connected to ${selected.name}` : `Pair with ${selected.name}`}</strong>
              <span>{selected.authenticated
                ? "This device can authenticate to that hub and reconnect automatically. Trust is directional."
                : selected.reachable
                  ? "Choose explicit approval or enter a single-use credential."
                  : "Coven must be running on this device before pairing."}</span>
            </div>
            {!selected.authenticated ? <>
              <Button variant="secondary" size="sm" leadingIcon="ph:shield-warning" disabled={!selected.reachable || busy !== null} loading={busy === "request-pairing"} onClick={() => void startPairing()}>Request approval</Button>
              <div className="settings-fleet-credential-entry">
                <label htmlFor="fleet-enrollment-credential">Enrollment credential</label>
                <input
                  id="fleet-enrollment-credential"
                  className="focus-ring"
                  type="password"
                  autoComplete="off"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder="Paste credential…"
                />
                <Button variant="secondary" size="sm" disabled={!selected.reachable || !credential.trim() || busy !== null} loading={busy === "enroll"} onClick={() => void enroll()}>Pair device</Button>
              </div>
            </> : null}
            {outbound ? (
              <div className="settings-fleet-pending" role="status">
                <span>Waiting for approval on {outbound.candidateName} · expires <RelativeTime iso={outbound.expiresAt} fallback="soon" /></span>
                <Button variant="secondary" size="xs" loading={busy === "poll-pairing"} onClick={() => void checkPairing()}>Check approval</Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="settings-fleet-section" aria-labelledby="fleet-approve-devices">
        <div className="settings-fleet-rule"><h2 id="fleet-approve-devices">PAIRING</h2><span /></div>
        <div className="settings-fleet-enrollment">
          <div><strong>Single-use credential</strong><span>Create a credential that expires after five minutes. Share it through a trusted channel.</span></div>
          <Button variant="secondary" size="sm" leadingIcon="ph:key-bold" disabled={!hasHubRole} loading={busy === "create-enrollment"} onClick={() => void createEnrollment()}>Create credential</Button>
          {enrollment ? (
            <div className="settings-fleet-secret" role="status">
              <code>{enrollment.credential}</code>
              <span>Expires <RelativeTime iso={enrollment.expiresAt} fallback="in five minutes" /> · shown only for this enrollment</span>
            </div>
          ) : null}
        </div>
        {!hasHubRole ? (
          <p className="settings-fleet-empty">Choose hub or both to approve devices and create credentials.</p>
        ) : snapshot.incoming.length > 0 ? (
          <div className="settings-fleet-incoming">
            {snapshot.incoming.map((request) => (
              <div key={request.requestId} className="settings-fleet-incoming-row">
                <div><strong>{shortId(request.nodeId)}</strong><span>Requests access · expires <RelativeTime iso={request.expiresAt} fallback="soon" /></span></div>
                <Button variant="ghost" size="xs" onClick={() => void decide(request, "deny")}>Deny</Button>
                <Button variant="secondary" size="xs" onClick={() => void decide(request, "approve")}>Approve</Button>
              </div>
            ))}
          </div>
        ) : <p className="settings-fleet-empty">No pairing requests are waiting.</p>}
      </section>

      <section className="settings-fleet-section" aria-labelledby="fleet-trusted-devices">
        <div className="settings-fleet-rule"><h2 id="fleet-trusted-devices">DEVICES APPROVED BY THIS HUB</h2><span /><span>{activeTrusted.length} active</span></div>
        {!hasHubRole ? (
          <p className="settings-fleet-empty">This device is not a hub. Choose hub or both to approve devices here.</p>
        ) : activeTrusted.length === 0 ? (
          <EmptyState compact icon="ph:shield-slash" headline="No approved devices" subtitle="Approve a pairing request or share a single-use credential to trust a device." />
        ) : (
          <div className="settings-fleet-trusted">
            {activeTrusted.map((node) => (
              <div key={node.nodeId} className="settings-fleet-trusted-row">
                <span className="settings-fleet-device-icon" aria-hidden><Icon name="ph:desktop" width={16} /></span>
                <div><strong>{shortId(node.nodeId)}</strong><span>Last authenticated <RelativeTime iso={node.lastSeenAt} fallback="unknown" /> · trusted <RelativeTime iso={node.enrolledAt} fallback="unknown" /></span></div>
                <Button variant="secondary" size="xs" loading={busy === `dispatch:${node.nodeId}`} disabled={busy !== null} onClick={() => void dispatchSystemInfo(node)}>Run system check</Button>
                <Button variant="danger-ghost" size="xs" onClick={() => void revoke(node)}>Revoke</Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {hasHubRole ? (
        <section className="settings-fleet-section" aria-labelledby="fleet-executor-jobs">
          <div className="settings-fleet-rule"><h2 id="fleet-executor-jobs">EXECUTOR JOBS</h2><span /><span>{snapshot.jobs.length} recent</span></div>
          {snapshot.jobs.length === 0 ? (
            <EmptyState compact icon="ph:terminal-window" headline="No executor jobs" subtitle="Run a system check on an approved device to verify remote execution." />
          ) : (
            <div className="settings-fleet-trusted">
              {snapshot.jobs.map((job) => (
                <div key={job.jobId} className="settings-fleet-trusted-row">
                  <span className="settings-fleet-device-icon" aria-hidden><Icon name="ph:terminal-window-bold" width={16} /></span>
                  <div>
                    <strong>{job.state === "completed" ? "System check completed" : job.state === "failed" ? "System check failed" : "System check queued"}</strong>
                    <span>{shortId(job.targetNodeId)} · {job.result?.stdout?.trim() || job.result?.error || "Waiting for the executor…"}</span>
                  </div>
                  <StateDot tone={job.state === "completed" ? "success" : job.state === "failed" ? "warning" : "neutral"} label={job.state} />
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}
