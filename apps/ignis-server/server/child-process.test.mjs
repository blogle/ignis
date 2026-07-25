import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import http from "node:http";

const require = createRequire(import.meta.url);
const { makeRouter, bufferEvent } = require("./child-process.js");

describe("child process route", () => {
  it("is disabled by default", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/child-process", makeRouter());
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/child-process/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "git", args: [], vault: "missing" }),
    });
    expect(response.status).toBe(403);
    await new Promise((resolve) => server.close(resolve));
  });

  it("retains lifecycle and error events when data fills the replay buffer", () => {
    const record = { id: "process-1", events: [], eventBytes: 0 };
    bufferEvent(record, { type: "spawn", pid: 1 });
    for (let i = 0; i < 200; i++) {
      bufferEvent(record, { type: "data", stream: "stdout", data: "x".repeat(8192) });
    }
    bufferEvent(record, { type: "error", error: { message: "failed" } });
    bufferEvent(record, { type: "exit", code: 1, signal: null });
    bufferEvent(record, { type: "close", code: 1, signal: null });

    const types = record.events.map((event) => event.type);
    expect(types).toContain("spawn");
    expect(types).toContain("error");
    expect(types).toContain("exit");
    expect(types).toContain("close");
    expect(record.eventBytes).toBeLessThanOrEqual(1024 * 1024);
  });
});
