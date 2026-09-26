"use strict";

// ../../workers/learner-runtime/src/guest.ts
process.title = "agentglass-guest";
var bundlePath = process.argv[2];
if (!bundlePath) {
  console.error("usage: guest.cjs <bundle.cjs>");
  process.exit(2);
}
var mod;
process.on("message", (raw) => {
  if (raw.kind === "dispose") {
    process.exit(0);
  }
  if (raw.kind !== "invoke") return;
  const respond = (payload) => {
    if (typeof process.send === "function") process.send(payload);
  };
  try {
    if (!mod) {
      mod = require(bundlePath);
    }
    const fn = mod?.[raw.slot];
    if (typeof fn !== "function") {
      respond({ id: raw.id, ok: false, error: `EXTENSION_SLOT_NOT_BOUND: ${raw.slot}` });
      return;
    }
    const value = fn(raw.arg);
    respond({ id: raw.id, ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
  } catch (err) {
    respond({ id: raw.id, ok: false, error: String(err).slice(0, 500) });
  