// Kept as a plain string so generated procedure code runs in a separate worker with no imports.
export const PROCEDURE_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

let sequence = 0;
const pending = new Map();

function rpc(method, args) {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "rpc", id, method, args });
  });
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "reply") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(Object.assign(new Error(message.error || "Procedure host request failed."), { name: message.name || "Error" }));
});

// Only a JSON string crosses from this host callback into the VM. The callback itself is captured
// by VM-created closures and is never exposed as an object property to generated code.
async function bridge(method, argsJson) {
  try {
    const value = await rpc(method, JSON.parse(argsJson));
    return JSON.stringify({ ok: true, value });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      name: error && error.name ? error.name : "Error",
      error: error && error.message ? error.message : String(error),
    });
  }
}

const context = vm.createContext(Object.create(null), {
  name: "pi-procedure",
  codeGeneration: { strings: false, wasm: false },
});

(async () => {
  try {
    const apiFactorySource =
      "((hostBridge, inputJson) => {" +
      "  const deepFreeze = (value, seen = new WeakSet()) => {" +
      "    if (!value || typeof value !== 'object' || seen.has(value)) return value;" +
      "    seen.add(value);" +
      "    for (const key of Object.keys(value)) deepFreeze(value[key], seen);" +
      "    return Object.freeze(value);" +
      "  };" +
      "  const call = async (method, args) => {" +
      "    const envelope = JSON.parse(await hostBridge(method, JSON.stringify(args)));" +
      "    if (!envelope.ok) throw Object.assign(new Error(envelope.error), { name: envelope.name });" +
      "    return envelope.value;" +
      "  };" +
      "  return Object.freeze({" +
      "    input: deepFreeze(JSON.parse(inputJson))," +
      "    agent: (id, prompt, options = {}) => call('agent', { id, prompt, ...options })," +
      "    phase: (name) => call('phase', { name })," +
      "    log: (message, data) => call('log', { message, data })," +
      "    artifact: (name, value) => call('artifact', { name, value })," +
      "    approval: (label, details) => call('approval', { label, details })," +
      "    sleep: (ms) => call('sleep', { ms })," +
      "  });" +
      "})";
    const apiFactory = new vm.Script(apiFactorySource, { filename: "procedure-api.js" })
      .runInContext(context, { timeout: 1000 });
    const inputJson = JSON.stringify(workerData.input == null ? {} : workerData.input);
    const api = apiFactory(bridge, inputJson);

    const wrapped = "(async ($) => {\n\"use strict\";\n" + workerData.source + "\n})";
    const script = new vm.Script(wrapped, { filename: workerData.filename || "procedure.proc.js" });
    const procedure = script.runInContext(context, { timeout: 1000 });
    const result = await procedure(api);
    // Clone through JSON before exposing the value to the worker host.
    const serialized = JSON.stringify({ value: result });
    parentPort.postMessage({ type: "done", result: JSON.parse(serialized).value });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      name: error && error.name ? error.name : "Error",
      error: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 16000) : undefined,
    });
  }
})();
`;
