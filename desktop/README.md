# BotDock Desktop (Tauri)

A thin Tauri 2.x shell around the existing BotDock daemon binary. The
daemon is bundled as a sidecar (`externalBin`); on launch the shell
spawns it with `BOTDOCK_SIDECAR=1` against an app-managed data dir,
waits for its HTTP port to come up, then loads the same React UI the
CLI's `botdock serve` exposes.

The main repo's source is **not modified** by this folder — the daemon
behaves identically; the only sidecar-specific tweak is that
`BOTDOCK_SIDECAR=1` disables the in-app self-update flow (the host app
manages updates instead).

## Prerequisites

- Rust + Cargo (https://rustup.rs)
- Node.js (any recent LTS) for the Tauri CLI
- Bun (to build the CLI binary that gets bundled)
- macOS-only: Xcode command-line tools

```sh
cargo install tauri-cli --version "^2.0"
# OR use the npm shim:
npm install
```

## Dev (auto-reload)

From the repo root, build the CLI binaries first (the prepare script
copies the matching one into `src-tauri/binaries/` with the target-
triple naming Tauri expects):

```sh
# repo root
bun run build:all     # outputs dist-bin/botdock-{linux,darwin}-{x64,arm64}

# this folder
npm run dev
```

`npm run dev` runs `prepare-sidecar.sh` then `tauri dev`, which compiles
the Rust shell, copies the bundled daemon into the dev bundle, and
opens a window pointed at `http://127.0.0.1:4717`.

## Release build

```sh
# repo root
bun run build:all

# this folder
npm run build
```

Outputs land under `src-tauri/target/release/bundle/`:

- macOS: `BotDock.app` and `BotDock_<version>_<arch>.dmg`
- Linux: `BotDock_<version>_<arch>.AppImage` (and optionally .deb)
- Windows: `.msi` / `.exe` (currently unsupported — the CLI build
  pipeline doesn't ship a `botdock-windows-*` binary yet)

Tauri can't cross-compile macOS bundles from Linux. CI needs a
macos-latest runner for the .dmg side and an ubuntu-latest runner for
the .AppImage side; they upload to the same GitHub Release.

## What the wrapper actually does

`src-tauri/src/main.rs` is intentionally short:

1. Resolve the app data dir (e.g. `~/Library/Application Support/BotDock`
   on macOS) and create it if missing.
2. Spawn the bundled `botdock` binary as
   `botdock --home <data_dir> serve`, env `BOTDOCK_SIDECAR=1`.
3. Forward sidecar stdout/stderr to the host process for log capture.
4. Block until the daemon's HTTP port is reachable (or 30 s timeout).
5. Open a window pointed at `http://127.0.0.1:4717/`.

That's it — no IPC, no native menus beyond Tauri's defaults, no tray
icon. The web UI does everything the CLI version does.

## Code signing

This scaffold ships unsigned. macOS users will see "App is damaged or
can't be opened" on first launch; right-click → Open works around it,
or in Terminal:

```sh
xattr -d com.apple.quarantine /Applications/BotDock.app
```

Wire signing into CI when an Apple Developer ID / Windows EV cert is
available. The Tauri config has placeholders ready.
