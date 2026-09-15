#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use zeroize::Zeroize;

const AGENTD_PROTOCOL_VERSION: u64 = 1;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAIN_WINDOW_LABEL: &str = "main";
const AGENTD_RESOURCE: &str = "sidecar/agentd/index.js";
const AGENTD_BINARY: &str = "agentd-runtime";
const HEALTH_REQUEST_ID: &str = "host-health";
const SHUTDOWN_REQUEST_ID: &str = "host-shutdown";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const KEYCHAIN_SERVICE: &str = "com.aica.tauri-pilot";

const CREDENTIAL_KEYS: &[&str] = &[
    "openai_api_key",
    "gemini_api_key",
    "openrouter_api_key",
    "email_mcp_password",
    "email_imap_password",
    "email_smtp_password",
    "gmail_oauth_client_id",
    "whatsapp_cloud_access_token",
    "whatsapp_cloud_app_secret",
    "whatsapp_cloud_verify_token",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHealth {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl NativeHealth {
    fn ready() -> Self {
        Self {
            status: "ready".into(),
            version: Some(format!("agentd protocol v{AGENTD_PROTOCOL_VERSION}")),
            error: None,
        }
    }

    fn unavailable(error: impl Into<String>) -> Self {
        Self {
            status: "unavailable".into(),
            version: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl NativeResult {
    fn success() -> Self {
        Self {
            success: true,
            error: None,
        }
    }

    fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialExistsResult {
    success: bool,
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
struct ProcessState {
    child: Option<CommandChild>,
    health: Option<NativeHealth>,
    protocol: ProtocolHandshake,
    terminated: bool,
}

#[derive(Default)]
struct ProtocolHandshake {
    ready_identity: Option<AgentdHealth>,
    health_request_pending: bool,
    healthy: bool,
    shutdown_request_pending: bool,
}

impl ProtocolHandshake {
    fn accept_ready(&mut self, identity: AgentdHealth) -> Result<(), ()> {
        if self.ready_identity.is_some() {
            return Err(());
        }
        self.ready_identity = Some(identity);
        Ok(())
    }

    fn request_health(&mut self) -> Result<(), ()> {
        if self.ready_identity.is_none() || self.health_request_pending || self.healthy {
            return Err(());
        }
        self.health_request_pending = true;
        Ok(())
    }

    fn accept_health(&mut self, identity: &AgentdHealth) -> Result<(), ()> {
        if !self.health_request_pending || self.ready_identity.as_ref() != Some(identity) {
            return Err(());
        }
        self.health_request_pending = false;
        self.healthy = true;
        Ok(())
    }

    fn request_shutdown(&mut self) -> Result<(), ()> {
        if self.shutdown_request_pending {
            return Err(());
        }
        self.shutdown_request_pending = true;
        Ok(())
    }

    fn accept_shutdown(&mut self) -> Result<(), ()> {
        if !self.shutdown_request_pending {
            return Err(());
        }
        self.shutdown_request_pending = false;
        Ok(())
    }
}

#[derive(Default)]
struct AgentdRuntime {
    process: Mutex<ProcessState>,
    stopped: Condvar,
}

impl AgentdRuntime {
    fn health(&self) -> NativeHealth {
        self.process
            .lock()
            .map(|process| {
                process
                    .health
                    .clone()
                    .unwrap_or_else(|| NativeHealth::unavailable("Agentd is starting"))
            })
            .unwrap_or_else(|_| NativeHealth::unavailable("Agentd state unavailable"))
    }

    fn set_child(&self, child: CommandChild) {
        if let Ok(mut process) = self.process.lock() {
            process.child = Some(child);
        }
    }

    fn request_health(&self) -> Result<(), ()> {
        let mut process = self.process.lock().map_err(|_| ())?;
        if process.terminated || process.child.is_none() {
            return Err(());
        }
        process.protocol.request_health()?;
        let child = process.child.as_mut().ok_or(())?;
        child
            .write(
                format!(
                    "{{\"version\":{AGENTD_PROTOCOL_VERSION},\"kind\":\"request\",\"id\":\"{HEALTH_REQUEST_ID}\",\"method\":\"health.get\"}}\n"
                )
                .as_bytes(),
            )
            .map_err(|_| ())
    }

    fn accept_ready(&self, health: AgentdHealth) -> Result<(), ()> {
        let mut process = self.process.lock().map_err(|_| ())?;
        if process.terminated || process.child.is_none() {
            return Err(());
        }
        process.protocol.accept_ready(health)
    }

    fn accept_health_response(&self, identity: AgentdHealth) -> Result<NativeHealth, ()> {
        let mut process = self.process.lock().map_err(|_| ())?;
        if process.terminated {
            return Err(());
        }
        process.protocol.accept_health(&identity)?;
        let health = NativeHealth::ready();
        process.health = Some(health.clone());
        Ok(health)
    }

    fn request_shutdown(&self) -> bool {
        let Ok(mut process) = self.process.lock() else {
            return false;
        };
        if process.terminated || process.protocol.shutdown_request_pending {
            return process.terminated;
        }
        if process.child.is_none() {
            return true;
        }
        if process.protocol.request_shutdown().is_err() {
            return false;
        }
        process
            .child
            .as_mut()
            .map(|child| {
                child.write(
                format!(
                    "{{\"version\":{AGENTD_PROTOCOL_VERSION},\"kind\":\"request\",\"id\":\"{SHUTDOWN_REQUEST_ID}\",\"method\":\"shutdown\"}}\n"
                )
                .as_bytes(),
                )
                .is_ok()
            })
            .unwrap_or(false)
    }

    fn wait_then_kill(&self, grace: Duration) {
        let deadline = Instant::now() + grace;
        let Ok(mut process) = self.process.lock() else {
            return;
        };
        while !process.terminated && process.child.is_some() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let Ok((next, timed_out)) = self.stopped.wait_timeout(process, remaining) else {
                return;
            };
            process = next;
            if timed_out.timed_out() {
                break;
            }
        }
        if !process.terminated {
            if let Some(child) = process.child.take() {
                drop(process);
                let _ = child.kill();
            }
        }
    }

    fn mark_unavailable(&self, message: &str, kill_child: bool) -> NativeHealth {
        let health = NativeHealth::unavailable(message);
        if let Ok(mut process) = self.process.lock() {
            process.health = Some(health.clone());
            if kill_child {
                if let Some(child) = process.child.take() {
                    drop(process);
                    let _ = child.kill();
                    return health;
                }
            }
        }
        health
    }

    fn mark_terminated(&self) -> NativeHealth {
        let health = NativeHealth::unavailable("Agentd stopped");
        if let Ok(mut process) = self.process.lock() {
            process.child = None;
            process.terminated = true;
            process.health = Some(health.clone());
        }
        self.stopped.notify_all();
        health
    }

    fn kill_now(&self) {
        let child = self
            .process
            .lock()
            .ok()
            .and_then(|mut process| process.child.take());
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
struct FrameDecoder {
    current: Vec<u8>,
    dropping_oversized: bool,
}

impl FrameDecoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<Result<Vec<u8>, ()>> {
        let mut frames = Vec::new();
        for byte in bytes {
            match byte {
                b'\n' => {
                    if !self.dropping_oversized {
                        if self.current.last() == Some(&b'\r') {
                            self.current.pop();
                        }
                        frames.push(Ok(std::mem::take(&mut self.current)));
                    }
                    self.current.clear();
                    self.dropping_oversized = false;
                }
                _ if self.dropping_oversized => {}
                _ if self.current.len() == MAX_FRAME_BYTES => {
                    self.current.clear();
                    self.dropping_oversized = true;
                    frames.push(Err(()));
                }
                _ => self.current.push(*byte),
            }
        }
        frames
    }
}

#[derive(Clone, Debug, PartialEq)]
struct AgentdHealth {
    pid: u64,
    started_at: String,
}

#[derive(Debug, PartialEq)]
enum AgentdMessage {
    Ready(AgentdHealth),
    HealthResponse(AgentdHealth),
    ShutdownResponse,
}

fn parse_agentd_health(value: &Value) -> Result<AgentdHealth, ()> {
    if value.get("status").and_then(Value::as_str) != Some("ready")
        || value.get("protocolVersion").and_then(Value::as_u64) != Some(AGENTD_PROTOCOL_VERSION)
    {
        return Err(());
    }
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid > 0)
        .ok_or(())?;
    let started_at = value
        .get("startedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 64)
        .ok_or(())?;
    Ok(AgentdHealth {
        pid,
        started_at: started_at.to_owned(),
    })
}

fn parse_agentd_message(frame: &[u8]) -> Result<AgentdMessage, ()> {
    if frame.is_empty() || frame.len() > MAX_FRAME_BYTES {
        return Err(());
    }
    let text = std::str::from_utf8(frame).map_err(|_| ())?;
    let value: Value = serde_json::from_str(text).map_err(|_| ())?;
    if value.get("version").and_then(Value::as_u64) != Some(AGENTD_PROTOCOL_VERSION) {
        return Err(());
    }
    match value.get("kind").and_then(Value::as_str) {
        Some("event") if value.get("event").and_then(Value::as_str) == Some("ready") => Ok(
            AgentdMessage::Ready(parse_agentd_health(value.get("data").ok_or(())?)?),
        ),
        Some("response") if value.get("ok").and_then(Value::as_bool) == Some(true) => {
            match value.get("id").and_then(Value::as_str) {
                Some(HEALTH_REQUEST_ID) => Ok(AgentdMessage::HealthResponse(parse_agentd_health(
                    value.get("result").ok_or(())?,
                )?)),
                Some(SHUTDOWN_REQUEST_ID)
                    if value
                        .get("result")
                        .and_then(|result| result.get("status"))
                        .and_then(Value::as_str)
                        == Some("stopping") =>
                {
                    Ok(AgentdMessage::ShutdownResponse)
                }
                _ => Err(()),
            }
        }
        _ => Err(()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSelectionOptions {
    title: Option<String>,
    button_label: Option<String>,
    filters: Option<Vec<FileFilter>>,
}

#[derive(Deserialize)]
struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

fn has_unsupported_picker_options(options: &Option<FileSelectionOptions>) -> bool {
    options
        .as_ref()
        .and_then(|options| options.button_label.as_ref())
        .is_some_and(|label| !label.trim().is_empty())
}

fn credential_key_allowed(key: &str) -> bool {
    CREDENTIAL_KEYS.contains(&key)
}

fn credential_entry(key: &str) -> Result<Entry, ()> {
    if !credential_key_allowed(key) {
        return Err(());
    }
    Entry::new(KEYCHAIN_SERVICE, key).map_err(|_| ())
}

fn credential_is_present(entry: &Entry) -> Result<bool, ()> {
    match entry.get_password() {
        Ok(mut value) => {
            value.zeroize();
            Ok(true)
        }
        Err(KeyringError::NoEntry) => Ok(false),
        Err(KeyringError::BadEncoding(mut bytes)) => {
            bytes.zeroize();
            Ok(true)
        }
        Err(KeyringError::BadDataFormat(mut bytes, _)) => {
            bytes.zeroize();
            Ok(true)
        }
        Err(_) => Err(()),
    }
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn agentd_health(runtime: State<'_, Arc<AgentdRuntime>>) -> NativeHealth {
    runtime.health()
}

#[tauri::command]
async fn select_file(
    app: AppHandle,
    options: Option<FileSelectionOptions>,
) -> Result<Option<String>, String> {
    if has_unsupported_picker_options(&options) {
        return Err(
            "Custom file picker button labels are not supported by the Tauri native dialog".into(),
        );
    }
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let mut dialog = app.dialog().file();
    if let Some(options) = options {
        if let Some(title) = options.title.filter(|title| title.len() <= 120) {
            dialog = dialog.set_title(title);
        }
        for filter in options.filters.unwrap_or_default().into_iter().take(8) {
            if filter.name.len() > 80
                || filter.extensions.is_empty()
                || filter.extensions.len() > 16
            {
                continue;
            }
            let extensions: Vec<&str> = filter
                .extensions
                .iter()
                .filter(|ext| {
                    !ext.is_empty()
                        && ext.len() <= 16
                        && ext.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
                        })
                })
                .map(String::as_str)
                .collect();
            if !extensions.is_empty() {
                dialog = dialog.add_filter(filter.name, &extensions);
            }
        }
    }
    dialog.pick_file(move |selection| {
        let _ = sender.try_send(selection);
    });
    let selection = receiver
        .recv()
        .await
        .ok_or_else(|| "File picker unavailable".to_string())?;
    selection
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|_| "Invalid file selection".to_string())
        })
        .transpose()
}

#[tauri::command]
async fn select_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |selection| {
        let _ = sender.try_send(selection);
    });
    let selection = receiver
        .recv()
        .await
        .ok_or_else(|| "Folder picker unavailable".to_string())?;
    selection
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|_| "Invalid folder selection".to_string())
        })
        .transpose()
}

#[tauri::command]
fn credential_set(key: String, mut value: String) -> NativeResult {
    if value.is_empty() {
        value.zeroize();
        return NativeResult::failure("Credential value cannot be empty");
    }
    let result =
        credential_entry(&key).and_then(|entry| entry.set_password(&value).map_err(|_| ()));
    value.zeroize();
    match result {
        Ok(()) => NativeResult::success(),
        Err(()) => NativeResult::failure("Credential store unavailable or key not allowed"),
    }
}

#[tauri::command]
fn credential_exists(key: String) -> CredentialExistsResult {
    let result = credential_entry(&key).and_then(|entry| credential_is_present(&entry));
    match result {
        Ok(exists) => CredentialExistsResult {
            success: true,
            exists,
            error: None,
        },
        _ => CredentialExistsResult {
            success: false,
            exists: false,
            error: Some("Credential store unavailable or key not allowed".into()),
        },
    }
}

#[tauri::command]
fn credential_delete(key: String) -> NativeResult {
    match credential_entry(&key).and_then(|entry| entry.delete_credential().map_err(|_| ())) {
        Ok(()) => NativeResult::success(),
        Err(()) => NativeResult::failure("Credential store unavailable or key not allowed"),
    }
}

fn resolve_agentd_entry<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resolve(AGENTD_RESOURCE, BaseDirectory::Resource)
        .map_err(|_| "Agentd resource unavailable".to_string())?;
    if packaged.is_file() {
        return Ok(packaged);
    }

    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(AGENTD_RESOURCE);
        if development.is_file() {
            return Ok(development);
        }
    }
    Err("Agentd resource unavailable".into())
}

