import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import WebSocket from "ws";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-child-process-"));
const vault = path.join(root, "fixture");
const remote = path.join(root, "remote.git");
await fs.mkdir(vault, { recursive: true });
process.env.VAULT_ROOT = root;
process.env.DATA_ROOT = path.join(root, "data");
process.env.IGNIS_CHILD_PROCESS = "enabled";

const { setupWebSocket } = await import("../packages/server-core/src/index.js");
const { makeRouter, wireWebSocket } = await import("../apps/ignis-server/server/child-process.js");
const app = express();
app.use(express.json());
app.use("/api/child-process", makeRouter());
const server = http.createServer(app);
const wss = setupWebSocket(server, { getVaultPath: (id) => id === "fixture" ? vault : null });
const runtime = wireWebSocket(wss);

await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();
const session = "fixture-session-0123456789";
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?vault=fixture`);
const messages = [];
ws.on("message", (data) => messages.push(JSON.parse(data)));
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
ws.send(JSON.stringify({ channel: "child-process", type: "subscribe-channel", channel: "child-process" }));
ws.send(JSON.stringify({ channel: "child-process", type: "attach", session }));

const run = async (args, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/child-process/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault: "fixture", session, command: "git", args, options }),
  });
  const result = await response.json();
  if (!response.ok || result.status !== 0) throw new Error(`git command failed: ${JSON.stringify(result)}`);
  return Buffer.from(result.stdout, "base64").toString();
};

const response = await fetch(`http://127.0.0.1:${port}/api/child-process/sync`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ vault: "fixture", session, command: "git", args: ["--version"], options: {} }),
});
const result = await response.json();
if (!response.ok || result.status !== 0 || !Buffer.from(result.stdout, "base64").toString().startsWith("git version")) {
  throw new Error(`git compatibility fixture failed: ${JSON.stringify(result)}`);
}

await run(["init", "--bare", remote], { cwd: "." });
await run(["init"], { cwd: "." });
await run(["config", "user.email", "fixture@example.com"], { cwd: "." });
await run(["config", "user.name", "Fixture"], { cwd: "." });
await run(["branch", "-M", "main"], { cwd: "." });
await fs.writeFile(path.join(vault, "README.md"), "first\n");
await run(["add", "README.md"], { cwd: "." });
await run(["commit", "-m", "first"], { cwd: "." });
await run(["remote", "add", "origin", remote], { cwd: "." });
await run(["push", "-u", "origin", "main"], { cwd: "." });
await run(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: "." });
await run(["clone", remote, "clone"], { cwd: "." });
await fs.writeFile(path.join(vault, "README.md"), "second\n");
await run(["add", "README.md"], { cwd: "." });
await run(["commit", "-m", "second"], { cwd: "." });
await run(["push"], { cwd: "." });
await run(["pull", "--ff-only"], { cwd: "clone" });
if ((await fs.readFile(path.join(vault, "clone", "README.md"), "utf8")) !== "second\n") {
  throw new Error("git pull fixture did not update the clone");
}

const asyncResponse = await fetch(`http://127.0.0.1:${port}/api/child-process/spawn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ vault: "fixture", session, command: "git", args: ["--version"], options: {} }),
});
if (!asyncResponse.ok) throw new Error(`async fixture failed: ${await asyncResponse.text()}`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for WS output: ${JSON.stringify(messages)}`)), 5000);
  const check = () => {
    if (messages.some((message) => message.type === "data")) { clearTimeout(timer); resolve(); }
    else setTimeout(check, 10);
  };
  check();
});

