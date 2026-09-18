#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agentd_api;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

#[cfg(windows)]
use std::env;

use agentd_api::{AgentdClient, ContinuityImport, ContinuityPreview, ContinuityRollback, CredentialExistsResult, NativeHealth, NativeResult};
use serde::Deserialize;
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
const AGENTD_UI_RESOURCE: &str = "ui";

struct AgentdProcess(Mutex<Option<Child>>);

impl Drop for AgentdProcess {
    fn drop(&mut self) {
        let Ok(mut child) = self.0.lock() else { return };
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
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
    client.continuity_preview(source_root).await.map_err(|_| "Continuity preview failed".into())
}

#[tauri::command]
async fn continuity_import(
    client: State<'_, AgentdClient>,
    preview_id: String,
) -> Result<ContinuityImport, String> {
    client.continuity_import(&preview_id).await.map_err(|_| "Continuity staging failed".into())
}

#[tauri::command]
async fn continuity_rollback(
    client: State<'_, AgentdClient>,
    migration_id: String,
) -> Result<ContinuityRollback, String> {
    client.continuity_rollback(&migration_id).await.map_err(|_| "Continuity rollback failed".into())
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
    let mut command = Command::new(runtime);
    command
        .arg(entry)
        .env_clear()
        .env("AICA_AGENTD_DATA_DIR", data_dir)
        .env("AICA_AGENTD_KEYRING_HELPER", helper)
        .current_dir(data_dir)
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
    command
        .spawn()
        .map_err(|_| "Packaged agentd runtime could not start".to_string())
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            agentd_health,
            agentd_origin,
            open_browser_workspace,
            credential_set,
            credential_exists,
            credential_delete,
            continuity_preview,
            continuity_import,
            continuity_rollback,
            select_file,
            select_folder
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "Agentd data directory unavailable")?;
            let child = spawn_agentd(app.handle(), &data_dir)?;
            app.manage(AgentdProcess(Mutex::new(Some(child))));
            app.manage(AgentdClient::with_data_dir(data_dir));
            app.manage(Arc::new(AtomicBool::new(false)));
            create_tray(app.handle())?;
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
}