fn spawn_agentd<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Pilot data directory unavailable".to_string())?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|_| "Pilot data directory unavailable".to_string())?;
    let entry = resolve_agentd_entry(app)?;

    let command = app
        .shell()
        .sidecar(AGENTD_BINARY)
        .map_err(|_| "Packaged agentd runtime unavailable".to_string())?
        .args([entry.as_os_str()])
        .env_clear()
        .env("AICA_TAURI_DATA_DIR", data_dir.as_os_str())
        .current_dir(&data_dir)
        .set_raw_out(true);
    #[cfg(windows)]
    let command = match std::env::var_os("SystemRoot") {
        Some(system_root) => command.env("SystemRoot", system_root),
        None => command,
    };
    command
        .spawn()
        .map_err(|_| "Packaged agentd runtime could not start".to_string())
}

fn consume_frame<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &AgentdRuntime,
    frame: Result<Vec<u8>, ()>,
) {
    let message = frame.and_then(|frame| parse_agentd_message(&frame));
    let result = match message {
        Ok(AgentdMessage::Ready(health)) => runtime
            .accept_ready(health)
            .and_then(|()| runtime.request_health()),
        Ok(AgentdMessage::HealthResponse(health)) => {
            runtime.accept_health_response(health).map(|health| {
                let _ = app.emit("agentd-health", health);
            })
        }
        Ok(AgentdMessage::ShutdownResponse) => runtime
            .process
            .lock()
            .map_err(|_| ())
            .and_then(|mut process| process.protocol.accept_shutdown()),
        Err(()) => Err(()),
    };
    if result.is_err() {
        let health = runtime.mark_unavailable("Invalid or unavailable agentd protocol", true);
        let _ = app.emit("agentd-health", health);
    }
}

