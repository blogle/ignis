import { EventEmitter } from "./events.js";
import { wsClient } from "../ws-client.js";

const API = "/api/child-process";
const session = globalThis.crypto?.randomUUID?.() || (() => {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") || Math.random().toString(36).slice(2);
})();
const children = new Map();
const pending = new Map();
let attached = false;

function unsupported(name) {
  throw new Error(`child_process.${name}() is not supported by Ignis`);
}

function bytesToBase64(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function encodeInput(value, encoding = "utf8") {
  if (typeof value !== "string" || encoding === "utf8") return bytesToBase64(value);
  if (globalThis.Buffer) return bytesToBase64(globalThis.Buffer.from(value, encoding));
  throw new TypeError(`input encoding ${encoding} requires Buffer`);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes;
}

function outputValue(bytes, encoding) {
  if (encoding === "buffer" || encoding === null || encoding === undefined) {
    return globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes;
  }
  return new TextDecoder(encoding).decode(bytes);
}

class ProcessStream extends EventEmitter {
  constructor(child, writable) {
    super();
    this.child = child;
    this.writable = writable;
    this.readable = !writable;
  }

  write(data, encoding, callback) {
    if (!this.writable) return false;
    if (typeof encoding === "function") callback = encoding;
    this.child.sendControl("stdin", {
      data: bytesToBase64(typeof data === "string" && typeof encoding === "string" && encoding !== "utf8" ? globalThis.Buffer.from(data, encoding) : data),
    });
    callback?.();
    return true;
  }

  end(data, encoding, callback) {
    if (data !== undefined) this.write(data, encoding);
    if (this.writable) this.child.sendControl("end", {});
    callback?.();
    this.emit("finish");
    return this;
  }
}

class ChildProcess extends EventEmitter {
  constructor(id, pid) {
    super();
    this.pidHandle = id;
    this.pid = pid;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.error = null;
    this.controlQueue = [];
    this.stdin = new ProcessStream(this, true);
    this.stdout = new ProcessStream(this, false);
    this.stderr = new ProcessStream(this, false);
  }

  kill(signal) {
    if (this.killed) return false;
    this.killed = true;
    this.sendControl("kill", { signal });
    return true;
  }

  sendControl(type, payload) {
    if (!this.pidHandle) {
      this.controlQueue.push([type, payload]);
      return;
    }
    wsClient.channel("child-process").send(type, { session, processId: this.pidHandle, ...payload });
  }
}

function attach() {
  if (attached) return;
  attached = true;
  const channel = wsClient.channel("child-process");
  for (const type of ["spawn", "data", "error", "exit", "close"]) {
    channel.subscribe(type, (message) => {
      const child = children.get(message.processId);
      if (!child) {
        if (!pending.has(message.processId)) pending.set(message.processId, []);
        pending.get(message.processId).push(message);
        return;
      }
      if (message.type === "spawn") {
        child.pid = message.pid;
        child.emit("spawn");
      } else if (message.type === "data") {
        child[message.stream].emit("data", base64ToBytes(message.data));
      } else if (message.type === "error") {
        const error = new Error(message.error?.message || "child process failed");
        error.code = message.error?.code;
        child.error = error;
        child.emit("error", error);
      } else if (message.type === "exit") {
        child.exitCode = message.code;
        child.signalCode = message.signal;
        child.emit("exit", message.code, message.signal);
      } else {
        child.stdout.emit("end");
        child.stderr.emit("end");
        child.emit("close", message.code, message.signal);
        children.delete(message.processId);
      }
    });
  }
  wsClient.channel("child-process").send("attach", { session });
}

wsClient.onStateChange((state) => {
  if (attached && state === "open") wsClient.channel("child-process").send("attach", { session });
});

function body(command, args, options) {
  const normalized = { ...options };
  if (normalized.input !== undefined) {
    normalized.input = encodeInput(normalized.input, normalized.inputEncoding);
    normalized.inputEncoding = "base64";
  }
  return { vault: globalThis.__currentVaultId, session, command, args, options: normalized };
}

async function request(endpoint, data) {
  attach();
  const response = await fetch(API + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "child_process request failed");
    error.code = result.code;
    throw error;
  }
  return result;
}

