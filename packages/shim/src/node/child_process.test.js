import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "./child_process.js";

describe("child_process transport contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__currentVaultId;
    delete globalThis.XMLHttpRequest;
  });

  it("normalizes the spawn options-only overload", async () => {
    globalThis.__currentVaultId = "vault";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ id: "process-1", pid: 123 }),
    });

    spawn("git", { cwd: "subdir", env: { GIT_TERMINAL_PROMPT: "0" } });
    await new Promise((resolve) => queueMicrotask(resolve));

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.args).toEqual([]);
    expect(request.options.cwd).toBe("subdir");
    expect(request.options.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("returns requested sync string encoding and transports input", () => {
    globalThis.__currentVaultId = "vault";
    class FakeXHR {
      static last;
      status = 200;
      responseText = JSON.stringify({ status: 0, signal: null, stdout: "b3V0Cg==", stderr: "" });
      constructor() { FakeXHR.last = this; }
      open() {}
      setRequestHeader() {}
      send(body) { this.body = JSON.parse(body); }
    }
    globalThis.XMLHttpRequest = FakeXHR;

    const result = spawnSync("git", { encoding: "utf8", input: "in\n" });
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("");
    expect(FakeXHR.last.body.options.input).toBe("aW4K");
  });
});
