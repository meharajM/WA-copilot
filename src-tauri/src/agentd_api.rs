use std::{
    env,
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(unix)]
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::ffi::c_void;

use keyring::Entry;
use reqwest::{
    header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    Method, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use zeroize::Zeroizing;

const PROTOCOL_VERSION: u64 = 1;
const MAX_DESCRIPTOR_BYTES: u64 = 4096;
const MAX_PAIRING_CODE_BYTES: u64 = 64;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;
const MAX_CHAT_ID_BYTES: usize = 128;
const MAX_CHAT_TITLE_CHARS: usize = 256;
const MAX_CHAT_CONTENT_BYTES: usize = 32 * 1024;
const MAX_WORKSPACE_PATH_BYTES: usize = 1024;
const KEYCHAIN_SERVICE: &str = "com.aica.wacopilot";
const BEARER_KEY: &str = "agentd_bearer_secret";

fn valid_chat_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CHAT_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_chat_title(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_CHAT_TITLE_CHARS
        && value.len() <= MAX_CHAT_TITLE_CHARS * 4
}

fn valid_chat_content(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_CHAT_CONTENT_BYTES
}

fn valid_workspace_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_WORKSPACE_PATH_BYTES
}

fn valid_model_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 128
        && first.is_ascii_alphanumeric()
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '/' | '-')
        })
}

fn valid_preview_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn valid_confirmation_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeDescriptor {
    protocol_version: u64,
    pid: u32,
    origin: String,
    started_at: u64,
    process_started_at: u64,
    runtime_id: String,
}

impl RuntimeDescriptor {
    fn parse(bytes: &[u8]) -> Result<Self, ()> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_DESCRIPTOR_BYTES {
            return Err(());
        }
        let descriptor: Self = serde_json::from_slice(bytes).map_err(|_| ())?;
        if descriptor.protocol_version != PROTOCOL_VERSION
            || descriptor.pid == 0
            || descriptor.started_at == 0
            || descriptor.process_started_at == 0
            || descriptor.runtime_id.is_empty()
            || descriptor.runtime_id.len() > 64
        {
            return Err(());
        }
        validate_loopback_origin(&descriptor.origin)?;
        Ok(descriptor)
    }
}

fn validate_loopback_origin(origin: &str) -> Result<(), ()> {
    let url = Url::parse(origin).map_err(|_| ())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || origin != url.origin().ascii_serialization()
    {
        return Err(());
    }
    Ok(())
}

fn resolve_data_dir() -> Result<PathBuf, &'static str> {
    #[cfg(windows)]
    let local_app_data = non_empty_env("LOCALAPPDATA").or_else(|| non_empty_env("APPDATA"));
    #[cfg(not(windows))]
    let local_app_data: Option<String> = None;
    let home = if cfg!(windows) {
        non_empty_env("USERPROFILE").or_else(|| non_empty_env("HOME"))
    } else {
        non_empty_env("HOME").or_else(|| non_empty_env("USERPROFILE"))
    };
    resolve_data_dir_from(
        non_empty_env("AICA_AGENTD_DATA_DIR").as_deref(),
        non_empty_env("XDG_STATE_HOME").as_deref(),
        local_app_data.as_deref(),
        home.as_deref(),
    )
}

fn resolve_data_dir_from(
    data_dir: Option<&str>,
    xdg_state_home: Option<&str>,
    local_app_data: Option<&str>,
    home: Option<&str>,
) -> Result<PathBuf, &'static str> {
    #[cfg(not(windows))]
    let _ = local_app_data;
    if let Some(path) = data_dir {
        return Ok(PathBuf::from(path));
    }
    #[cfg(windows)]
    if let Some(path) = local_app_data {
        return Ok(PathBuf::from(path).join("aica"));
    }
    if let Some(path) = xdg_state_home {
        return Ok(PathBuf::from(path).join("aica"));
    }
    let home = home.ok_or("Agentd data directory unavailable")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("state")
        .join("aica"))
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn reject_reparse_path(path: &Path) -> Result<(), ()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    if !path.is_absolute() {
        return Err(());
    }
    let mut current = Some(path);
    while let Some(candidate) = current {
        let metadata = std::fs::symlink_metadata(candidate).map_err(|_| ())?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(());
        }
        let Some(parent) = candidate.parent() else {
            break;
        };
        if parent == candidate {
            break;
        }
        current = Some(parent);
    }
    Ok(())
}

fn open_private_descriptor(path: &std::path::Path) -> Result<File, ()> {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| ())?
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        // Open without sharing and without following reparse points. This keeps the
        // descriptor handle stable while it is read and blocks replace/delete races.
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| ())?
    };
    #[cfg(all(not(unix), not(windows)))]
    let file = OpenOptions::new().read(true).open(path).map_err(|_| ())?;

    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_DESCRIPTOR_BYTES {
        return Err(());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(());
        }
    }
    Ok(file)
}

fn read_descriptor(path: &std::path::Path) -> Result<RuntimeDescriptor, ()> {
    let file = open_private_descriptor(path)?;
    let mut bytes = Vec::with_capacity(512);
    file.take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    RuntimeDescriptor::parse(&bytes)
}

#[cfg(unix)]
fn process_is_live_and_owned_by_current_user(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 || unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }

    let Ok(output) = Command::new("/bin/ps")
        .args(["-o", "uid=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let Ok(stdout) = String::from_utf8(output.stdout) else {
        return false;
    };
    let mut fields = stdout.split_whitespace();
    let Some(owner_uid) = fields
        .next()
        .and_then(|value| value.parse::<libc::uid_t>().ok())
    else {
        return false;
    };

    owner_uid == unsafe { libc::geteuid() }
        && fields.next().is_none()
        && unsafe { libc::kill(pid, 0) } == 0
}

#[cfg(windows)]
fn process_is_live_and_owned_by_current_user(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
        System::Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    unsafe fn token_matches_current_user(process_token: HANDLE, current_token: HANDLE) -> bool {
        let mut process_length = 0_u32;
        let _ = GetTokenInformation(
            process_token,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut process_length,
        );
        let mut current_length = 0_u32;
        let _ = GetTokenInformation(
            current_token,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut current_length,
        );
        if process_length == 0 || current_length == 0 {
            return false;
        }
        let mut process_buffer = vec![0_u8; process_length as usize];
        let mut current_buffer = vec![0_u8; current_length as usize];
        if GetTokenInformation(
            process_token,
            TokenUser,
            process_buffer.as_mut_ptr().cast::<c_void>(),
            process_length,
            &mut process_length,
        ) == 0
            || GetTokenInformation(
                current_token,
                TokenUser,
                current_buffer.as_mut_ptr().cast::<c_void>(),
                current_length,
                &mut current_length,
            ) == 0
        {
            return false;
        }
        let process_user = process_buffer.as_ptr().cast::<TOKEN_USER>();
        let current_user = current_buffer.as_ptr().cast::<TOKEN_USER>();
        EqualSid((*process_user).User.Sid, (*current_user).User.Sid) != 0
    }

    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut process_token = std::ptr::null_mut();
        let mut current_token = std::ptr::null_mut();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut process_token) != 0
            && OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut current_token) != 0;
        let matches = opened && token_matches_current_user(process_token, current_token);
        if !process_token.is_null() {
            CloseHandle(process_token);
        }
        if !current_token.is_null() {
            CloseHandle(current_token);
        }
        CloseHandle(process);
        matches
    }
}

