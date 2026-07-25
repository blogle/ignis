# Child Process Compatibility

The compatibility layer is opt-in with `IGNIS_CHILD_PROCESS=enabled`. It is disabled by default and cannot be enabled in `DEMO_MODE=true`.

The supported surface is:

- Async `spawn(command, args, options)`, `exec(command, options, callback)`, and `execFile(file, args, options, callback)`.
- Sync `spawnSync`, `execSync`, and `execFileSync`.
- `ChildProcess` lifecycle events (`spawn`, `error`, `exit`, `close`), `pid`, `stdin`, `stdout`, `stderr`, `kill`, `killed`, `exitCode`, and `signalCode`.
- `cwd`, explicit `env`, `shell`, `timeout`, and `maxBuffer` (bounded to 1 MiB).

The default working directory is the active vault root. A relative `cwd` is vault-relative; absolute paths and traversal outside the vault are rejected. `spawnSync` defaults to Buffer output; `exec` and `execFile` default to UTF-8 strings, while `encoding: "buffer"` returns bytes. `options.input` is supported for sync calls. Only a safe baseline environment is inherited. Plugin-provided environment keys are merged explicitly and are never logged.

The server trusts the caller. A process can execute with the container/server user's privileges, read mounted files, change the vault, and access the network. Put the server behind authentication and do not enable this for untrusted plugins. The process id sent to the browser is opaque and is valid only for the matching vault and browser session. Disconnecting the session kills its children; server shutdown does the same.

## Browser sessions and packaging

Each browser tab has its own opaque child-process session. Tabs may use the same
vault, but they cannot attach to, control, or receive replayed events for one
another's processes. A reconnect reattaches the tab's session and replays the
bounded event history; closing the last socket for that tab/session terminates
its children. This is generic session isolation, not a security boundary for
plugins running on a trusted server.

The production Docker image does not package Git by default. To build the
optional executable-compatible image for trusted Git/child-process use, pass
`--build-arg IGNIS_INCLUDE_GIT=true` to `docker build` (or the equivalent
`buildx` command). The child-process feature remains disabled unless
`IGNIS_CHILD_PROCESS=enabled` is set, and it remains unavailable in demo mode.

## Obsidian Git investigation

The investigation is pinned to Obsidian Git `2.38.6`, commit
`963aba8d33529abfc2fb14d22d865c493f626a2f`. Its `src/utils.ts`
imports `spawn` and implements `spawnAsync`; `src/gitManager/simpleGit.ts`
selects the desktop `simple-git` backend and probes `git --version`. The desktop
manager uses Git for status, stage/unstage, commit, pull, push, clone, checkout,
and custom commit-message scripts. Its mobile/web path uses isomorphic-git and
does not require a native process.

This layer now covers the desktop manager's basic command transport, including `git` invocation and shell-backed commit-message scripts. Remaining blockers are not child-process calls: complete Node stream behavior, native socket/addon dependencies, platform-specific executable discovery (`PROGRAMFILES`/`sh.exe`), detached process/IPC behavior, and full Node error/encoding parity. The plugin's UI and filesystem adapter also need a real Obsidian integration smoke test before claiming desktop-plugin compatibility.

Run the automated transport and bare-remote Git fixture with
`npm run test:child-process`. A pinned plugin UI smoke was not executed because
this repository has no browser automation fixture; that is the exact remaining
acceptance blocker for claiming end-user Obsidian Git compatibility.