async fn read_agentd<R: Runtime>(
    app: AppHandle<R>,
    runtime: Arc<AgentdRuntime>,
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
) {
    let mut decoder = FrameDecoder::default();
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                for frame in decoder.push(&bytes) {
                    consume_frame(&app, &runtime, frame);
                }
            }
            CommandEvent::Terminated(_) => {
                let health = runtime.mark_terminated();
                let _ = app.emit("agentd-health", health);
                return;
            }
            CommandEvent::Error(_) => {
                let health = runtime.mark_unavailable("Agentd pipe unavailable", true);
                let _ = app.emit("agentd-health", health);
            }
            CommandEvent::Stderr(_) => {} // Protocol and secrets never go to host logs.
            _ => {}
        }
    }
    let health = runtime.mark_terminated();
    let _ = app.emit("agentd-health", health);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenAction {
    FocusExisting,
    CreateWindow,
}

fn open_action(has_window: bool) -> OpenAction {
    if has_window {
        OpenAction::FocusExisting
    } else {
        OpenAction::CreateWindow
    }
}

fn should_prevent_windowless_exit(explicit_quit: bool) -> bool {
    !explicit_quit
}

fn open_main_window<R: Runtime>(app: &AppHandle<R>) {
    match open_action(app.get_webview_window(MAIN_WINDOW_LABEL).is_some()) {
        OpenAction::FocusExisting => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        OpenAction::CreateWindow => {
            let _ = WebviewWindowBuilder::new(
                app,
                MAIN_WINDOW_LABEL,
                WebviewUrl::App("tauri.html".into()),
            )
            .title("AICA Native Pilot")
            .inner_size(1000.0, 760.0)
            .min_inner_size(800.0, 600.0)
            .build();
        }
    }
}

fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let quitting = app.state::<Arc<AtomicBool>>().inner().clone();
    if quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let runtime = app.state::<Arc<AgentdRuntime>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let request_written = runtime.request_shutdown();
        if request_written {
            runtime.wait_then_kill(SHUTDOWN_GRACE);
        } else {
            runtime.kill_now();
        }
        app.exit(0);
    });
}

fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open AICA Native Pilot").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
    let icon = tauri::image::Image::new_owned(vec![46, 120, 220, 255].repeat(16 * 16), 16, 16);
    TrayIconBuilder::with_id("pilot-tray")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => open_main_window(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            agentd_health,
            select_file,
            select_folder,
            credential_set,
            credential_exists,
            credential_delete
        ])
        .setup(|app| {
            let runtime = Arc::new(AgentdRuntime::default());
            app.manage(runtime.clone());
            app.manage(Arc::new(AtomicBool::new(false)));
            create_tray(app.handle())?;
            match spawn_agentd(app.handle()) {
                Ok((receiver, child)) => {
                    runtime.set_child(child);
                    tauri::async_runtime::spawn(read_agentd(
                        app.handle().clone(),
                        runtime,
                        receiver,
                    ));
                }
                Err(_) => {
                    runtime.mark_unavailable("Agentd could not start", false);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.destroy();
                }
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building AICA Tauri pilot");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let explicit_quit = app.state::<Arc<AtomicBool>>().load(Ordering::SeqCst);
            if should_prevent_windowless_exit(explicit_quit) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            app.state::<Arc<AgentdRuntime>>().kill_now();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_message(kind: &str) -> String {
        format!(
            "{{\"version\":1,\"kind\":\"{kind}\",\"event\":\"ready\",\"data\":{{\"status\":\"ready\",\"protocolVersion\":1,\"pid\":42,\"startedAt\":\"2026-09-15T00:00:00.000Z\"}}}}"
        )
    }

    #[test]
    fn credential_allowlist_accepts_only_declared_keys() {
        assert!(credential_key_allowed("openai_api_key"));
        assert!(credential_key_allowed("whatsapp_cloud_verify_token"));
        assert!(!credential_key_allowed("unknown"));
        assert!(!credential_key_allowed(""));
    }

    #[test]
    fn custom_file_picker_button_labels_fail_explicitly() {
        let options = Some(FileSelectionOptions {
            title: None,
            button_label: Some("Upload".into()),
            filters: None,
        });
        assert!(has_unsupported_picker_options(&options));
        assert!(!has_unsupported_picker_options(&None));
        assert!(!has_unsupported_picker_options(&Some(
            FileSelectionOptions {
                title: None,
                button_label: Some("   ".into()),
                filters: None,
            }
        )));
    }

    #[test]
    fn decoder_preserves_frames_across_chunks_and_rejects_oversize() {
        let mut decoder = FrameDecoder::default();
        assert!(decoder.push(b"{\"kind\":").is_empty());
        assert_eq!(
            decoder.push(b"\"event\"}\n"),
            vec![Ok(b"{\"kind\":\"event\"}".to_vec())]
        );

        let mut too_large = vec![b'x'; MAX_FRAME_BYTES + 1];
        too_large.push(b'\n');
        assert_eq!(decoder.push(&too_large), vec![Err(())]);
        assert_eq!(decoder.push(b"{}\n"), vec![Ok(b"{}".to_vec())]);
    }

    #[test]
    fn ready_and_health_protocol_messages_are_validated() {
        let ready = parse_agentd_message(ready_message("event").as_bytes()).unwrap();
        assert!(matches!(
            ready,
            AgentdMessage::Ready(AgentdHealth { pid: 42, .. })
        ));

        let health = r#"{"version":1,"kind":"response","id":"host-health","ok":true,"result":{"status":"ready","protocolVersion":1,"pid":42,"startedAt":"2026-09-15T00:00:00.000Z"}}"#;
        assert!(matches!(
            parse_agentd_message(health.as_bytes()),
            Ok(AgentdMessage::HealthResponse(AgentdHealth { pid: 42, .. }))
        ));
        assert!(parse_agentd_message(ready_message("unknown").as_bytes()).is_err());
        assert!(parse_agentd_message(b"{\"version\":2}").is_err());
        assert!(parse_agentd_message(b"not-json").is_err());
    }

    #[test]
    fn handshake_requires_ready_request_and_matching_health_response() {
        let identity = AgentdHealth {
            pid: 42,
            started_at: "2026-09-15T00:00:00.000Z".into(),
        };
        let mut handshake = ProtocolHandshake::default();

        assert!(handshake.accept_health(&identity).is_err());
        handshake.accept_ready(identity.clone()).unwrap();
        assert!(handshake.accept_ready(identity.clone()).is_err());
        assert!(handshake.accept_health(&identity).is_err());
        handshake.request_health().unwrap();
        let mismatched = AgentdHealth {
            pid: 43,
            ..identity.clone()
        };
        assert!(handshake.accept_health(&mismatched).is_err());
        handshake.accept_health(&identity).unwrap();
        assert!(handshake.request_health().is_err());
        assert!(handshake.accept_health(&identity).is_err());

        assert!(handshake.accept_shutdown().is_err());
        handshake.request_shutdown().unwrap();
        handshake.accept_shutdown().unwrap();
    }

    #[test]
    fn tray_open_is_idempotent_and_close_only_exits_on_explicit_quit() {
        assert_eq!(open_action(true), OpenAction::FocusExisting);
        assert_eq!(open_action(false), OpenAction::CreateWindow);
        assert!(should_prevent_windowless_exit(false));
        assert!(!should_prevent_windowless_exit(true));
    }
}