#[cfg(all(not(unix), not(windows)))]
fn process_is_live_and_owned_by_current_user(_pid: u32) -> bool {
    // Unsupported hosts fail closed rather than sending bearer credentials.
    false
}

const PROCESS_START_TOLERANCE_MS: u64 = 2_500;

/// Return the wall-clock start time of an OS process. A PID and UID only identify a
/// currently-owned process, not the process instance that wrote our descriptor: the PID
/// can be reused after agentd exits. Unsupported Unix variants fail closed.
#[cfg(target_os = "linux")]
fn process_started_at_ms(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    let start_ticks = fields.split_whitespace().nth(19)?.parse::<u64>().ok()?;
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks_per_second <= 0 {
        return None;
    }
    let boot_time_seconds = std::fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("btime ")?.trim().parse::<u64>().ok())?;
    boot_time_seconds
        .checked_mul(1_000)?
        .checked_add(start_ticks.checked_mul(1_000)? / ticks_per_second as u64)
}

#[cfg(target_os = "macos")]
fn process_started_at_ms(pid: u32) -> Option<u64> {
    // macOS exposes a locale-stable, second-resolution `lstart` field through ps when
    // LC_ALL=C. Descriptor timestamps are wall-clock milliseconds, so allow the one-second
    // formatting loss plus a small scheduling margin. Any ps/date failure rejects the peer.
    let output = Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let start = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    if start.is_empty() {
        return None;
    }
    let output = Command::new("/bin/date")
        .args(["-j", "-f", "%a %b %e %T %Y", &start, "+%s"])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let seconds = String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    seconds.checked_mul(1_000)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_started_at_ms(_pid: u32) -> Option<u64> {
    None
}

#[cfg(windows)]
fn process_started_at_ms(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let ok =
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } != 0;
    unsafe { CloseHandle(process) };
    if !ok {
        return None;
    }
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    // FILETIME uses 100ns ticks since 1601-01-01; descriptor uses Unix ms.
    const WINDOWS_EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000;
    ticks
        .checked_sub(WINDOWS_EPOCH_OFFSET_100NS)
        .map(|value| value / 10_000)
}

#[cfg(all(not(unix), not(windows)))]
fn process_started_at_ms(_pid: u32) -> Option<u64> {
    None
}

fn process_identity_matches_descriptor(descriptor: &RuntimeDescriptor) -> bool {
    if !process_is_live_and_owned_by_current_user(descriptor.pid) {
        return false;
    }
    let Some(process_started_at) = process_started_at_ms(descriptor.pid) else {
        return false;
    };
    process_started_at.abs_diff(descriptor.process_started_at) <= PROCESS_START_TOLERANCE_MS
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreferredProvider {
    Auto,
    Openai,
    Openrouter,
    Ollama,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LlmSettings {
    pub preferred_provider: PreferredProvider,
    pub openai_model: String,
    pub openrouter_model: String,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            preferred_provider: PreferredProvider::Auto,
            openai_model: "gpt-4o-mini".into(),
            openrouter_model: "anthropic/claude-3-haiku".into(),
        }
    }
}

