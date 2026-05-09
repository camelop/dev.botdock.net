// BotDock desktop wrapper — minimal Tauri 2.x shell.
//
// Lifecycle:
//   1. Resolve an app-managed data dir (e.g. ~/Library/Application Support/
//      BotDock on macOS) and ensure it exists.
//   2. Spawn the bundled `botdock` binary as a sidecar with
//        --home <data_dir> serve
//      and BOTDOCK_SIDECAR=1 so its in-app self-update path returns a
//      "managed by host" stub instead of trying to overwrite our app
//      bundle.
//   3. Forward sidecar stdout/stderr to the host process — useful in
//      `tauri dev`, harmless in release.
//   4. Block setup until the daemon's HTTP port is reachable (or the
//      timeout elapses), then open a window pointed at it.
//
// Everything else (sessions, terminals, transcript) is the same web app
// the CLI's `botdock serve` already exposes.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const DAEMON_HOST: &str = "127.0.0.1";
const DAEMON_PORT: u16 = 4717;
const DAEMON_URL: &str = "http://127.0.0.1:4717/";
const READY_TIMEOUT_SECS: u64 = 30;
const READY_POLL_MS: u64 = 200;
const READY_PROBE_MS: u64 = 400;

fn daemon_listening() -> bool {
    let addr_str = format!("{}:{}", DAEMON_HOST, DAEMON_PORT);
    match addr_str.parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(READY_PROBE_MS)).is_ok(),
        Err(_) => false,
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Resolve + create data dir. We deliberately scope ours to a
            // BotDock subdir of the app's data dir so it lines up with the
            // CLI's "data dir is one folder" mental model and stays
            // discoverable from Finder / Files.
            let data_dir = handle
                .path()
                .app_data_dir()
                .expect("could not resolve app_data_dir");
            std::fs::create_dir_all(&data_dir).ok();
            let data_dir_str = data_dir.to_string_lossy().to_string();

            // Spawn the bundled CLI binary as a sidecar.
            let (mut rx, _child) = handle
                .shell()
                .sidecar("botdock")
                .map_err(|e| format!("could not resolve botdock sidecar: {e}"))?
                .args(["--home", data_dir_str.as_str(), "serve"])
                .env("BOTDOCK_SIDECAR", "1")
                .spawn()
                .map_err(|e| format!("could not spawn botdock sidecar: {e}"))?;

            // Forward sidecar logs to host stderr so `tauri dev` shows
            // them inline. In a production bundle these still flow to the
            // launcher's stderr, which is fine for now.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            let s = String::from_utf8_lossy(&line);
                            eprintln!("[botdock] {}", s.trim_end());
                        }
                        _ => {}
                    }
                }
            });

            // Block until the daemon is reachable. Keeps window creation
            // deterministic — by the time we open a window pointed at the
            // daemon URL, it can actually load.
            let deadline = Instant::now() + Duration::from_secs(READY_TIMEOUT_SECS);
            while Instant::now() < deadline {
                if daemon_listening() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(READY_POLL_MS));
            }

            WebviewWindowBuilder::new(
                &handle,
                "main",
                WebviewUrl::External(
                    DAEMON_URL.parse().expect("DAEMON_URL is a literal — must parse"),
                ),
            )
            .title("BotDock")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
