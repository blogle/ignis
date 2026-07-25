# Child Process Compatibility

The compatibility layer is opt-in with `IGNIS_CHILD_PROCESS=enabled`. It is disabled by default and cannot be enabled in `DEMO_MODE=true`.

The supported surface is:

- Async `spawn(command, args, options)`, `exec(command, options, callback)`, and `execFile(file, args, options, callback)`.
- Sync `spawnSync`, `execSync`, and `execFileSync`.
- `ChildProcess` lifecycle events (`spawn`, `error`, `exit`, `close`), `pid`, `stdin`, `stdout`, `stderr`, `kill`, `killed`, `exitCode`, and `signalCode`.
- `cwd`, explicit `env`, `shell`, `timeout`, and `maxBuffer` (bounded to 1 MiB).

The default working directory is the active vault root. A relative `cwd` is vault-relative; absolute paths and traversal outside the vault are rejected. `spawnSync` defaults to Buffer output; `exec` and `execFile` default to UTF-8 strings, while `encoding: "buffer"` returns bytes. `options.input` is supported for sync calls. Only a safe baseline environment is inherited. Plugin-provided environment keys are merged explicitly and are never logged.

The server trusts the caller. A process can execute with the container/server user's privileges, read mounted files, change the vault, and access the network. Put the server behind authentication and do not enable this for untrusted plugins. The process id sent to the browser is opaque and is valid only for the matching vault and browser session. Disconnecting the session kills its children; server shutdown does the same.

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