impl LlmSettings {
    fn validate(&self) -> Result<(), &'static str> {
        if self.openai_model.trim().is_empty()
            || self.openai_model.chars().count() > 128
            || self.openrouter_model.trim().is_empty()
            || self.openrouter_model.chars().count() > 128
        {
            return Err("Invalid LLM settings");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WhatsAppSettings {
    pub whatsapp_transport: String,
    pub whatsapp_cloud_phone_number_id: String,
    pub whatsapp_cloud_api_version: String,
}

impl Default for WhatsAppSettings {
    fn default() -> Self {
        Self {
            whatsapp_transport: "baileys".into(),
            whatsapp_cloud_phone_number_id: String::new(),
            whatsapp_cloud_api_version: "v23.0".into(),
        }
    }
}

impl WhatsAppSettings {
    fn validate(&self) -> Result<(), &'static str> {
        if !matches!(
            self.whatsapp_transport.as_str(),
            "baileys" | "cloud" | "web"
        ) || self.whatsapp_cloud_phone_number_id.chars().count() > 128
            || self.whatsapp_cloud_api_version.trim().is_empty()
            || self.whatsapp_cloud_api_version.chars().count() > 32
        {
            return Err("Invalid WhatsApp settings");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentdStatus {
    pub runtime: String,
    pub paused: bool,
    pub queue_depth: u64,
    pub events: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHealth {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_depth: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<u64>,
}

impl NativeHealth {
    pub fn from_status(status: AgentdStatus) -> Self {
        Self {
            status: "ready".into(),
            version: Some(format!("agentd protocol v{PROTOCOL_VERSION}")),
            error: None,
            paused: Some(status.paused),
            queue_depth: Some(status.queue_depth),
            events: Some(status.events),
        }
    }

    pub fn unavailable() -> Self {
        Self {
            status: "unavailable".into(),
            version: None,
            error: Some("agentd is stopped or unavailable".into()),
            paused: None,
            queue_depth: None,
            events: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialExistsResult {
    pub success: bool,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionsResponse {
    pub sessions: Vec<ChatSessionSummary>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionResponse {
    pub session: ChatSessionSummary,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageResponse {
    pub message: ChatMessage,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGenerationMeta {
    pub session_id: String,
    pub request_id: String,
    pub provider: String,
    pub model: String,
    pub streaming: bool,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGenerationResponse {
    pub generation: ChatGenerationMeta,
    pub message: ChatMessage,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuityEntry {
    pub id: String,
    pub source: String,
    pub target: String,
    pub format: String,
    pub schema_version: String,
    pub requires_reauthentication: bool,
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuityPreview {
    pub preview_id: String,
    pub created_at: u64,
    pub source: String,
    pub target: String,
    pub entries: Vec<ContinuityEntry>,
    pub secrets_excluded: bool,
    pub requires_owner_confirmation: bool,
    pub requires_reauthentication: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuityImport {
    pub migration_id: String,
    pub state: String,
    pub entries: Vec<ContinuityEntry>,
    pub secrets_excluded: bool,
    pub live_data_changed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinuityRollback {
    pub migration_id: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPersonaCutover {
    pub preview_id: String,
    pub scope: String,
    pub target_runtime: String,
    pub state: String,
    pub manifest_hash: String,
    pub expires_at: Option<u64>,
    pub confirmation_token: Option<String>,
    pub backup_sha256: Option<String>,
    pub live_data_changed: Option<bool>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatHistoryCutover {
    pub preview_id: String,
    pub scope: String,
    pub target_runtime: String,
    pub state: String,
    pub manifest_hash: String,
    pub expires_at: Option<u64>,
    pub confirmation_token: Option<String>,
    pub requires_reconfirmation: Option<bool>,
    pub manual_recovery_required: Option<bool>,
    pub backup_sha256: Option<String>,
    pub sessions_imported: Option<u64>,
    pub messages_imported: Option<u64>,
    pub sessions_already_present: Option<u64>,
    pub messages_already_present: Option<u64>,
    pub live_data_changed: Option<bool>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialContinuityEntry {
    pub key: String,
    pub scope: String,
    pub supported: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialContinuityStore {
    pub id: String,
    pub present: bool,
    pub entries: Vec<CredentialContinuityEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialContinuityPreview {
    pub version: u64,
    pub source: String,
    pub target: String,
    pub state: String,
    pub stores: Vec<CredentialContinuityStore>,
    pub secrets_excluded: bool,
    pub requires_owner_confirmation: bool,
    pub requires_reauthentication: bool,
    pub transferable: bool,
    pub note: String,
}

#[derive(Clone, Copy)]
enum CredentialKey {
    Openai,
    Openrouter,
    WhatsAppCloudAccessToken,
    WhatsAppCloudAppSecret,
    WhatsAppCloudVerifyToken,
}

impl CredentialKey {
    fn parse(key: &str) -> Result<Self, ()> {
        match key {
            "openai_api_key" => Ok(Self::Openai),
            "openrouter_api_key" => Ok(Self::Openrouter),
            "whatsapp_cloud_access_token" => Ok(Self::WhatsAppCloudAccessToken),
            "whatsapp_cloud_app_secret" => Ok(Self::WhatsAppCloudAppSecret),
            "whatsapp_cloud_verify_token" => Ok(Self::WhatsAppCloudVerifyToken),
            _ => Err(()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai_api_key",
            Self::Openrouter => "openrouter_api_key",
            Self::WhatsAppCloudAccessToken => "whatsapp_cloud_access_token",
            Self::WhatsAppCloudAppSecret => "whatsapp_cloud_app_secret",
            Self::WhatsAppCloudVerifyToken => "whatsapp_cloud_verify_token",
        }
    }
}

#[derive(Clone, Copy)]
enum Provider {
    Openai,
    Openrouter,
    Ollama,
}

impl Provider {
    fn parse(value: &str) -> Result<Self, ()> {
        match value {
            "openai" => Ok(Self::Openai),
            "openrouter" => Ok(Self::Openrouter),
            "ollama" => Ok(Self::Ollama),
            _ => Err(()),
        }
    }
}

#[derive(Clone)]
enum Route {
    Status,
    ContinuityPreview,
    ContinuityImport,
    ContinuityRollback,
    SettingsPersonaConfirm,
    SettingsPersonaApply,
    SettingsPersonaRollback,
    SettingsPersonaStatus(String),
    ChatHistoryConfirm,
    ChatHistoryApply,
    ChatHistoryRollback,
    ChatHistoryStatus(String),
    CredentialContinuityPreview,
    LlmSettingsGet,
    LlmSettingsPut,
    WhatsAppSettingsGet,
    WhatsAppSettingsPut,
    CredentialGet(CredentialKey),
    CredentialSet(CredentialKey),
    CredentialDelete(CredentialKey),
    ProviderTest(Provider),
    ChatSessions,
    ChatSessionsCreate,
    ChatSession(String),
    ChatSessionUpdate(String),
    ChatSessionDelete(String),
    ChatMessages(String),
    ChatGenerations(String),
}

impl Route {
    fn method(self) -> Method {
        match self {
            Self::Status
            | Self::LlmSettingsGet
            | Self::WhatsAppSettingsGet
            | Self::CredentialGet(_)
            | Self::ChatSessions
            | Self::ChatSession(_) => Method::GET,
            Self::LlmSettingsPut | Self::WhatsAppSettingsPut => Method::PUT,
            Self::ChatSessionUpdate(_) => Method::PATCH,
            Self::CredentialSet(_)
            | Self::ContinuityPreview
            | Self::ContinuityImport
            | Self::ContinuityRollback
            | Self::SettingsPersonaConfirm
            | Self::SettingsPersonaApply
            | Self::SettingsPersonaRollback
            | Self::ChatHistoryConfirm
            | Self::ChatHistoryApply
            | Self::ChatHistoryRollback
            | Self::CredentialContinuityPreview
            | Self::ProviderTest(_)
            | Self::ChatSessionsCreate
            | Self::ChatMessages(_)
            | Self::ChatGenerations(_) => Method::POST,
            Self::CredentialDelete(_) | Self::ChatSessionDelete(_) => Method::DELETE,
            Self::SettingsPersonaStatus(_) | Self::ChatHistoryStatus(_) => Method::GET,
        }
    }

    fn path(self) -> String {
        match self {
            Self::Status => "/api/v1/status".into(),
            Self::ContinuityPreview => "/api/v1/continuity/preview".into(),
            Self::ContinuityImport => "/api/v1/continuity/import".into(),
            Self::ContinuityRollback => "/api/v1/continuity/rollback".into(),
            Self::SettingsPersonaConfirm => "/api/v1/continuity/settings-persona/confirm".into(),
            Self::SettingsPersonaApply => "/api/v1/continuity/settings-persona/apply".into(),
            Self::SettingsPersonaRollback => "/api/v1/continuity/settings-persona/rollback".into(),
            Self::SettingsPersonaStatus(preview_id) => {
                format!("/api/v1/continuity/settings-persona/status?previewId={preview_id}")
            }
            Self::ChatHistoryConfirm => "/api/v1/continuity/chat-history/confirm".into(),
            Self::ChatHistoryApply => "/api/v1/continuity/chat-history/apply".into(),
            Self::ChatHistoryRollback => "/api/v1/continuity/chat-history/rollback".into(),
            Self::ChatHistoryStatus(preview_id) => {
                format!("/api/v1/continuity/chat-history/status?previewId={preview_id}")
            }
            Self::CredentialContinuityPreview => "/api/v1/continuity/credentials/preview".into(),
            Self::LlmSettingsGet | Self::LlmSettingsPut => "/api/v1/settings/llm".into(),
            Self::WhatsAppSettingsGet | Self::WhatsAppSettingsPut => {
                "/api/v1/settings/whatsapp".into()
            }
            Self::CredentialGet(key) | Self::CredentialSet(key) | Self::CredentialDelete(key) => {
                format!("/api/v1/credentials/{}", key.as_str())
            }
            Self::ProviderTest(Provider::Openai) => "/api/v1/providers/openai/test".into(),
            Self::ProviderTest(Provider::Openrouter) => "/api/v1/providers/openrouter/test".into(),
            Self::ProviderTest(Provider::Ollama) => "/api/v1/providers/ollama/test".into(),
            Self::ChatSessions => "/api/v1/sessions".into(),
            Self::ChatSessionsCreate => "/api/v1/sessions".into(),
            Self::ChatSession(id) => format!("/api/v1/sessions/{id}"),
            Self::ChatSessionUpdate(id) => format!("/api/v1/sessions/{id}"),
            Self::ChatSessionDelete(id) => format!("/api/v1/sessions/{id}"),
            Self::ChatMessages(id) => format!("/api/v1/sessions/{id}/messages"),
            Self::ChatGenerations(id) => format!("/api/v1/sessions/{id}/generations"),
        }
    }
}

pub struct AgentdClient {
    data_dir: Result<PathBuf, &'static str>,
    http: Option<reqwest::Client>,
}

impl AgentdClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .ok();
        Self {
            data_dir: resolve_data_dir(),
            http,
        }
    }

    /// Construct client against host-selected app data directory. The Tauri
    /// host passes the same directory to its fixed agentd child, avoiding
    /// environment-dependent state splits in packaged builds.
    pub fn with_data_dir(data_dir: PathBuf) -> Self {
        let mut client = Self::new();
        client.data_dir = Ok(data_dir);
        client
    }

    pub async fn health(&self) -> NativeHealth {
        match self.status().await {
            Ok(status) => NativeHealth::from_status(status),
            Err(()) => NativeHealth::unavailable(),
        }
    }

    pub fn origin(&self) -> Result<String, ()> {
        Ok(self.validated_descriptor()?.origin)
    }

    /// Read the short-lived owner pairing handoff without exposing the daemon
    /// bearer secret. The file is created with private permissions by agentd;
    /// reject symlinks, oversized values and anything other than six digits.
    pub fn pairing_code(&self) -> Result<String, ()> {
        let data_dir = self.data_dir.as_ref().map_err(|_| ())?;
        let path = data_dir.join("agentd.pairing-code");
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| ())?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PAIRING_CODE_BYTES {
            return Err(());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(());
            }
        }
        let code = std::fs::read_to_string(path).map_err(|_| ())?;
        let code = code.trim();
        if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(());
        }
        Ok(code.to_owned())
    }

    pub async fn status(&self) -> Result<AgentdStatus, ()> {
        self.request(Route::Status, None).await
    }

    pub async fn continuity_preview(&self, source_root: String) -> Result<ContinuityPreview, ()> {
        let source_path = Path::new(&source_root);
        #[cfg(windows)]
        reject_reparse_path(source_path)?;
        let source = source_path.canonicalize().map_err(|_| ())?;
        #[cfg(windows)]
        let source_for_agentd = source_path.to_path_buf();
        #[cfg(not(windows))]
        let source_for_agentd = source.clone();
        if !source.is_dir() || source_root.len() > MAX_WORKSPACE_PATH_BYTES * 4 {
            return Err(());
        }
        let target = self
            .data_dir
            .as_ref()
            .map_err(|_| ())?
            .canonicalize()
            .map_err(|_| ())?;
        if source == target || source.starts_with(&target) || target.starts_with(&source) {
            return Err(());
        }
        let body = serde_json::to_vec(&serde_json::json!({ "sourceRoot": source_for_agentd }))
            .map_err(|_| ())?;
        self.request(Route::ContinuityPreview, Some(&body)).await
    }

    pub async fn continuity_import(&self, preview_id: &str) -> Result<ContinuityImport, ()> {
        if preview_id.len() != 36 {
            return Err(());
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "previewId": preview_id,
            "ownerConfirmation": "IMPORT_ELECTRON_DATA",
        }))
        .map_err(|_| ())?;
        self.request(Route::ContinuityImport, Some(&body)).await
    }

    pub async fn continuity_rollback(&self, migration_id: &str) -> Result<ContinuityRollback, ()> {
        if migration_id.len() != 36 {
            return Err(());
        }
        let body = serde_json::to_vec(&serde_json::json!({ "migrationId": migration_id }))
            .map_err(|_| ())?;
        self.request(Route::ContinuityRollback, Some(&body)).await
    }

    pub async fn settings_persona_confirm(
        &self,
        preview_id: &str,
    ) -> Result<SettingsPersonaCutover, ()> {
        if preview_id.len() != 36 {
            return Err(());
        }
        let body = serde_json::to_vec(
            &serde_json::json!({ "previewId": preview_id, "scope": "settings-persona" }),
        )
        .map_err(|_| ())?;
        self.request(Route::SettingsPersonaConfirm, Some(&body))
            .await
    }

    pub async fn settings_persona_apply(
        &self,
        preview_id: &str,
        confirmation_token: &str,
    ) -> Result<SettingsPersonaCutover, ()> {
        if preview_id.len() != 36 || confirmation_token.len() != 64 {
            return Err(());
        }
        let body = serde_json::to_vec(&serde_json::json!({ "previewId": preview_id, "confirmationToken": confirmation_token })).map_err(|_| ())?;
        self.request(Route::SettingsPersonaApply, Some(&body)).await
    }

    pub async fn settings_persona_rollback(
        &self,
        preview_id: &str,
    ) -> Result<SettingsPersonaCutover, ()> {
        if preview_id.len() != 36 {
            return Err(());
        }
        let body =
            serde_json::to_vec(&serde_json::json!({ "previewId": preview_id })).map_err(|_| ())?;
        self.request(Route::SettingsPersonaRollback, Some(&body))
            .await
    }

    pub async fn settings_persona_status(
        &self,
        preview_id: &str,
    ) -> Result<SettingsPersonaCutover, ()> {
        if preview_id.len() != 36 {
            return Err(());
        }
        self.request(Route::SettingsPersonaStatus(preview_id.to_owned()), None)
            .await
    }

    pub async fn chat_history_confirm(&self, preview_id: &str) -> Result<ChatHistoryCutover, ()> {
        if !valid_preview_id(preview_id) {
            return Err(());
        }
        let body = serde_json::to_vec(
            &serde_json::json!({ "previewId": preview_id, "scope": "chat-history" }),
        )
        .map_err(|_| ())?;
        self.request(Route::ChatHistoryConfirm, Some(&body)).await
    }

    pub async fn chat_history_apply(
        &self,
        preview_id: &str,
        confirmation_token: &str,
    ) -> Result<ChatHistoryCutover, ()> {
        if !valid_preview_id(preview_id) || !valid_confirmation_token(confirmation_token) {
            return Err(());
        }
        let body = serde_json::to_vec(&serde_json::json!({ "previewId": preview_id, "confirmationToken": confirmation_token })).map_err(|_| ())?;
        self.request(Route::ChatHistoryApply, Some(&body)).await
    }

    pub async fn chat_history_rollback(&self, preview_id: &str) -> Result<ChatHistoryCutover, ()> {
        if !valid_preview_id(preview_id) {
            return Err(());
        }
        let body =
            serde_json::to_vec(&serde_json::json!({ "previewId": preview_id })).map_err(|_| ())?;
        self.request(Route::ChatHistoryRollback, Some(&body)).await
    }

    pub async fn chat_history_status(&self, preview_id: &str) -> Result<ChatHistoryCutover, ()> {
        if !valid_preview_id(preview_id) {
            return Err(());
        }
        self.request(Route::ChatHistoryStatus(preview_id.to_owned()), None)
            .await
    }

    pub async fn credential_continuity_preview(
        &self,
        source_root: String,
    ) -> Result<CredentialContinuityPreview, ()> {
        let source = Path::new(&source_root).canonicalize().map_err(|_| ())?;
        if !source.is_dir() || source_root.len() > MAX_WORKSPACE_PATH_BYTES * 4 {
            return Err(());
        }
        let target = self
            .data_dir
            .as_ref()
            .map_err(|_| ())?
            .canonicalize()
            .map_err(|_| ())?;
        if source == target || source.starts_with(&target) || target.starts_with(&source) {
            return Err(());
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "sourceRoot": source,
            "ownerConfirmation": "INSPECT_ELECTRON_CREDENTIALS",
        }))
        .map_err(|_| ())?;
        self.request(Route::CredentialContinuityPreview, Some(&body))
            .await
    }

    pub async fn llm_settings(&self) -> Result<LlmSettings, ()> {
        self.request(Route::LlmSettingsGet, None).await
    }

    pub async fn set_llm_settings(
        &self,
        settings: LlmSettings,
    ) -> Result<LlmSettings, &'static str> {
        settings.validate()?;
        let body = serde_json::to_vec(&settings).map_err(|_| "Invalid LLM settings")?;
        self.request(Route::LlmSettingsPut, Some(&body))
            .await
            .map_err(|_| "Could not save LLM settings")
    }

    pub async fn whatsapp_settings(&self) -> Result<WhatsAppSettings, ()> {
        self.request(Route::WhatsAppSettingsGet, None).await
    }

    pub async fn set_whatsapp_settings(
        &self,
        settings: WhatsAppSettings,
    ) -> Result<WhatsAppSettings, &'static str> {
        settings.validate()?;
        let body = serde_json::to_vec(&settings).map_err(|_| "Invalid WhatsApp settings")?;
        self.request(Route::WhatsAppSettingsPut, Some(&body))
            .await
            .map_err(|_| "Could not save WhatsApp settings")
    }

    pub async fn set_credential(&self, key: &str, value: String) -> NativeResult {
        let value = Zeroizing::new(value);
        if value.is_empty() || value.len() > MAX_CREDENTIAL_BYTES {
            return NativeResult {
                success: false,
                error: Some("Invalid credential value".into()),
            };
        }
        let Ok(key) = CredentialKey::parse(key) else {
            return NativeResult {
                success: false,
                error: Some("Credential key not allowed".into()),
            };
        };
        let body = match serde_json::to_vec(&CredentialPayload {
            value: value.as_str(),
        }) {
            Ok(body) => Zeroizing::new(body),
            Err(_) => {
                return NativeResult {
                    success: false,
                    error: Some("Credential save failed".into()),
                };
            }
        };
        let result = self
            .request::<ApiSuccess>(Route::CredentialSet(key), Some(body.as_slice()))
            .await;
        match result {
            Ok(result) if result.success => NativeResult {
                success: true,
                error: None,
            },
            Ok(_) => NativeResult {
                success: false,
                error: Some("Credential save failed".into()),
            },
            Err(()) => NativeResult {
                success: false,
                error: Some("Credential save failed; agentd may be unavailable".into()),
            },
        }
    }

    pub async fn credential_exists(&self, key: &str) -> CredentialExistsResult {
        let Ok(key) = CredentialKey::parse(key) else {
            return CredentialExistsResult {
                success: false,
                exists: false,
                error: Some("Credential key not allowed".into()),
            };
        };
        match self
            .request::<CredentialPresence>(Route::CredentialGet(key), None)
            .await
        {
            Ok(result) => CredentialExistsResult {
                success: true,
                exists: result.exists,
                error: None,
            },
            Err(()) => CredentialExistsResult {
                success: false,
                exists: false,
                error: Some("Credential check failed; agentd may be unavailable".into()),
            },
        }
    }

    pub async fn delete_credential(&self, key: &str) -> NativeResult {
        let Ok(key) = CredentialKey::parse(key) else {
            return NativeResult {
                success: false,
                error: Some("Credential key not allowed".into()),
            };
        };
        match self
            .request::<ApiSuccess>(Route::CredentialDelete(key), None)
            .await
        {
            Ok(result) if result.success => NativeResult {
                success: true,
                error: None,
            },
            Ok(_) => NativeResult {
                success: false,
                error: Some("Credential delete failed".into()),
            },
            Err(()) => NativeResult {
                success: false,
                error: Some("Credential delete failed; agentd may be unavailable".into()),
            },
        }
    }

    pub async fn test_provider(&self, provider: &str) -> ProviderTestResult {
        let Ok(provider) = Provider::parse(provider) else {
            return ProviderTestResult {
                success: false,
                model_count: None,
                error: Some("Provider is not supported".into()),
            };
        };
        match self
            .request::<ProviderTestResult>(Route::ProviderTest(provider), Some(b"{}"))
            .await
        {
            Ok(result) => result,
            Err(()) => ProviderTestResult {
                success: false,
                model_count: None,
                error: Some("Provider test failed; agentd may be unavailable".into()),
            },
        }
    }

    pub async fn chat_sessions(&self) -> Result<ChatSessionsResponse, ()> {
        self.request(Route::ChatSessions, None).await
    }

    pub async fn chat_session(&self, id: &str) -> Result<ChatSessionResponse, ()> {
        if !valid_chat_id(id) {
            return Err(());
        }
        self.request(Route::ChatSession(id.to_owned()), None).await
    }

    pub async fn create_chat_session(
        &self,
        id: Option<&str>,
        title: Option<&str>,
        workspace_path: Option<&str>,
    ) -> Result<ChatSessionSummary, ()> {
        if id.is_some_and(|value| !valid_chat_id(value))
            || title.is_some_and(|value| !valid_chat_title(value))
            || workspace_path.is_some_and(|value| !valid_workspace_path(value))
        {
            return Err(());
        }
        let mut body = serde_json::Map::new();
        if let Some(id) = id {
            body.insert("id".into(), serde_json::Value::String(id.into()));
        }
        if let Some(title) = title {
            body.insert("title".into(), serde_json::Value::String(title.into()));
        }
        if let Some(workspace_path) = workspace_path {
            body.insert(
                "workspacePath".into(),
                serde_json::Value::String(workspace_path.into()),
            );
        }
        let body = serde_json::to_vec(&body).map_err(|_| ())?;
        #[derive(Deserialize)]
        struct Response {
            session: ChatSessionSummary,
        }
        Ok(self
            .request::<Response>(Route::ChatSessionsCreate, Some(body.as_slice()))
            .await?
            .session)
    }

    pub async fn update_chat_session_workspace(
        &self,
        id: &str,
        workspace_path: Option<&str>,
    ) -> Result<ChatSessionSummary, ()> {
        if !valid_chat_id(id) || workspace_path.is_some_and(|value| !valid_workspace_path(value)) {
            return Err(());
        }
        let mut body = serde_json::Map::new();
        body.insert(
            "workspacePath".into(),
            workspace_path.map_or(serde_json::Value::Null, |value| {
                serde_json::Value::String(value.into())
            }),
        );
        let body = serde_json::to_vec(&body).map_err(|_| ())?;
        #[derive(Deserialize)]
        struct Response {
            session: ChatSessionSummary,
        }
        Ok(self
            .request::<Response>(
                Route::ChatSessionUpdate(id.to_owned()),
                Some(body.as_slice()),
            )
            .await?
            .session)
    }

    pub async fn delete_chat_session(&self, id: &str) -> Result<(), ()> {
        if !valid_chat_id(id) {
            return Err(());
        }
        let result = self
            .request::<ApiSuccess>(Route::ChatSessionDelete(id.to_owned()), None)
            .await?;
        if result.success {
            Ok(())
        } else {
            Err(())
        }
    }

    pub async fn append_chat_message(
        &self,
        session_id: &str,
        message_id: Option<&str>,
        role: &str,
        content: &str,
    ) -> Result<ChatMessageResponse, ()> {
        if !valid_chat_id(session_id)
            || message_id.is_some_and(|value| !valid_chat_id(value))
            || !matches!(role, "user" | "assistant" | "system")
            || !valid_chat_content(content)
        {
            return Err(());
        }
        let mut body = serde_json::Map::new();
        if let Some(message_id) = message_id {
            body.insert("id".into(), serde_json::Value::String(message_id.into()));
        }
        body.insert("role".into(), serde_json::Value::String(role.into()));
        body.insert("content".into(), serde_json::Value::String(content.into()));
        let body = serde_json::to_vec(&body).map_err(|_| ())?;
        self.request(
            Route::ChatMessages(session_id.to_owned()),
            Some(body.as_slice()),
        )
        .await
    }

    pub async fn generate_chat(
        &self,
        session_id: &str,
        request_id: &str,
        content: &str,
        model: Option<&str>,
    ) -> Result<ChatGenerationResponse, ()> {
        if !valid_chat_id(session_id)
            || !valid_chat_id(request_id)
            || !valid_chat_content(content)
            || model.is_some_and(|value| !valid_model_name(value))
        {
            return Err(());
        }
        let mut body = serde_json::Map::new();
        body.insert(
            "requestId".into(),
            serde_json::Value::String(request_id.into()),
        );
        body.insert("content".into(), serde_json::Value::String(content.into()));
        if let Some(model) = model {
            body.insert("model".into(), serde_json::Value::String(model.into()));
        }
        let body = serde_json::to_vec(&body).map_err(|_| ())?;
        self.request(
            Route::ChatGenerations(session_id.to_owned()),
            Some(body.as_slice()),
        )
        .await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        route: Route,
        body: Option<&[u8]>,
    ) -> Result<T, ()> {
        let descriptor = self.validated_descriptor()?;
        let secret = Zeroizing::new(
            Entry::new(KEYCHAIN_SERVICE, BEARER_KEY)
                .map_err(|_| ())?
                .get_password()
                .map_err(|_| ())?,
        );
        self.request_with_descriptor(route, body, &secret, descriptor)
            .await
    }

    #[cfg(test)]
    async fn request_with_secret<T: DeserializeOwned>(
        &self,
        route: Route,
        body: Option<&[u8]>,
        secret: &str,
    ) -> Result<T, ()> {
        let descriptor = self.validated_descriptor()?;
        self.request_with_descriptor(route, body, secret, descriptor)
            .await
    }

    fn validated_descriptor(&self) -> Result<RuntimeDescriptor, ()> {
        let data_dir = self.data_dir.as_ref().map_err(|_| ())?;
        let descriptor = read_descriptor(&data_dir.join("agentd.runtime.json"))?;
        if !process_identity_matches_descriptor(&descriptor) {
            return Err(());
        }
        Ok(descriptor)
    }

    async fn request_with_descriptor<T: DeserializeOwned>(
        &self,
        route: Route,
        body: Option<&[u8]>,
        secret: &str,
        descriptor: RuntimeDescriptor,
    ) -> Result<T, ()> {
        let current = self.validated_descriptor()?;
        if current.pid != descriptor.pid
            || current.started_at != descriptor.started_at
            || current.process_started_at != descriptor.process_started_at
            || current.runtime_id != descriptor.runtime_id
            || current.origin != descriptor.origin
        {
            return Err(());
        }
        let http = self.http.as_ref().ok_or(())?;
        if secret.len() < 32 || secret.len() > 256 {
            return Err(());
        }
        let authorization = Zeroizing::new(format!("Bearer {secret}"));
        let mut auth_value = HeaderValue::from_str(&authorization).map_err(|_| ())?;
        auth_value.set_sensitive(true);

        let mut request = http
            .request(
                route.clone().method(),
                format!("{}{}", descriptor.origin, route.path()),
            )
            .header(AUTHORIZATION, auth_value);
        if let Some(body) = body {
            request = request
                .header(CONTENT_TYPE, "application/json")
                .body(body.to_vec());
        }
        let mut response = request.send().await.map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let mut bytes = Vec::new();
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(());
        }
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ())
    }
}

impl Default for AgentdClient {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
struct CredentialPayload<'a> {
    value: &'a str,
}

#[derive(Deserialize)]
struct ApiSuccess {
    success: bool,
}

#[derive(Deserialize)]
struct CredentialPresence {
    exists: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::SystemTime,
    };

    fn descriptor(origin: &str) -> String {
        format!(
            r#"{{"protocolVersion":1,"pid":42,"origin":"{origin}","startedAt":1726444800000,"processStartedAt":1726444799000,"runtimeId":"test-runtime"}}"#
        )
    }

    #[test]
    fn descriptor_accepts_only_private_protocol_v1_loopback_origins() {
        let valid = descriptor("http://127.0.0.1:12345");
        assert!(RuntimeDescriptor::parse(valid.as_bytes()).is_ok());
        for invalid in [
            "http://localhost:12345",
            "http://127.0.0.2:12345",
            "https://127.0.0.1:12345",
            "http://127.0.0.1",
            "http://127.0.0.1:12345/path",
            "http://127.0.0.1:12345/",
            "http://user@127.0.0.1:12345",
        ] {
            assert!(
                RuntimeDescriptor::parse(descriptor(invalid).as_bytes()).is_err(),
                "{invalid}"
            );
        }
        assert!(RuntimeDescriptor::parse(b"{}").is_err());
        assert!(RuntimeDescriptor::parse(
            valid
                .replace("\"protocolVersion\":1", "\"protocolVersion\":2")
                .as_bytes()
        )
        .is_err());
        assert!(RuntimeDescriptor::parse(&vec![b'x'; MAX_DESCRIPTOR_BYTES as usize + 1]).is_err());
    }

    #[test]
    fn pairing_code_is_bounded_and_numeric() {
        let data_dir = env::temp_dir().join(format!("aica-agentd-pairing-{}", std::process::id()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let path = data_dir.join("agentd.pairing-code");
        std::fs::write(&path, "123456\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let client = AgentdClient {
            data_dir: Ok(data_dir.clone()),
            http: None,
        };
        assert_eq!(client.pairing_code().unwrap(), "123456");
        std::fs::write(&path, "abcdef\n").unwrap();
        assert!(client.pairing_code().is_err());
        std::fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn api_routes_are_fixed_and_credentials_are_allowlisted() {
        assert!(valid_preview_id("12345678-1234-1234-1234-123456789012"));
        assert!(!valid_preview_id("not-a-preview-id"));
        assert!(valid_confirmation_token(&"a".repeat(64)));
        assert!(!valid_confirmation_token("not-a-token"));
        assert_eq!(Route::Status.path(), "/api/v1/status");
        assert_eq!(Route::LlmSettingsPut.path(), "/api/v1/settings/llm");
        assert_eq!(
            Route::WhatsAppSettingsGet.path(),
            "/api/v1/settings/whatsapp"
        );
        assert_eq!(Route::WhatsAppSettingsPut.method(), Method::PUT);
        assert_eq!(
            Route::ProviderTest(Provider::Openai).path(),
            "/api/v1/providers/openai/test"
        );
        assert_eq!(
            Route::ProviderTest(Provider::Openrouter).path(),
            "/api/v1/providers/openrouter/test"
        );
        assert_eq!(
            Route::ProviderTest(Provider::Ollama).path(),
            "/api/v1/providers/ollama/test"
        );
        assert!(Provider::parse("ollama").is_ok());
        assert_eq!(Route::ChatSessions.method(), Method::GET);
        assert_eq!(Route::ChatSessionsCreate.method(), Method::POST);
        assert_eq!(
            Route::ChatSessionDelete("s1".into()).method(),
            Method::DELETE
        );
        assert_eq!(
            Route::ChatSessionDelete("s1".into()).path(),
            "/api/v1/sessions/s1"
        );
        assert_eq!(Route::ChatSessionsCreate.path(), "/api/v1/sessions");
        assert_eq!(
            Route::ChatMessages("s1".into()).path(),
            "/api/v1/sessions/s1/messages"
        );
        assert_eq!(
            Route::ChatGenerations("s1".into()).path(),
            "/api/v1/sessions/s1/generations"
        );
        assert_eq!(Route::ChatGenerations("s1".into()).method(), Method::POST);
        assert_eq!(Route::ChatHistoryConfirm.method(), Method::POST);
        assert_eq!(Route::ChatHistoryApply.method(), Method::POST);
        assert_eq!(Route::ChatHistoryRollback.method(), Method::POST);
        assert_eq!(Route::CredentialContinuityPreview.method(), Method::POST);
        assert_eq!(
            Route::CredentialContinuityPreview.path(),
            "/api/v1/continuity/credentials/preview"
        );
        assert_eq!(
            Route::ChatHistoryStatus("12345678-1234-1234-1234-123456789012".into()).path(),
            "/api/v1/continuity/chat-history/status?previewId=12345678-1234-1234-1234-123456789012"
        );
        assert!(CredentialKey::parse("openai_api_key").is_ok());
        assert!(CredentialKey::parse("openrouter_api_key").is_ok());
        assert!(CredentialKey::parse("whatsapp_cloud_access_token").is_ok());
        assert!(CredentialKey::parse("whatsapp_cloud_app_secret").is_ok());
        assert!(CredentialKey::parse("whatsapp_cloud_verify_token").is_ok());
        for later_slice_key in [
            "gemini_api_key",
            "email_imap_password",
            "gmail_oauth_client_id",
        ] {
            assert!(CredentialKey::parse(later_slice_key).is_err());
        }
        assert!(CredentialKey::parse("arbitrary").is_err());
        assert!(Provider::parse("custom").is_err());
    }

    #[test]
    fn whatsapp_settings_are_bounded_and_exactly_allowlisted() {
        let valid = WhatsAppSettings {
            whatsapp_transport: "cloud".into(),
            whatsapp_cloud_phone_number_id: "123".into(),
            whatsapp_cloud_api_version: "v23.0".into(),
        };
        assert!(valid.validate().is_ok());
        assert!(WhatsAppSettings {
            whatsapp_transport: "custom".into(),
            ..valid.clone()
        }
        .validate()
        .is_err());
        assert!(WhatsAppSettings {
            whatsapp_cloud_api_version: String::new(),
            ..valid.clone()
        }
        .validate()
        .is_err());
        assert!(WhatsAppSettings {
            whatsapp_cloud_phone_number_id: "x".repeat(129),
            ..valid
        }
        .validate()
        .is_err());
    }

    #[test]
    fn data_directory_matches_agentd_environment_precedence() {
        assert_eq!(
            resolve_data_dir_from(
                Some("/custom/state"),
                Some("/xdg"),
                None,
                Some("/home/user")
            )
            .unwrap(),
            PathBuf::from("/custom/state")
        );
        assert_eq!(
            resolve_data_dir_from(None, Some("/xdg"), None, Some("/home/user")).unwrap(),
            PathBuf::from("/xdg/aica")
        );
        assert_eq!(
            resolve_data_dir_from(None, None, None, Some("/home/user")).unwrap(),
            PathBuf::from("/home/user/.local/state/aica")
        );
        assert!(resolve_data_dir_from(None, None, None, None).is_err());
        #[cfg(windows)]
        assert_eq!(
            resolve_data_dir_from(
                None,
                Some("/xdg"),
                Some("C:\\Users\\me\\AppData\\Local"),
                Some("C:\\Users\\me")
            )
            .unwrap(),
            PathBuf::from("C:\\Users\\me\\AppData\\Local\\aica")
        );
    }

    #[test]
    fn settings_require_non_empty_bounded_model_names() {
        assert!(LlmSettings::default().validate().is_ok());
        let mut invalid = LlmSettings::default();
        invalid.openai_model = " ".into();
        assert!(invalid.validate().is_err());
        invalid.openai_model = "m".repeat(129);
        assert!(invalid.validate().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn client_smokes_typed_settings_credentials_and_provider_routes_without_real_keychain() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let data_dir = env::temp_dir().join(format!(
            "aica-agentd-client-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&data_dir).unwrap();
        let descriptor = format!(
            r#"{{"protocolVersion":1,"pid":{},"origin":"http://127.0.0.1:{port}","startedAt":1726444800000,"processStartedAt":{},"runtimeId":"smoke-test"}}"#,
            std::process::id(),
            process_started_at_ms(std::process::id()).unwrap()
        );
        let descriptor_path = data_dir.join("agentd.runtime.json");
        std::fs::write(&descriptor_path, descriptor).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }

        let server = thread::spawn(move || {
            let responses = [
                (
                    "GET /api/v1/status",
                    "",
                    r#"{"runtime":"agentd","paused":false,"queueDepth":1,"events":3}"#,
                ),
                (
                    "GET /api/v1/settings/llm",
                    "",
                    r#"{"preferredProvider":"auto","openaiModel":"gpt-4o-mini","openrouterModel":"anthropic/claude-3-haiku"}"#,
                ),
                (
                    "PUT /api/v1/settings/llm",
                    r#"{"preferredProvider":"openrouter","openaiModel":"gpt-4.1-mini","openrouterModel":"openai/gpt-4o-mini"}"#,
                    r#"{"preferredProvider":"openrouter","openaiModel":"gpt-4.1-mini","openrouterModel":"openai/gpt-4o-mini"}"#,
                ),
                (
                    "GET /api/v1/settings/llm",
                    "",
                    r#"{"preferredProvider":"openrouter","openaiModel":"gpt-4.1-mini","openrouterModel":"openai/gpt-4o-mini"}"#,
                ),
                (
                    "POST /api/v1/credentials/openai_api_key",
                    r#"{"value":"test-provider-secret-not-real"}"#,
                    r#"{"success":true}"#,
                ),
                (
                    "GET /api/v1/credentials/openai_api_key",
                    "",
                    r#"{"success":true,"exists":true}"#,
                ),
                (
                    "DELETE /api/v1/credentials/openai_api_key",
                    "",
                    r#"{"success":true}"#,
                ),
                (
                    "POST /api/v1/providers/openai/test",
                    "{}",
                    r#"{"success":true,"modelCount":2}"#,
                ),
            ];
            for (expected_line, expected_body, response_body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut headers = Vec::new();
                let mut byte = [0_u8; 1];
                while !headers.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                }
                let headers_text = String::from_utf8(headers).unwrap();
                let first_line = headers_text.lines().next().unwrap();
                assert!(first_line.starts_with(expected_line), "{first_line}");
                assert!(headers_text.to_ascii_lowercase().contains(
                    "authorization: bearer test-secret-not-real-000000000000000000000000"
                ));
                let content_length = headers_text
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut request_body = vec![0_u8; content_length];
                stream.read_exact(&mut request_body).unwrap();
                assert_eq!(String::from_utf8(request_body).unwrap(), expected_body);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .unwrap();
            }
        });

        let client = AgentdClient {
            data_dir: Ok(data_dir.clone()),
            http: Some(
                reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap(),
            ),
        };
        let secret = "test-secret-not-real-000000000000000000000000";
        let status = tauri::async_runtime::block_on(client.request_with_secret::<AgentdStatus>(
            Route::Status,
            None,
            secret,
        ))
        .unwrap();
        assert_eq!(status.runtime, "agentd");
        assert_eq!(status.queue_depth, 1);
        let defaults = tauri::async_runtime::block_on(client.request_with_secret::<LlmSettings>(
            Route::LlmSettingsGet,
            None,
            secret,
        ))
        .unwrap();
        assert_eq!(defaults, LlmSettings::default());
        let settings = LlmSettings {
            preferred_provider: PreferredProvider::Openrouter,
            openai_model: "gpt-4.1-mini".into(),
            openrouter_model: "openai/gpt-4o-mini".into(),
        };
        let settings_body = serde_json::to_vec(&settings).unwrap();
        let saved = tauri::async_runtime::block_on(client.request_with_secret::<LlmSettings>(
            Route::LlmSettingsPut,
            Some(&settings_body),
            secret,
        ))
        .unwrap();
        assert_eq!(saved, settings);
        let persisted = tauri::async_runtime::block_on(client.request_with_secret::<LlmSettings>(
            Route::LlmSettingsGet,
            None,
            secret,
        ))
        .unwrap();
        assert_eq!(persisted, settings);
        let credential_body = br#"{"value":"test-provider-secret-not-real"}"#;
        let set = tauri::async_runtime::block_on(client.request_with_secret::<ApiSuccess>(
            Route::CredentialSet(CredentialKey::Openai),
            Some(credential_body),
            secret,
        ))
        .unwrap();
        assert!(set.success);
        let exists =
            tauri::async_runtime::block_on(client.request_with_secret::<CredentialPresence>(
                Route::CredentialGet(CredentialKey::Openai),
                None,
                secret,
            ))
            .unwrap();
        assert!(exists.exists);
        let deleted = tauri::async_runtime::block_on(client.request_with_secret::<ApiSuccess>(
            Route::CredentialDelete(CredentialKey::Openai),
            None,
            secret,
        ))
        .unwrap();
        assert!(deleted.success);
        let provider_test =
            tauri::async_runtime::block_on(client.request_with_secret::<ProviderTestResult>(
                Route::ProviderTest(Provider::Openai),
                Some(b"{}"),
                secret,
            ))
            .unwrap();
        assert!(provider_test.success);
        assert_eq!(provider_test.model_count, Some(2));
        server.join().unwrap();
        std::fs::remove_dir_all(data_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stale_or_foreign_pid_never_receives_bearer_or_credential_body() {
        fn attempt(pid: u32) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let data_dir = env::temp_dir().join(format!(
                "aica-agentd-untrusted-pid-{}-{pid}",
                std::process::id()
            ));
            std::fs::create_dir(&data_dir).unwrap();
            let descriptor = format!(
                r#"{{"protocolVersion":1,"pid":{pid},"origin":"http://127.0.0.1:{port}","startedAt":1726444800000,"processStartedAt":1726444799000,"runtimeId":"untrusted-test"}}"#
            );
            let descriptor_path = data_dir.join("agentd.runtime.json");
            std::fs::write(&descriptor_path, descriptor).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600))
                .unwrap();

            let client = AgentdClient {
                data_dir: Ok(data_dir.clone()),
                http: Some(reqwest::Client::builder().no_proxy().build().unwrap()),
            };
            let credential_body = br#"{"value":"must-not-reach-listener"}"#;
            let result = tauri::async_runtime::block_on(client.request_with_secret::<ApiSuccess>(
                Route::CredentialSet(CredentialKey::Openai),
                Some(credential_body),
                "test-secret-not-real-000000000000000000000000",
            ));
            assert!(result.is_err());
            assert!(matches!(
                listener.accept(),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
            ));
            std::fs::remove_dir_all(data_dir).unwrap();
        }

        // Outside the OS PID range, so it cannot be a live owner after a daemon crash.
        attempt(u32::MAX);

        let current_uid = unsafe { libc::geteuid() };
        let foreign_pid = Command::new("/bin/ps")
            .args(["-axo", "pid=,uid="])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|stdout| {
                stdout.lines().find_map(|line| {
                    let mut fields = line.split_whitespace();
                    let pid = fields.next()?.parse::<u32>().ok()?;
                    let uid = fields.next()?.parse::<libc::uid_t>().ok()?;
                    (uid != current_uid && fields.next().is_none()).then_some(pid)
                })
            });
        if let Some(pid) = foreign_pid {
            attempt(pid);
        }
    }

    #[cfg(unix)]
    #[test]
    fn live_same_user_pid_with_stale_process_identity_never_receives_bearer() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let child_pid = child.id();
        let child_started_at = process_started_at_ms(child_pid).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let data_dir = env::temp_dir().join(format!(
            "aica-agentd-live-stale-pid-{}-{child_pid}",
            std::process::id()
        ));
        std::fs::create_dir(&data_dir).unwrap();
        let descriptor = format!(
            r#"{{"protocolVersion":1,"pid":{child_pid},"origin":"http://127.0.0.1:{port}","startedAt":1726444800000,"processStartedAt":{},"runtimeId":"stale-test"}}"#,
            child_started_at.saturating_sub(60_000)
        );
        let descriptor_path = data_dir.join("agentd.runtime.json");
        std::fs::write(&descriptor_path, descriptor).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let client = AgentdClient {
            data_dir: Ok(data_dir.clone()),
            http: Some(reqwest::Client::builder().no_proxy().build().unwrap()),
        };
        let result = tauri::async_runtime::block_on(client.request_with_secret::<ApiSuccess>(
            Route::CredentialSet(CredentialKey::Openai),
            Some(br#"{"value":"must-not-reach-listener"}"#),
            "test-secret-not-real-000000000000000000000000",
        ));
        assert!(result.is_err());
        assert!(matches!(
            listener.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));

        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(data_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn changed_process_identity_snapshot_is_rejected_before_bearer() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let data_dir = env::temp_dir().join(format!(
            "aica-agentd-replaced-descriptor-{}",
            std::process::id()
        ));
        std::fs::create_dir(&data_dir).unwrap();
        let process_started_at = process_started_at_ms(std::process::id()).unwrap();
        let descriptor = format!(
            r#"{{"protocolVersion":1,"pid":{},"origin":"http://127.0.0.1:{port}","startedAt":1726444800000,"processStartedAt":{process_started_at},"runtimeId":"replacement-test"}}"#,
            std::process::id()
        );
        let descriptor_path = data_dir.join("agentd.runtime.json");
        std::fs::write(&descriptor_path, descriptor).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let client = AgentdClient {
            data_dir: Ok(data_dir.clone()),
            http: Some(reqwest::Client::builder().no_proxy().build().unwrap()),
        };
        let mut replaced = read_descriptor(&descriptor_path).unwrap();
        replaced.process_started_at = replaced.process_started_at.saturating_add(60_000);
        let result = tauri::async_runtime::block_on(client.request_with_descriptor::<ApiSuccess>(
            Route::CredentialSet(CredentialKey::Openai),
            Some(br#"{"value":"must-not-reach-listener"}"#),
            "test-secret-not-real-000000000000000000000000",
            replaced,
        ));
        assert!(result.is_err());
        assert!(matches!(
            listener.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
        std::fs::remove_dir_all(data_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_rejects_group_or_world_access() {
        use std::os::unix::fs::PermissionsExt;
        let path = env::temp_dir().join(format!("aica-agentd-descriptor-{}", std::process::id()));
        std::fs::write(&path, descriptor("http://127.0.0.1:12345")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_descriptor(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
