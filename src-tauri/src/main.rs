#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agentd_api;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::process::Output;

use agentd_api::{
    AgentdClient, ChatHistoryCutover, ContinuityImport, ContinuityPreview, ContinuityRollback,
    CredentialContinuityPreview, CredentialExistsResult, NativeHealth, NativeResult,
    SettingsPersonaCutover,
};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(windows)]
const AGENTD_RUNTIME_RESOURCE: &str = "sidecar/agentd-runtime.exe";
#[cfg(not(windows))]
const AGENTD_RUNTIME_RESOURCE: &str = "sidecar/agentd-runtime";
const AGENTD_ENTRY_RESOURCE: &str = "sidecar/agentd-http/index.cjs";
const AGENTD_HELPER_RESOURCE: &str = "sidecar/aica-keyring-helper";
#[cfg(windows)]
const AGENTD_MIGRATION_READER_RESOURCE: &str = "sidecar/aica-migration-reader.exe";
#[cfg(not(windows))]
const AGENTD_MIGRATION_READER_RESOURCE: &str = "sidecar/aica-migration-reader";
const AGENTD_UI_RESOURCE: &str = "ui";

const AGENTD_SUPERVISION_POLL: Duration = Duration::from_millis(500);
const AGENTD_RESTART_BACKOFF: Duration = Duration::from_secs(2);
const WINDOWS_COMPANION_TASK_NAME: &str = "AICA Native Companion";

struct AgentdProcess {
    stop: Arc<AtomicBool>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for AgentdProcess {
    fn drop(&mut self) {
        // The native host is not the daemon's lifetime owner. Stop the monitor
        // thread, but deliberately do not kill or wait on the child: agentd is
        // expected to keep serving the browser after the companion exits.
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.supervisor.get_mut().ok().and_then(Option::take);
    }
}

// `agentd` is an independently supervised user service. The companion watches
// a child it started and restarts it after a clean crash, while descriptor
// validation prevents a second writer when another live service owns the data
// directory. A later companion launch reuses that live descriptor.

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

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
async fn agentd_health(client: State<'_, AgentdClient>) -> Result<NativeHealth, String> {
    Ok(client.health().await)
}

#[tauri::command]
async fn agentd_origin(client: State<'_, AgentdClient>) -> Result<String, String> {
    client
        .origin()
        .map_err(|_| "Agentd origin unavailable".into())
}

#[tauri::command]
fn agentd_pairing_code(client: State<'_, AgentdClient>) -> Result<String, String> {
    client
        .pairing_code()
        .map_err(|_| "Pairing code unavailable; it may already be used or expired".into())
}

#[tauri::command]
async fn credential_set(
    client: State<'_, AgentdClient>,
    key: String,
    value: String,
) -> Result<NativeResult, String> {
    Ok(client.set_credential(&key, value).await)
}

#[tauri::command]
async fn credential_exists(
    client: State<'_, AgentdClient>,
    key: String,
) -> Result<CredentialExistsResult, String> {
    Ok(client.credential_exists(&key).await)
}

#[tauri::command]
async fn credential_delete(
    client: State<'_, AgentdClient>,
    key: String,
) -> Result<NativeResult, String> {
    Ok(client.delete_credential(&key).await)
}

#[tauri::command]
async fn continuity_preview(
    client: State<'_, AgentdClient>,
    source_root: String,
) -> Result<ContinuityPreview, String> {
    client
        .continuity_preview(source_root)
        .await
        .map_err(|_| "Continuity preview failed".into())
}

#[tauri::command]
async fn continuity_import(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<ContinuityImport, String> {
    client
        .continuity_import(&preview_id)
        .await
        .map_err(|_| "Continuity staging failed".into())
}

#[tauri::command]
async fn continuity_rollback(
    client: State<'_, AgentdClient>,
    migration_id: String,
) -> Result<ContinuityRollback, String> {
    client
        .continuity_rollback(&migration_id)
        .await
        .map_err(|_| "Continuity rollback failed".into())
}

#[tauri::command]
async fn settings_persona_confirm(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<SettingsPersonaCutover, String> {
    client
        .settings_persona_confirm(&preview_id)
        .await
        .map_err(|_| "Settings/persona confirmation failed".into())
}

#[tauri::command]
async fn settings_persona_apply(
    client: State<'_, AgentdClient>,
    preview_id: String,
    confirmation_token: String,
) -> Result<SettingsPersonaCutover, String> {
    client
        .settings_persona_apply(&preview_id, &confirmation_token)
        .await
        .map_err(|_| "Settings/persona cutover failed".into())
}

#[tauri::command]
async fn settings_persona_rollback(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<SettingsPersonaCutover, String> {
    client
        .settings_persona_rollback(&preview_id)
        .await
        .map_err(|_| "Settings/persona rollback failed".into())
}

#[tauri::command]
async fn settings_persona_status(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<SettingsPersonaCutover, String> {
    client
        .settings_persona_status(&preview_id)
        .await
        .map_err(|_| "Settings/persona status unavailable".into())
}

#[tauri::command]
async fn chat_history_confirm(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<ChatHistoryCutover, String> {
    client
        .chat_history_confirm(&preview_id)
        .await
        .map_err(|_| "Chat-history confirmation failed".into())
}

#[tauri::command]
async fn chat_history_apply(
    client: State<'_, AgentdClient>,
    preview_id: String,
    confirmation_token: String,
) -> Result<ChatHistoryCutover, String> {
    client
        .chat_history_apply(&preview_id, &confirmation_token)
        .await
        .map_err(|_| "Chat-history cutover failed".into())
}

#[tauri::command]
async fn chat_history_rollback(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<ChatHistoryCutover, String> {
    client
        .chat_history_rollback(&preview_id)
        .await
        .map_err(|_| "Chat-history rollback failed".into())
}

#[tauri::command]
async fn chat_history_status(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<ChatHistoryCutover, String> {
    client
        .chat_history_status(&preview_id)
        .await
        .map_err(|_| "Chat-history status unavailable".into())
}

#[tauri::command]
async fn credential_continuity_preview(
    client: State<'_, AgentdClient>,
    source_root: String,
) -> Result<CredentialContinuityPreview, String> {
    client
        .credential_continuity_preview(source_root)
        .await
        .map_err(|_| "Credential continuity preview failed".into())
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

fn open_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ =
            WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("tauri.html".into()))
                .title("AICA Native Host")
                .inner_size(1000.0, 760.0)
                .min_inner_size(800.0, 600.0)
                .build();
    }
}

fn browser_workspace_url(origin: &str) -> Result<String, String> {
    if !origin.starts_with("http://127.0.0.1:")
        || origin["http://127.0.0.1:".len()..]
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .is_none()
    {
        return Err("Agentd origin is not a valid loopback workspace URL".into());
    }
    Ok(format!("{origin}/tauri.html"))
}

fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|_| "Could not open the browser workspace".to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|_| "Could not open the browser workspace".to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|_| "Could not open the browser workspace".to_string())?;
    }
    Ok(())
}

fn open_native_folder(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Native data folder path is not absolute".into());
    }
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|_| "Could not open the agentd data folder".to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|_| "Could not open the agentd data folder".to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|_| "Could not open the agentd data folder".to_string())?;
    }
    Ok(())
}

