import { randomUUID } from "node:crypto";
import { callDaemonTarget, extractDaemonError, localDaemonTarget } from "../coven-daemon.ts";
import { loadTailscaleDevices, type TailscaleDevice } from "./tailscale-devices.ts";

export const FLEET_PROTOCOL = "coven.fleet.v1";
const FLEET_PORT = 8787;
const DISCOVERY_TIMEOUT_MS = 1_200;
const OPERATION_TIMEOUT_MS = 4_000;
const MAX_DISCOVERY_CANDIDATES = 64;

export type FleetRole = "hub" | "executor" | "both";
export type FleetLifecycle = "stopped" | "running" | "draining";

export type LocalFleetNode = {
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

export type FleetCandidate = {
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

export type TrustedFleetNode = {
  nodeId: string;
  enrolledAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

export type PairingRequest = {
  requestId: string;
  nodeId: string;
  state: "pending";
  expiresAt: string;
  createdAt: string;
};

type Advertisement = {
  service: "coven-fleet";
  protocolVersions: string[];
  roles: FleetRole[];
  pairingAvailable: boolean;
};

type OutboundPairing = {
  candidateId: string;
  requestId: string;
  requestSecret: string;
  expiresAt: string;
};

const outboundPairings = new Map<string, OutboundPairing>();

async function localCall<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const response = await callDaemonTarget<T>(localDaemonTarget(), {
    method,
    path,
    ...(body === undefined ? {} : { body }),
    timeoutMs: 4_000,
    retryTransportFailure: method === "GET",
  });
  if (!response.ok || response.data === null) {
    throw new Error(
      extractDaemonError(response) ?? response.error ?? "Coven Fleet is unavailable. Update Coven and retry.",
    );
  }
  return response.data;
}

function candidateId(device: TailscaleDevice): string | null {
  return device.tailnetIp && !device.isSelf ? device.tailnetIp : null;
}

function candidateUrl(id: string, path: string): string {
  return `http://${id}:${FLEET_PORT}/api/v1${path}`;
}

async function resolveCandidate(id: string): Promise<TailscaleDevice> {
  const inventory = await loadTailscaleDevices();
  if (!inventory.ok) throw new Error(inventory.reason);
  const match = inventory.devices.find((device) => candidateId(device) === id);
  if (!match) throw new Error("That device is no longer in your Tailscale network. Refresh devices.");
  if (!match.online) throw new Error("That device is offline. Bring it online and retry.");
  return match;
}

async function remoteCall<T>(
  candidate: TailscaleDevice,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = OPERATION_TIMEOUT_MS,
): Promise<T> {
  const id = candidateId(candidate);
  if (!id) throw new Error("A valid Tailscale peer is required.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidateUrl(id, path), {
      method,
      signal: controller.signal,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
    if (!response.ok || payload === null) {
      throw new Error(payload?.error?.message || `The device returned ${response.status}.`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The Coven service did not answer in time.");
    }
    throw error instanceof Error ? error : new Error("The Coven service could not be reached.");
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCandidate(device: TailscaleDevice): Promise<FleetCandidate | null> {
  const id = candidateId(device);
  if (!id) return null;
  if (!device.online) {
    return {
      id,
      name: device.name,
      os: device.os,
      online: false,
      reachable: false,
      roles: [],
      protocolVersions: [],
      pairingAvailable: false,
      authenticated: false,
      error: "Device offline",
    };
  }
  try {
    const advertisement = await remoteCall<Advertisement>(
      device,
      "GET",
      "/discovery/advertisement",
      undefined,
      DISCOVERY_TIMEOUT_MS,
    );
    if (advertisement.service !== "coven-fleet") return null;
    return {
      id,
      name: device.name,
      os: device.os,
      online: true,
      reachable: true,
      roles: advertisement.roles,
      protocolVersions: advertisement.protocolVersions,
      pairingAvailable: advertisement.pairingAvailable,
      authenticated: false,
    };
  } catch (error) {
    return {
      id,
      name: device.name,
      os: device.os,
      online: true,
      reachable: false,
      roles: [],
      protocolVersions: [],
      pairingAvailable: false,
      authenticated: false,
      error: error instanceof Error ? error.message : "Coven service unavailable",
    };
  }
}

export async function fleetSnapshot() {
  const [local, trusted, incoming, inventory] = await Promise.all([
    localCall<LocalFleetNode>("GET", "/api/v1/fleet/local-node"),
    localCall<{ nodes: TrustedFleetNode[] }>("GET", "/api/v1/fleet/trusted-nodes"),
    localCall<{ requests: PairingRequest[] }>("GET", "/api/v1/fleet/pairing-requests"),
    loadTailscaleDevices(),
  ]);
  const discovered = inventory.ok
    ? (await Promise.all(inventory.devices.slice(0, MAX_DISCOVERY_CANDIDATES).map(probeCandidate))).filter(
        (candidate): candidate is FleetCandidate => candidate !== null,
      )
    : [];
  const candidates = await Promise.all(
    discovered.map(async (candidate) => ({
      ...candidate,
      authenticated: candidate.reachable
        ? await reconnectCandidate(candidate.id, local.deviceId).catch(() => false)
        : false,
    })),
  );
  return {
    local,
    trusted: trusted.nodes,
    incoming: incoming.requests,
    tailscale: inventory.ok
      ? { available: true as const, error: null }
      : { available: false as const, error: inventory.reason },
    candidates,
  };
}

async function reconnectCandidate(candidateIdValue: string, nodeId: string): Promise<boolean> {
  const candidate = await resolveCandidate(candidateIdValue);
  const challenge = await remoteCall<{ nonce: string }>(candidate, "POST", "/fleet/challenges", { nodeId });
  const localProof = await localCall<{ nodeId: string; nonce: string; proof: string }>(
    "POST",
    `/api/v1/fleet/local-credentials/${encodeURIComponent(candidateIdValue)}/proof`,
    { nonce: challenge.nonce },
  );
  const reconnected = await remoteCall<{ authenticated: boolean }>(candidate, "POST", "/fleet/reconnect", {
    nodeId: localProof.nodeId,
    nonce: localProof.nonce,
    proof: localProof.proof,
  });
  return reconnected.authenticated === true;
}

export function configureRole(role: FleetRole) {
  return localCall<LocalFleetNode>("PUT", "/api/v1/fleet/local-node/role", { role, capabilities: [] });
}

export function configureSharing(enabled: boolean) {
  return localCall<LocalFleetNode>("PUT", "/api/v1/fleet/local-node/sharing", { enabled });
}

export function runLifecycle(action: "start" | "stop" | "restart" | "drain" | "resume") {
  const body = action === "restart" ? { operationId: randomUUID() } : undefined;
  return localCall<LocalFleetNode>("POST", `/api/v1/fleet/local-node/lifecycle/${action}`, body);
}

export function createEnrollment() {
  return localCall<{ credential: string; expiresAt: string; singleUse: true }>(
    "POST",
    "/api/v1/fleet/enrollment-credentials",
    { ttlSeconds: 300 },
  );
}

async function storeCredential(candidateIdValue: string, nodeId: string, nodeCredential: string) {
  await localCall("POST", "/api/v1/fleet/local-credentials", {
    hubId: candidateIdValue,
    nodeId,
    nodeCredential,
  });
}

export async function enrollWithCredential(candidateIdValue: string, credential: string) {
  const candidate = await resolveCandidate(candidateIdValue);
  const local = await localCall<LocalFleetNode>("GET", "/api/v1/fleet/local-node");
  const enrolled = await remoteCall<{ nodeId: string; nodeCredential: string }>(
    candidate,
    "POST",
    "/fleet/enroll",
    { nodeId: local.deviceId, enrollmentCredential: credential, protocolVersion: FLEET_PROTOCOL },
  );
  await storeCredential(candidateIdValue, enrolled.nodeId, enrolled.nodeCredential);
  return { paired: true as const, nodeId: enrolled.nodeId };
}

export async function requestPairing(candidateIdValue: string) {
  const candidate = await resolveCandidate(candidateIdValue);
  const local = await localCall<LocalFleetNode>("GET", "/api/v1/fleet/local-node");
  const request = await remoteCall<{
    requestId: string;
    requestSecret: string;
    expiresAt: string;
  }>(candidate, "POST", "/fleet/pairing-requests", {
    nodeId: local.deviceId,
    protocolVersion: FLEET_PROTOCOL,
  });
  const operationId = randomUUID();
  outboundPairings.set(operationId, {
    candidateId: candidateIdValue,
    requestId: request.requestId,
    requestSecret: request.requestSecret,
    expiresAt: request.expiresAt,
  });
  return { operationId, requestId: request.requestId, expiresAt: request.expiresAt, state: "pending" as const };
}

export async function pollPairing(operationId: string) {
  const pending = outboundPairings.get(operationId);
  if (!pending) throw new Error("This pairing request is no longer active. Start a new request.");
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    outboundPairings.delete(operationId);
    throw new Error("The pairing request expired. Start a new request.");
  }
  const candidate = await resolveCandidate(pending.candidateId);
  const result = await remoteCall<{
    state: "pending" | "approved";
    nodeId?: string;
    nodeCredential?: string;
  }>(candidate, "POST", `/fleet/pairing-requests/${encodeURIComponent(pending.requestId)}/claim`, {
    requestSecret: pending.requestSecret,
  });
  if (result.state === "pending") return { state: "pending" as const };
  if (!result.nodeId || !result.nodeCredential) throw new Error("The approved device returned an invalid credential.");
  await storeCredential(pending.candidateId, result.nodeId, result.nodeCredential);
  outboundPairings.delete(operationId);
  return { state: "approved" as const, nodeId: result.nodeId };
}

export function decidePairing(requestId: string, decision: "approve" | "deny") {
  return localCall<{ requestId: string; state: "approved" | "denied" }>(
    "POST",
    `/api/v1/fleet/pairing-requests/${encodeURIComponent(requestId)}/${decision}`,
  );
}

export function revokeNode(nodeId: string) {
  return localCall<{ nodeId: string; revoked: true }>(
    "POST",
    `/api/v1/fleet/trusted-nodes/${encodeURIComponent(nodeId)}/revoke`,
  );
}