const isolationResponse = await fetch(`http://127.0.0.1:${port}/api/child-process/spawn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ vault: "fixture", session, command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], options: {} }),
});
const isolationProcess = await isolationResponse.json();
const otherWs = new WebSocket(`ws://127.0.0.1:${port}/ws?vault=fixture`);
await new Promise((resolve, reject) => { otherWs.once("open", resolve); otherWs.once("error", reject); });
const otherSession = "other-session-0123456789";
otherWs.send(JSON.stringify({ type: "subscribe-channel", channel: "child-process" }));
otherWs.send(JSON.stringify({ channel: "child-process", type: "attach", session: otherSession }));
otherWs.send(JSON.stringify({ channel: "child-process", type: "kill", session: otherSession, processId: isolationProcess.id, signal: "SIGTERM" }));
await new Promise((resolve) => setTimeout(resolve, 100));
if (messages.some((message) => message.processId === isolationProcess.id && message.type === "close")) {
  throw new Error("a different child-process session controlled the process");
}
ws.send(JSON.stringify({ channel: "child-process", type: "kill", session, processId: isolationProcess.id, signal: "SIGTERM" }));
otherWs.close();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for isolated process cleanup")), 5000);
  const check = () => {
    if (messages.some((message) => message.processId === isolationProcess.id && message.type === "close")) { clearTimeout(timer); resolve(); }
    else setTimeout(check, 10);
  };
  check();
});

const limited = [];
for (let i = 0; i < 4; i++) {
  const limitedResponse = await fetch(`http://127.0.0.1:${port}/api/child-process/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault: "fixture", session, command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], options: {} }),
  });
  if (!limitedResponse.ok) throw new Error(`concurrency fixture setup failed: ${await limitedResponse.text()}`);
  limited.push((await limitedResponse.json()).id);
}
const overLimit = await fetch(`http://127.0.0.1:${port}/api/child-process/spawn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ vault: "fixture", session, command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], options: {} }),
});
if (overLimit.status !== 429) throw new Error(`concurrency limit fixture expected 429, got ${overLimit.status}`);
for (const processId of limited) ws.send(JSON.stringify({ channel: "child-process", type: "kill", session, processId, signal: "SIGTERM" }));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for concurrency cleanup")), 5000);
  const check = () => {
    if (limited.every((processId) => messages.some((message) => message.processId === processId && message.type === "close"))) { clearTimeout(timer); resolve(); }
    else setTimeout(check, 10);
  };
  check();
});

const streamResponse = await fetch(`http://127.0.0.1:${port}/api/child-process/spawn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    vault: "fixture",
    session,
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', d => process.stdout.write(process.cwd() + '|' + process.env.IGNIS_FIXTURE + '|' + d))"],
    options: { cwd: ".", env: { IGNIS_FIXTURE: "ok" } },
  }),
});
const streamProcess = await streamResponse.json();
if (!streamResponse.ok) throw new Error(`stream fixture failed: ${JSON.stringify(streamProcess)}`);
ws.send(JSON.stringify({ channel: "child-process", type: "stdin", session, processId: streamProcess.id, data: Buffer.from("input\n").toString("base64") }));
ws.send(JSON.stringify({ channel: "child-process", type: "end", session, processId: streamProcess.id }));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for stdin fixture")), 5000);
  const check = () => {
    if (messages.some((message) => message.processId === streamProcess.id && message.type === "data" && Buffer.from(message.data, "base64").toString().includes("|ok|input"))) { clearTimeout(timer); resolve(); }
    else setTimeout(check, 10);
  };
  check();
});

const killResponse = await fetch(`http://127.0.0.1:${port}/api/child-process/spawn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ vault: "fixture", session, command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], options: {} }),
});
const killProcess = await killResponse.json();
ws.send(JSON.stringify({ channel: "child-process", type: "kill", session, processId: killProcess.id, signal: "SIGTERM" }));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for kill fixture")), 5000);
  const check = () => {
    if (messages.some((message) => message.processId === killProcess.id && message.type === "close")) { clearTimeout(timer); resolve(); }
    else setTimeout(check, 10);
  };
  check();
});

runtime.close();
ws.close();
await new Promise((resolve) => server.close(resolve));
await fs.rm(root, { recursive: true, force: true });
console.log("child-process HTTP/WS Git fixture passed");