fn open_browser_workspace_for_app<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let origin = app
        .state::<AgentdClient>()
        .origin()
        .map_err(|_| "Agentd workspace URL unavailable".to_string())?;
    let url = browser_workspace_url(&origin)?;
    open_external_url(&url)
}

#[tauri::command]
fn open_browser_workspace(client: State<'_, AgentdClient>) -> Result<(), String> {
    let origin = client
        .origin()
        .map_err(|_| "Agentd workspace URL unavailable".to_string())?;
    let url = browser_workspace_url(&origin)?;
    open_external_url(&url)
}

#[tauri::command]
fn open_agentd_data_folder(client: State<'_, AgentdClient>) -> Result<(), String> {
    let path = client
        .data_directory()
        .map_err(|_| "Agentd data directory unavailable".to_string())?;
    fs::create_dir_all(&path).map_err(|_| "Agentd data directory unavailable".to_string())?;
    open_native_folder(&path)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeServiceStatus {
    supported: bool,
    installed: bool,
    running: bool,
    task_name: &'static str,
    message: Option<String>,
}

impl NativeServiceStatus {
    fn unsupported() -> Self {
        Self {
            supported: false,
            installed: false,
            running: false,
            task_name: WINDOWS_COMPANION_TASK_NAME,
            message: Some("Per-user service registration is supported on Windows only".into()),
        }
    }
}

fn windows_task_xml(executable: &str, user_id: &str) -> String {
    fn escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    let executable = escape(executable);
    let user_id = escape(user_id);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the AICA native companion and local agentd service for the signed-in user.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT10S</Delay>
      <UserId>{user_id}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user_id}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{executable}</Command>
      <Arguments>--background</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

#[cfg(windows)]
fn write_windows_task_xml(path: &Path, xml: &str) -> io::Result<()> {
    // schtasks expects Task Scheduler XML in UTF-16LE with a BOM. Keep the
    // declaration and byte representation aligned so registration works on
    // clean Windows hosts as well as developer machines.
    let mut bytes = Vec::with_capacity(2 + xml.len() * 2);
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    for unit in xml.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(path, bytes)
}

#[cfg(windows)]
fn current_windows_user() -> Result<String, String> {
    let output = Command::new("whoami.exe")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Windows user identity unavailable".to_string())?;
    if !output.status.success() {
        return Err("Windows user identity unavailable".into());
    }
    let user = String::from_utf8(output.stdout)
        .map_err(|_| "Windows user identity unavailable".to_string())?
        .trim()
        .to_owned();
    if user.is_empty()
        || user.len() > 256
        || user
            .chars()
            .any(|character| matches!(character, '\r' | '\n'))
    {
        return Err("Windows user identity unavailable".into());
    }
    Ok(user)
}

#[cfg(windows)]
fn run_schtasks(args: &[&OsStr]) -> Result<Output, String> {
    let system_root = env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Windows system root unavailable".to_string())?;
    let executable = PathBuf::from(system_root)
        .join("System32")
        .join("schtasks.exe");
    if !fs::metadata(&executable)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return Err("Windows Task Scheduler is unavailable".into());
    }
    Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Windows Task Scheduler is unavailable".to_string())
}

