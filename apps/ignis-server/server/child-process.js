const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const childProcess = require("child_process");
const config = require("./config");
const { resolveVaultPath, sanitizeError } = require("@ignis/server-core");

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;
const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"];
const processes = new Map();
const sockets = new Map();

function error(message, code = "ERR_CHILD_PROCESS") {
  const e = new Error(message);
  e.code = code;
  return e;
}

function enabled() {
  return config.childProcessEnabled && !config.demoMode;
}

function guard(_req, res) {
  if (!enabled()) {
    res.status(403).json({
      error: config.demoMode
        ? "child_process is disabled in demo mode"
        : "child_process compatibility is disabled",
      code: "ERR_CHILD_PROCESS_DISABLED",
    });
    return false;
  }

  return true;
}

function getVault(req) {
  const vaultId = req.body?.vault || req.query.vault;
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultId || !vaultPath) {
    throw error("Vault not found", "ENOENT");
  }

  return { vaultId, vaultPath };
}

function getCwd(root, cwd) {
  const resolved = resolveVaultPath(root, cwd ?? "");

  if (!resolved) {
    throw error("cwd must remain inside the vault", "EINVAL");
  }

  const stat = fs.statSync(resolved);

  if (!stat.isDirectory()) {
    throw error("cwd is not a directory", "ENOTDIR");
  }

  return resolved;
}

function commandArgs(body) {
  if (typeof body.command !== "string" || !body.command) {
    throw error("Missing command", "EINVAL");
  }

  if (!Array.isArray(body.args) || body.args.some((arg) => typeof arg !== "string")) {
    throw error("args must be an array of strings", "EINVAL");
  }

  const commandSize = Buffer.byteLength(body.command) + body.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0);
  if (commandSize > MAX_COMMAND_BYTES) throw error("command and args are too large", "E2BIG");

  return { command: body.command, args: body.args };
}

function validateSession(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 128) {
    throw error("Invalid child_process session", "EINVAL");
  }
}

function makeOptions(root, body) {
  if (body.options === undefined) body.options = {};
  if (typeof body.options !== "object" || Array.isArray(body.options)) {
    throw error("options must be an object", "EINVAL");
  }
  const cwd = getCwd(root, body.options?.cwd);
  const requested = body.options?.env;
  const env = {};

  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  if (requested !== undefined) {
    if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
      throw error("env must be an object", "EINVAL");
    }

    for (const [key, value] of Object.entries(requested)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Buffer.byteLength(key) > 128) {
        throw error("invalid environment variable name", "EINVAL");
      }
      if (typeof value !== "string") throw error("env values must be strings", "EINVAL");
      if (Buffer.byteLength(value) > 64 * 1024) throw error("environment value is too large", "E2BIG");
      env[key] = value;
    }
  }

  const options = body.options || {};
  const timeout = Number.isFinite(options.timeout) ? Math.max(0, options.timeout) : 0;
  if (timeout > config.childProcessMaxTimeoutMs) throw error("timeout exceeds the server limit", "EINVAL");
  return {
    cwd,
    env,
    shell: !!options.shell,
    windowsHide: true,
    timeout,
    maxBuffer: Math.min(
      MAX_OUTPUT_BYTES,
      Number.isFinite(options.maxBuffer) ? Math.max(1, options.maxBuffer) : MAX_OUTPUT_BYTES,
    ),
  };
}

function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function emit(record, message) {
  const payload = { channel: "child-process", ...message, processId: record.id };
  const encoded = JSON.stringify(payload);

  if (encoded.length <= MAX_OUTPUT_BYTES) {
    record.events.push(payload);
    record.eventBytes = (record.eventBytes || 0) + encoded.length;
    while (record.eventBytes > MAX_OUTPUT_BYTES && record.events.length) {
      record.eventBytes -= JSON.stringify(record.events.shift()).length;
    }
  }

  for (const socket of sockets.get(record.session) || []) {
    if (socket.vaultId === record.vaultId) send(socket, payload);
  }
}

function attach(msg, socket) {
  if (!enabled() || typeof msg.session !== "string") return;
  if (socket.childProcessSession && socket.childProcessSession !== msg.session) disconnect(socket);
  socket.childProcessSession = msg.session;
  if (!sockets.has(msg.session)) sockets.set(msg.session, new Set());
  sockets.get(msg.session).add(socket);
  if (!socket.childProcessCloseBound) {
    socket.childProcessCloseBound = true;
    socket.once("close", () => disconnect(socket));
  }

  for (const record of processes.values()) {
    if (record.session === msg.session && record.vaultId === socket.vaultId) {
      for (const event of record.events) send(socket, event);
    }
  }
}

function finish(record, code, signal) {
  if (record.finished) return;
  record.finished = true;
  record.child = null;
  emit(record, { type: "exit", code, signal });
  emit(record, { type: "close", code, signal });
  setTimeout(() => processes.delete(record.id), 5 * 1000).unref?.();
}

