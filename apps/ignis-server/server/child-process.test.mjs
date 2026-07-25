import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import http from "node:http";

const require = createRequire(import.meta.url);
const { makeRouter } = require("./child-process.js");

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
});