function requestSync(data) {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", API + "/sync", false);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.send(JSON.stringify(data));
  const result = JSON.parse(xhr.responseText || "{}");
  if (xhr.status >= 400) {
    const error = new Error(result.error || "child_process request failed");
    error.code = result.code;
    throw error;
  }
  result.stdout = base64ToBytes(result.stdout || "");
  result.stderr = base64ToBytes(result.stderr || "");
  return result;
}

export function spawn(command, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args || {}; args = []; }
  const child = new ChildProcess(null, null);
  request("/spawn", body(command, args, options)).then((result) => {
    child.pidHandle = result.id;
    child.pid = result.pid;
    children.set(result.id, child);
    for (const [type, payload] of child.controlQueue.splice(0)) child.sendControl(type, payload);
    for (const message of pending.get(result.id) || []) dispatchMessage(message);
    pending.delete(result.id);
  }, (error) => {
    child.error = error;
    child.emit("error", error);
    child.emit("close", null, null);
  });
  return child;
}

function dispatchMessage(message) {
  const child = children.get(message.processId);
  if (!child) return;
  if (message.type === "spawn") {
    child.pid = message.pid;
    child.emit("spawn");
  } else if (message.type === "data") {
    child[message.stream].emit("data", base64ToBytes(message.data));
  } else if (message.type === "error") {
    const error = new Error(message.error?.message || "child process failed");
    error.code = message.error?.code;
    child.error = error;
    child.emit("error", error);
  } else if (message.type === "exit") {
    child.exitCode = message.code;
    child.signalCode = message.signal;
    child.emit("exit", message.code, message.signal);
  } else {
    child.stdout.emit("end");
    child.stderr.emit("end");
    child.emit("close", message.code, message.signal);
    children.delete(message.processId);
  }
}

export function exec(command, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const child = spawn(command, [], { ...options, shell: true });
  collect(child, options, callback);
  return child;
}

export function execFile(file, args = [], options, callback) {
  if (typeof args === "function") { callback = args; options = {}; args = []; }
  else if (!Array.isArray(args)) { callback = options; options = args; args = []; }
  if (typeof options === "function") { callback = options; options = {}; }
  const child = spawn(file, args, options || {});
  collect(child, options, callback);
  return child;
}

function collect(child, options = {}, callback) {
  const out = [], err = [];
  child.stdout.on("data", (data) => out.push(data));
  child.stderr.on("data", (data) => err.push(data));
  child.on("close", (code, signal) => {
    const encoding = options.encoding === "buffer" ? null : (options.encoding || "utf8");
    const stdout = join(out, encoding), stderr = join(err, encoding);
    if (callback) {
      const failure = code === 0 ? null : Object.assign(new Error(`Command failed: ${code ?? signal}`), {
        code: code ?? signal,
        signal,
        stdout,
        stderr,
      });
      callback(failure, stdout, stderr);
    }
  });
}

function join(parts, encoding) {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return outputValue(bytes, encoding);
}

export function spawnSync(command, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args || {}; args = []; }
  const result = requestSync(body(command, args, options));
  result.stdout = outputValue(result.stdout, options.encoding);
  result.stderr = outputValue(result.stderr, options.encoding);
  return result;
}

export function execSync(command, options = {}) {
  const result = requestSync(body(command, [], { ...options, shell: true }));
  result.stdout = outputValue(result.stdout, options.encoding === undefined ? "utf8" : options.encoding);
  result.stderr = outputValue(result.stderr, options.encoding === undefined ? "utf8" : options.encoding);
  if (result.error || result.status !== 0) throw Object.assign(new Error("Command failed"), result.error || { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
  return result.stdout;
}

export function execFileSync(file, args = [], options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const result = requestSync(body(file, args, options || {}));
  result.stdout = outputValue(result.stdout, options?.encoding === undefined ? "utf8" : options.encoding);
  result.stderr = outputValue(result.stderr, options?.encoding === undefined ? "utf8" : options.encoding);
  if (result.error || result.status !== 0) throw Object.assign(new Error("Command failed"), result.error || { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
  return result.stdout;
}

export function fork() { unsupported("fork"); }