#[cfg(windows)]
fn windows_service_status() -> Result<NativeServiceStatus, String> {
    let task = OsStr::new(WINDOWS_COMPANION_TASK_NAME);
    let output = run_schtasks(&[
        OsStr::new("/Query"),
        OsStr::new("/TN"),
        task,
        OsStr::new("/FO"),
        OsStr::new("LIST"),
        OsStr::new("/NH"),
    ])?;
    if !output.status.success() {
        return Ok(NativeServiceStatus {
            supported: true,
            installed: false,
            running: false,
            task_name: WINDOWS_COMPANION_TASK_NAME,
            message: Some("Not registered for Windows sign-in".into()),
        });
    }
    let detail = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    Ok(NativeServiceStatus {
        supported: true,
        installed: true,
        running: detail.contains("running"),
        task_name: WINDOWS_COMPANION_TASK_NAME,
        message: Some("Registered for this Windows user".into()),
    })
}

fn native_service_status() -> Result<NativeServiceStatus, String> {
    #[cfg(windows)]
    {
        return windows_service_status();
    }
    #[cfg(not(windows))]
    {
        Ok(NativeServiceStatus::unsupported())
    }
}

#[tauri::command]
fn service_status() -> Result<NativeServiceStatus, String> {
    native_service_status()
}

#[cfg(windows)]
fn install_windows_service(app: &AppHandle) -> Result<NativeServiceStatus, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "Native companion executable unavailable".to_string())?;
    let executable = executable
        .to_str()
        .ok_or_else(|| "Native companion executable path is not valid Unicode".to_string())?;
    let user_id = current_windows_user()?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Agentd data directory unavailable".to_string())?;
    fs::create_dir_all(&data_dir).map_err(|_| "Agentd data directory unavailable".to_string())?;
    let xml_path = data_dir.join("aica-companion-task.xml");
    write_windows_task_xml(&xml_path, &windows_task_xml(executable, &user_id))
        .map_err(|_| "Could not prepare Windows service registration".to_string())?;
    let task_name = OsStr::new(WINDOWS_COMPANION_TASK_NAME);
    let xml_path_arg = xml_path
        .to_str()
        .ok_or_else(|| "Windows service definition path is not valid Unicode".to_string())?;
    let output = run_schtasks(&[
        OsStr::new("/Create"),
        OsStr::new("/TN"),
        task_name,
        OsStr::new("/XML"),
        OsStr::new(xml_path_arg),
        OsStr::new("/F"),
    ]);
    let _ = fs::remove_file(&xml_path);
    let output = output?;
    if !output.status.success() {
        return Err("Windows service registration failed".into());
    }
    // Task Scheduler can acknowledge `/Create` before `/Query` observes the
    // new user task on hosted Windows runners. Bounded retry keeps the action
    // truthful without hiding a real registration failure.
    for _ in 0..20 {
        let status = windows_service_status()?;
        if status.installed {
            return Ok(status);
        }
        thread::sleep(Duration::from_millis(100));
    }
    let status = windows_service_status()?;
    if !status.installed {
        let query = run_schtasks(&[
            OsStr::new("/Query"),
            OsStr::new("/TN"),
            task_name,
            OsStr::new("/FO"),
            OsStr::new("LIST"),
            OsStr::new("/NH"),
        ])
        .map_err(|error| format!("Windows service registration not visible: {error}"))?;
        return Err(format!(
            "Windows service registration not visible after create (create stdout: {}; create stderr: {}; query stdout: {}; query stderr: {})",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim(),
            String::from_utf8_lossy(&query.stdout).trim(),
            String::from_utf8_lossy(&query.stderr).trim(),
        ));
    }
    Ok(status)
}

