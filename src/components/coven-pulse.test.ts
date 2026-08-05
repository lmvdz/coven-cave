import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const component = await readFile(new URL("./coven-pulse.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../app/quick-chat/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../styles/coven-pulse.css", import.meta.url), "utf8");

assert.match(route, /params\.pulse === "1"/);
assert.match(component, /fetch\("\/api\/daemon\/status"/);
assert.match(component, /fetch\("\/api\/sessions\/list"/);
assert.match(component, /fetch\("\/api\/chat\/usage\?scope=all"/);
assert.match(component, /sessionStatusTone\(session\.status\) === "running"/);
assert.match(component, /Throughput[\s\S]*Unavailable/);
assert.match(component, /API equivalent[\s\S]*Unreported/);
assert.match(component, /Recorded locally · partial/);
assert.match(component, /Harness-reported · partial/);
assert.doesNotMatch(component, /tokensPerSecond|throughput:/);
assert.match(component, /pulse:dismiss/);
assert.match(component, /pulse:open-cave/);
assert.match(component, /event\.key === "Escape"/);
assert.match(component, /aria-live="polite"/);
assert.match(component, /role="alert"/);
assert.match(css, /prefers-reduced-motion: reduce/);
assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);

console.log("coven-pulse: ok");
