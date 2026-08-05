import { exactSemver } from "./exact-semver.ts";

/** The named daemon API versions Cave can safely adopt. */
export const SUPPORTED_DAEMON_API_VERSIONS = new Set(["coven.daemon.v1", "1", "v1"]);

export type DaemonStartupHealth = {
  ok?: unknown;
  apiVersion?: unknown;
  covenVersion?: unknown;
  daemon?: { pid?: unknown; startedAt?: unknown; socket?: unknown };
};

export type DaemonStartupCompatibility =
  | { ok: true; daemonVersion: string; apiVersion: string }
  | {
    ok: false;
    code: "invalid_health" | "unsupported_api" | "invalid_runtime_version" | "runtime_version_mismatch";
    diagnostic: string;
  };

/**
 * A listening socket is only a transport fact. Cave adopts a local daemon
 * only after the health document identifies a supported API and a usable
 * installed runtime. Release daemons must match that runtime exactly. Source
 * builds use the workspace's intentional `0.0.0` sentinel, so their named API
 * contract is the compatibility boundary and the installed version supplies
 * the display version.
 */
export function assessDaemonStartupCompatibility(
  health: DaemonStartupHealth | null | undefined,
  installedVersion: string | null,
): DaemonStartupCompatibility {
  if (!health || health.ok === false || typeof health !== "object") {
    return {
      ok: false,
      code: "invalid_health",
      diagnostic: "The local Coven daemon did not publish a usable readiness document. Restart Coven and try again.",
    };
  }

  const apiVersion = typeof health.apiVersion === "string" ? health.apiVersion.trim() : "";
  if (!SUPPORTED_DAEMON_API_VERSIONS.has(apiVersion)) {
    return {
      ok: false,
      code: "unsupported_api",
      diagnostic: "The running Coven daemon uses an incompatible API. Update Coven, then restart the daemon.",
    };
  }

  const daemonVersion = exactSemver(health.covenVersion);
  if (!daemonVersion) {
    return {
      ok: false,
      code: "invalid_runtime_version",
      diagnostic: "The running Coven daemon did not report a valid runtime version. Update Coven, then restart the daemon.",
    };
  }

  const expectedVersion = exactSemver(installedVersion);
  if (!expectedVersion) {
    return {
      ok: false,
      code: "invalid_runtime_version",
      diagnostic: "Cave could not verify the installed Coven runtime version. Repair or reinstall Coven before starting the daemon.",
    };
  }

  if (daemonVersion === "0.0.0") {
    return { ok: true, daemonVersion: expectedVersion, apiVersion };
  }

  if (daemonVersion !== expectedVersion) {
    return {
      ok: false,
      code: "runtime_version_mismatch",
      diagnostic: "The running Coven daemon does not match the installed runtime. Restart the daemon after updating Coven.",
    };
  }

  return { ok: true, daemonVersion, apiVersion };
}
