// @ts-nocheck
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const settingsShell = await readFile(new URL("./settings-shell.tsx", import.meta.url), "utf8");
const settingsDaemon = await readFile(new URL("./settings-daemon.tsx", import.meta.url), "utf8");
const settings = `${settingsShell}\n${settingsDaemon}`;
const workspace = await readFile(new URL("./workspace.tsx", import.meta.url), "utf8");

assert.match(settings, /fetch\("\/api\/daemon\/start", \{ method: "POST" \}\)/);
assert.match(settings, /Start daemon/);
assert.match(settings, /Restart daemon/);
assert.match(settings, /rocket-launch-bold/);
assert.match(
  settings,
  /const canStartDaemon =[\s\S]*?status\?\.availability === undefined \|\| status\.availability === "offline"/,
  "daemon settings should offer Start only for explicit offline or legacy status",
);
assert.match(settings, /\{canStartDaemon && \(/);
assert.match(settings, /status\?\.running && \(/);
assert.match(
  settings,
  /fetch\("\/api\/daemon\/start", \{[\s\S]*method: "POST"[\s\S]*JSON\.stringify\(\{ restart: true \}\)/,
  "daemon settings should post an explicit restart request when restarting",
);

// Settings unmounts a section when you switch away from it, so a start begun on
// the Daemon panel lost its "Starting…" label and its follow-up status read the
// moment you visited Fleet. Coming back showed a single stale read — "Offline" —
// and nothing polled again, so it never corrected itself.
assert.match(
  settingsDaemon,
  /let inFlightDaemonAction: \{ kind: "start" \| "restart"; settled: Promise<void> \} \| null = null/,
  "the in-flight daemon action should live at module scope so it outlives the section",
);
assert.match(
  settingsDaemon,
  /useState\(\(\) => inFlightDaemonAction\?\.kind === "start"\)/,
  "a remount should show a start that is still in flight rather than resetting to idle",
);
assert.match(
  settingsDaemon,
  /usePausablePoll\(/,
  "the daemon panel should keep polling status while it is open, not read once on mount",
);
assert.match(
  settingsDaemon,
  /starting \|\| restarting \? DAEMON_STATUS_POLL_ACTIVE_MS : DAEMON_STATUS_POLL_MS/,
  "polling should tighten while a launch is in flight",
);

assert.match(
  workspace,
  /const refreshDaemonStatus = useCallback\([\s\S]*daemonConnectionSupervisorRef\.current\?\.refresh\(\{ fresh: opts\?\.fresh === true \|\| opts\?\.trusted === true \}\)/,
  "Workspace should expose daemon connection refresh through the shared supervisor",
);

assert.match(
  workspace,
  /const startDaemon = useCallback\(async \(\{ automatic = false \}: \{ automatic\?: boolean \} = \{\}\) => \{[\s\S]*daemonRecoveryPresentation\(current,[\s\S]*await waitForDaemonUpdateIdle\(\)[\s\S]*runWorkspaceDaemonStart\(\{[\s\S]*automatic,[\s\S]*fetchImpl: fetch[\s\S]*refreshStatus: refreshDaemonStatus/,
  "Workspace automatic and manual starts should share one flow with explicit intent",
);

assert.match(
  workspace,
  /cta: \{[\s\S]*label: "Start daemon"[\s\S]*onClick: \(\) => \{[\s\S]*void startDaemon\(\)/,
  "Workspace offline banner should use the shared daemon start handler",
);