#[cfg(not(windows))]
fn install_windows_service(_app: &AppHandle) -> Result<NativeServiceStatus, String> {
    Ok(NativeServiceStatus::unsupported())
}

#[tauri::command]
fn service_install(app: AppHandle) -> Result<NativeServiceStatus, String> {
    install_windows_service(&app)
}

#[cfg(windows)]
fn uninstall_windows_service() -> Result<NativeServiceStatus, String> {
    let output = run_schtasks(&[
        OsStr::new("/Delete"),
        OsStr::new("/TN"),
        OsStr::new(WINDOWS_COMPANION_TASK_NAME),
        OsStr::new("/F"),
    ])?;
    if !output.status.success() {
        return Err("Windows service removal failed".into());
    }
    windows_service_status()
}

#[cfg(not(windows))]
fn uninstall_windows_service() -> Result<NativeServiceStatus, String> {
    Ok(NativeServiceStatus::unsupported())
}

#[tauri::command]
fn service_uninstall() -> Result<NativeServiceStatus, String> {
    uninstall_windows_service()
}

#[derive(Clone, Copy)]
enum ServiceCliAction {
    Register,
    Unregister,
    Status,
}

fn service_cli_action() -> Option<ServiceCliAction> {
    std::env::args_os()
        .skip(1)
        .find_map(|argument| match argument.to_str() {
            Some("--register-service") => Some(ServiceCliAction::Register),
            Some("--unregister-service") => Some(ServiceCliAction::Unregister),
            Some("--service-status") => Some(ServiceCliAction::Status),
            _ => None,
        })
}

fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    app.state::<Arc<AtomicBool>>().store(true, Ordering::SeqCst);
    app.exit(0);
}

fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open native diagnostics").build(app)?;
    let browser = MenuItemBuilder::with_id("browser", "Open browser workspace").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&browser, &open, &quit])
        .build()?;
    let icon = tauri::image::Image::new_owned(vec![46, 120, 220, 255].repeat(16 * 16), 16, 16);
    tauri::tray::TrayIconBuilder::with_id("aica-tray")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => open_main_window(app),
            "browser" => {
                if let Err(error) = open_browser_workspace_for_app(app) {
                    eprintln!("[aica] browser workspace unavailable: {error}");
                }
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn resource_file<R: Runtime>(app: &AppHandle<R>, relative: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resolve(relative, tauri::path::BaseDirectory::Resource)
        .map_err(|_| format!("Packaged resource unavailable: {relative}"))?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| format!("Packaged resource unavailable: {relative}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("Packaged resource is not a file: {relative}"));
    }
    Ok(path)
}

fn resource_directory<R: Runtime>(app: &AppHandle<R>, relative: &str) -> Option<PathBuf> {
    let path = app
        .path()
        .resolve(relative, tauri::path::BaseDirectory::Resource)
        .ok()?;
    fs::metadata(&path).ok()?.is_dir().then_some(path)
}

fn spawn_agentd<R: Runtime>(app: &AppHandle<R>, data_dir: &PathBuf) -> Result<Child, String> {
    fs::create_dir_all(data_dir).map_err(|_| "Agentd data directory unavailable".to_string())?;
    let runtime = resource_file(app, AGENTD_RUNTIME_RESOURCE)?;
    let entry = resource_file(app, AGENTD_ENTRY_RESOURCE)?;
    let helper = resource_file(app, AGENTD_HELPER_RESOURCE)
        .or_else(|_| resource_file(app, "sidecar/aica-keyring-helper.exe"))?;
    let migration_reader = resource_file(app, AGENTD_MIGRATION_READER_RESOURCE)?;
    let entry_directory = entry
        .parent()
        .ok_or_else(|| "Packaged agentd entrypoint directory unavailable".to_string())?;
    let entry_name = entry
        .file_name()
        .ok_or_else(|| "Packaged agentd entrypoint name unavailable".to_string())?;
    let mut command = Command::new(runtime);
    command
        // Keep the script argument relative to its resource directory. On
        // Windows, passing a drive-qualified script path to a copied Node
        // runtime can be parsed as the bare drive (`D:`) before Node starts.
        .arg(entry_name)
        .env_clear()
        .env("AICA_AGENTD_DATA_DIR", data_dir)
        .env("AICA_AGENTD_KEYRING_HELPER", helper)
        .env("AICA_AGENTD_MIGRATION_READER", migration_reader)
        .current_dir(entry_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(ui_root) = resource_directory(app, AGENTD_UI_RESOURCE) {
        command.env("AICA_AGENTD_UI_ROOT", ui_root);
    }
    // Keep environment deterministic, but retain Windows system/profile roots
    // required by Node and Credential Manager after env_clear().
    #[cfg(windows)]
    for key in ["SystemRoot", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    let stderr = env::var_os("AICA_AGENTD_STARTUP_LOG")
        .and_then(|path| {
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok()
        })
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    command.stderr(stderr);
    command
        .spawn()
        .map_err(|_| "Packaged agentd runtime could not start".to_string())
}

fn should_spawn_agentd(client: &AgentdClient) -> bool {
    client.origin().is_err()
}

fn supervise_agentd<R: Runtime + 'static>(
    app: AppHandle<R>,
    data_dir: PathBuf,
    initial_child: Option<Child>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("aica-agentd-supervisor".into())
        .spawn(move || {
            let client = AgentdClient::with_data_dir(data_dir.clone());
            let mut child = initial_child;
            let mut restart_after = Instant::now();

            while !stop.load(Ordering::SeqCst) {
                if let Some(process) = child.as_mut() {
                    match process.try_wait() {
                        Ok(None) => {
                            thread::sleep(AGENTD_SUPERVISION_POLL);
                            continue;
                        }
                        Ok(Some(status)) => {
                            eprintln!("[aica] agentd exited ({status}); scheduling restart");
                            child = None;
                            restart_after = Instant::now() + AGENTD_RESTART_BACKOFF;
                        }
                        Err(error) => {
                            eprintln!("[aica] agentd supervision stopped: {error}");
                            break;
                        }
                    }
                }

                if Instant::now() < restart_after {
                    thread::sleep(AGENTD_SUPERVISION_POLL);
                    continue;
                }

                // A separate companion/service may have claimed the runtime
                // between the child exit and this check. Never start another
                // writer while its private descriptor still validates.
                if !should_spawn_agentd(&client) {
                    thread::sleep(AGENTD_SUPERVISION_POLL);
                    continue;
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }

                match spawn_agentd(&app, &data_dir) {
                    Ok(next) => {
                        child = Some(next);
                        restart_after = Instant::now() + AGENTD_RESTART_BACKOFF;
                    }
                    Err(error) => {
                        eprintln!("[aica] agentd restart failed: {error}");
                        restart_after = Instant::now() + AGENTD_RESTART_BACKOFF;
                        thread::sleep(AGENTD_SUPERVISION_POLL);
                    }
                }
            }
            // Dropping Child does not terminate it; this is intentional so a
            // companion shutdown leaves the independently running service up.
        })
        .expect("agentd supervisor thread could not start")
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            agentd_health,
            agentd_origin,
            agentd_pairing_code,
            open_browser_workspace,
            open_agentd_data_folder,
            service_status,
            service_install,
            service_uninstall,
            credential_set,
            credential_exists,
            credential_delete,
            continuity_preview,
            continuity_import,
            continuity_rollback,
            settings_persona_confirm,
            settings_persona_apply,
            settings_persona_rollback,
            settings_persona_status,
            chat_history_confirm,
            chat_history_apply,
            chat_history_rollback,
            chat_history_status,
            credential_continuity_preview,
            select_file,
            select_folder
        ])
        .setup(|app| {
            let stop = Arc::new(AtomicBool::new(false));
            app.manage(stop.clone());

            // Explicit service actions must not start agentd or open the UI.
            // Normal launches, including --background, keep their existing
            // lifecycle and supervision behavior.
            if let Some(action) = service_cli_action() {
                let result = match action {
                    ServiceCliAction::Register => install_windows_service(app.handle()),
                    ServiceCliAction::Unregister => uninstall_windows_service(),
                    ServiceCliAction::Status => native_service_status(),
                };
                match result {
                    Ok(status) => {
                        println!(
                            "{}",
                            serde_json::to_string(&status)
                                .map_err(|_| "Could not encode service status")?
                        );
                        // These maintenance actions intentionally never enter
                        // the UI event loop or start agentd. Exit directly so
                        // callers (including the Windows installer smoke) get
                        // the actual operation result instead of a deferred
                        // event-loop exit code.
                        std::process::exit(0);
                    }
                    Err(error) => {
                        eprintln!("[aica] native service action failed: {error}");
                        std::process::exit(1);
                    }
                }
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "Agentd data directory unavailable")?;
            let client = AgentdClient::with_data_dir(data_dir.clone());
            let child = if should_spawn_agentd(&client) {
                Some(spawn_agentd(app.handle(), &data_dir)?)
            } else {
                None
            };
            let supervisor =
                supervise_agentd(app.handle().clone(), data_dir.clone(), child, stop.clone());
            app.manage(AgentdProcess {
                stop: stop.clone(),
                supervisor: Mutex::new(Some(supervisor)),
            });
            app.manage(client);
            create_tray(app.handle())?;
            if std::env::args_os()
                .skip(1)
                .any(|argument| argument == "--background")
            {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.hide();
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
        .expect("error while building AICA Tauri settings");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Arc<AtomicBool>>().load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn browser_workspace_url_is_loopback_only() {
        assert_eq!(
            browser_workspace_url("http://127.0.0.1:4141").unwrap(),
            "http://127.0.0.1:4141/tauri.html"
        );
        assert!(browser_workspace_url("https://example.test").is_err());
        assert!(browser_workspace_url("http://127.0.0.1:0").is_err());
        assert!(browser_workspace_url("http://127.0.0.1:4141/evil").is_err());
    }

    #[test]
    fn existing_runtime_descriptor_prevents_second_agentd_spawn() {
        // A client with no descriptor must request a child; a valid descriptor
        // is consumed by `should_spawn_agentd` without starting another writer.
        let missing =
            AgentdClient::with_data_dir(PathBuf::from("/definitely/missing/aica-agentd-test"));
        assert!(should_spawn_agentd(&missing));
    }

    #[test]
    fn windows_service_definition_is_user_scoped_and_escaped() {
        let xml = windows_task_xml(r"C:\Program Files\AICA & Host\aica.exe", r"DOMAIN\owner");
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RestartOnFailure>"));
        assert!(xml.contains("--background"));
        assert!(xml.contains("C:\\Program Files\\AICA &amp; Host\\aica.exe"));
        assert!(xml.contains("DOMAIN\\owner"));
        assert!(!xml.contains("AICA & Host\\aica.exe</Command>"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_task_scheduler_registration_round_trip() {
        let task_name = format!("AICA Native Companion Test {}", std::process::id());
        let xml_path =
            std::env::temp_dir().join(format!("aica-companion-task-{}.xml", std::process::id()));
        let executable = std::env::current_exe().expect("test executable path");
        let executable = executable
            .to_str()
            .expect("test executable path is Unicode");
        let user = current_windows_user().expect("Windows user identity");
        write_windows_task_xml(&xml_path, &windows_task_xml(executable, &user))
            .expect("write task XML");

        let _ = run_schtasks(&[
            OsStr::new("/Delete"),
            OsStr::new("/TN"),
            OsStr::new(&task_name),
            OsStr::new("/F"),
        ]);
        let create = run_schtasks(&[
            OsStr::new("/Create"),
            OsStr::new("/TN"),
            OsStr::new(&task_name),
            OsStr::new("/XML"),
            OsStr::new(xml_path.to_str().expect("temporary path is Unicode")),
            OsStr::new("/F"),
        ])
        .expect("schtasks create");
        assert!(
            create.status.success(),
            "schtasks create failed: {}",
            String::from_utf8_lossy(&create.stderr)
        );

        let query = run_schtasks(&[
            OsStr::new("/Query"),
            OsStr::new("/TN"),
            OsStr::new(&task_name),
        ])
        .expect("schtasks query");
        assert!(
            query.status.success(),
            "schtasks query failed: {}",
            String::from_utf8_lossy(&query.stderr)
        );

        let delete = run_schtasks(&[
            OsStr::new("/Delete"),
            OsStr::new("/TN"),
            OsStr::new(&task_name),
            OsStr::new("/F"),
        ])
        .expect("schtasks delete");
        assert!(
            delete.status.success(),
            "schtasks delete failed: {}",
            String::from_utf8_lossy(&delete.stderr)
        );
        let _ = std::fs::remove_file(xml_path);
    }
}