function kill(record, signal = "SIGTERM") {
  if (!record.child) return;
  if (signal !== undefined && !["SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT", "SIGHUP"].includes(signal)) return;
  record.child.kill(signal);
  // A child that ignores SIGTERM must not remain attached indefinitely.
  setTimeout(() => record.child?.kill("SIGKILL"), 2000).unref?.();
}

function start(body, mode) {
  validateSession(body.session);
  const { vaultId, vaultPath } = getVault({ body });
  const { command, args } = commandArgs(body);
  const options = makeOptions(vaultPath, body);

  if (mode === "sync") {
    const result = childProcess.spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      windowsHide: true,
      timeout: options.timeout || undefined,
      maxBuffer: options.maxBuffer,
      encoding: "buffer",
      input: typeof body.options?.input === "string"
        ? Buffer.from(body.options.input, body.options.inputEncoding || "utf8")
        : body.options?.input ? Buffer.from(body.options.input, "base64") : undefined,
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error ? sanitizeError(result.error) : null,
      stdout: result.stdout?.toString("base64") || "",
      stderr: result.stderr?.toString("base64") || "",
    };
  }

  const id = crypto.randomUUID();
  const session = body.session;

  const active = [...processes.values()].filter((record) => !record.finished);
  const sessionActive = active.filter((record) => record.session === session && record.vaultId === vaultId);
  if (active.length >= config.childProcessMaxProcesses) throw error("child process limit reached", "EAGAIN");
  if (sessionActive.length >= config.childProcessMaxProcessesPerSession) throw error("child process session limit reached", "EAGAIN");

  const record = { id, session, vaultId, child: null, events: [], eventBytes: 0, outputBytes: 0, finished: false };
  processes.set(id, record);
  let child;
  try {
    child = childProcess.spawn(command, args, options);
  } catch (e) {
    processes.delete(id);
    throw e;
  }
  record.child = child;
  emit(record, { type: "spawn", pid: child.pid });

  const onData = (stream, data) => {
    record.outputBytes += data.length;
    if (record.outputBytes > options.maxBuffer) {
      emit(record, { type: "error", error: { message: "maxBuffer exceeded", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } });
      kill(record);
      return;
    }
    emit(record, { type: "data", stream, data: data.toString("base64") });
  };
  child.stdout?.on("data", (data) => onData("stdout", data));
  child.stderr?.on("data", (data) => onData("stderr", data));
  child.on("error", (e) => emit(record, { type: "error", error: sanitizeError(e) }));
  child.on("close", (code, signal) => finish(record, code, signal));
  if (options.timeout) setTimeout(() => kill(record), options.timeout).unref?.();

  return { id, pid: child.pid };
}

function makeRouter() {
  const router = express.Router();
  router.use((req, res, next) => (guard(req, res) ? next() : undefined));
  router.post("/spawn", (req, res) => {
    try {
      res.json(start(req.body, "async"));
    } catch (e) {
      res.status(e.code === "ENOENT" ? 404 : e.code === "EAGAIN" ? 429 : 400).json(sanitizeError(e));
    }
  });
  router.post("/sync", (req, res) => {
    try {
      res.json(start(req.body, "sync"));
    } catch (e) {
      res.status(e.code === "ENOENT" ? 404 : e.code === "EAGAIN" ? 429 : 400).json(sanitizeError(e));
    }
  });
  return router;
}

function wireWebSocket(wss) {
  const channel = wss.channel("child-process");
  channel.on("attach", attach);
  channel.on("stdin", (msg, socket) => {
    const record = processes.get(msg.processId);
    if (!record || record.session !== socket.childProcessSession || record.vaultId !== socket.vaultId) return;
    if (typeof msg.data !== "string") return;
    record.child?.stdin?.write(Buffer.from(msg.data, "base64"));
  });
  channel.on("end", (msg, socket) => {
    const record = processes.get(msg.processId);
    if (record?.session === socket.childProcessSession && record.vaultId === socket.vaultId) record.child?.stdin?.end();
  });
  channel.on("kill", (msg, socket) => {
    const record = processes.get(msg.processId);
    if (record?.session === socket.childProcessSession && record.vaultId === socket.vaultId) kill(record, msg.signal);
  });
  return { close: () => { for (const record of processes.values()) record.child?.kill(); processes.clear(); } };
}

function disconnect(socket) {
  const session = socket.childProcessSession;
  if (!session) return;
  sockets.get(session)?.delete(socket);
  const sessionSockets = sockets.get(session);
  if (sessionSockets?.size && [...sessionSockets].some((candidate) => candidate.vaultId === socket.vaultId)) return;
  if (sessionSockets?.size === 0) sockets.delete(session);
  for (const record of processes.values()) {
    if (record.session === session && record.vaultId === socket.vaultId) kill(record);
  }
}

module.exports = { makeRouter, wireWebSocket, disconnect, enabled };
