// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("./settings-fleet.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("./settings-shell.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./settings-sections.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/settings-fleet.css", import.meta.url), "utf8");

assert.match(shell, /import \{ FleetSection \} from "\.\/settings-fleet"/, "Settings should lazy-own a focused Fleet surface");
assert.match(shell, /section === "fleet" && <FleetSection \/>/, "Fleet should be directly reachable from Settings");
assert.match(sections, /id: "fleet", label: "Fleet"/, "Fleet should be indexed as a first-class settings destination");

for (const role of ["hub", "executor", "both"]) {
  assert.match(component, new RegExp(`id: "${role}"`), `the local role picker should expose ${role}`);
}
for (const action of ["start", "stop", "restart", "drain", "resume"]) {
  assert.match(component, new RegExp(`lifecycle\\(\\"${action}\\"\\)`), `the lifecycle controls should expose ${action}`);
}
assert.match(component, /role="switch"[\s\S]*aria-checked=\{snapshot\.local\.executorShared\}/, "executor sharing should be an accessible switch");
assert.match(component, /Tailscale finds devices; Coven decides trust/, "the trust boundary should be visible beside discovery");
assert.match(component, /type="password"[\s\S]*autoComplete="off"/, "enrollment credentials should not render as plain text inputs");
assert.match(component, /Request approval/, "explicit approval pairing should remain available");
assert.match(component, /"Connected to hub"/, "authenticated reconnect should describe the directional hub connection");
assert.match(component, /"Executor reachable"/, "a reachable executor should not imply reciprocal authentication");
assert.match(component, /DEVICES APPROVED BY THIS HUB/, "the trust registry should identify the approving side of trust");
assert.match(component, /This device is not a hub/, "executor-only devices should explain why their approval registry is empty");
assert.match(component, /Trust is directional/, "an authenticated candidate should explain automatic reconnect without implying mutual trust");
assert.match(component, /Run system check/, "approved devices should offer an explicit bounded executor test");
assert.match(component, /action: "work-once"/, "a shared executor should poll for authenticated hub work while Fleet is open");
assert.match(component, /EXECUTOR JOBS/, "the hub should show durable executor job results");
assert.match(component, /System check completed/, "completed remote work should be distinguishable from queued work");
assert.match(component, /Capabilities ·/, "local capabilities should remain visible beside availability");
assert.match(component, /Single-use credential/, "short-lived credential pairing should remain available");
assert.match(component, /useConfirm\(\)/, "approval and revocation should use the focus-trapped confirm primitive");
assert.match(component, /useAnnouncer\(\)/, "fleet mutations should be announced");
assert.match(component, /id=\{settingsGroupId\("This device"\)\}/, "Fleet search should reach the local-device group");
assert.match(component, /id=\{settingsGroupId\("Find devices"\)\}/, "Fleet search should reach discovery");
assert.match(component, /variant="danger-ghost"[\s\S]*Revoke/, "trusted devices should expose revocation as destructive");
assert.match(css, /@container settings-fleet \(max-width:/, "Fleet should adapt to its settings pane rather than the viewport");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "Fleet should define a reduced-motion treatment");
assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "Fleet CSS should use theme tokens only");

console.log("settings-fleet.test.ts: ok");
