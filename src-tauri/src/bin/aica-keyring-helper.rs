use std::io::{self, Read, Write};
use std::process::ExitCode;

use keyring::{Entry, Error as KeyringError};
use zeroize::Zeroize;

const SERVICE: &str = "com.aica.wacopilot";
const MAX_SECRET_BYTES: u64 = 64 * 1024;
const MAX_UID_BYTES: usize = 128;
const PRODUCT_SECRET_KEYS: &[&str] = &[
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
const AGENTD_BEARER_KEY: &str = "agentd_bearer_secret";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Operation {
    Get,
    Exists,
    Set,
    Delete,
}

fn parse_request(args: &[String]) -> Result<(Operation, &str), ()> {
    if args.len() != 2 || !key_allowed(&args[1]) {
        return Err(());
    }
    let operation = match args[0].as_str() {
        "get" => Operation::Get,
        "exists" => Operation::Exists,
        "set" => Operation::Set,
        "delete" => Operation::Delete,
        _ => return Err(()),
    };
    Ok((operation, &args[1]))
}

fn key_allowed(key: &str) -> bool {
    if key == AGENTD_BEARER_KEY || PRODUCT_SECRET_KEYS.contains(&key) {
        return true;
    }

    let Some(scoped_key) = key.strip_prefix("user_") else {
        return false;
    };
    PRODUCT_SECRET_KEYS.iter().any(|allowed_key| {
        scoped_key
            .strip_suffix(allowed_key)
            .and_then(|uid_with_separator| uid_with_separator.strip_suffix('_'))
            .is_some_and(valid_uid)
    })
}

fn valid_uid(uid: &str) -> bool {
    !uid.is_empty()
        && uid.len() <= MAX_UID_BYTES
        && uid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn read_secret<R: Read>(reader: R) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(MAX_SECRET_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_SECRET_BYTES {
        bytes.zeroize();
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid secret",
        ));
    }
    Ok(bytes)
}

fn entry(key: &str) -> Result<Entry, ()> {
    if !key_allowed(key) {
        return Err(());
    }
    Entry::new(SERVICE, key).map_err(|_| ())
}

fn run(operation: Operation, key: &str) -> Result<(), ExitCode> {
    let entry = entry(key).map_err(|_| fail("credential store unavailable"))?;
    match operation {
        Operation::Get => match entry.get_secret() {
            Ok(mut secret) => {
                if secret.len() as u64 > MAX_SECRET_BYTES {
                    secret.zeroize();
                    return Err(fail("credential operation failed"));
                }
                let result = io::stdout().lock().write_all(&secret);
                secret.zeroize();
                result.map_err(|_| fail("credential operation failed"))
            }
            Err(KeyringError::NoEntry) => Err(ExitCode::from(2)),
            Err(_) => Err(fail("credential operation failed")),
        },
        Operation::Exists => match entry.get_secret() {
            Ok(mut secret) => {
                if secret.len() as u64 > MAX_SECRET_BYTES {
                    secret.zeroize();
                    return Err(fail("credential operation failed"));
                }
                secret.zeroize();
                io::stdout()
                    .lock()
                    .write_all(b"true\n")
                    .map_err(|_| fail("credential operation failed"))
            }
            Err(KeyringError::NoEntry) => io::stdout()
                .lock()
                .write_all(b"false\n")
                .map_err(|_| fail("credential operation failed")),
            Err(_) => Err(fail("credential operation failed")),
        },
        Operation::Set => {
            let mut secret =
                read_secret(io::stdin().lock()).map_err(|_| fail("invalid credential input"))?;
            let result = entry.set_secret(&secret);
            secret.zeroize();
            result.map_err(|_| fail("credential operation failed"))
        }
        Operation::Delete => match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(fail("credential operation failed")),
        },
    }
}

fn fail(message: &str) -> ExitCode {
    let _ = writeln!(io::stderr().lock(), "aica-keyring-helper: {message}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let (operation, key) = match parse_request(&args) {
        Ok(request) => request,
        Err(()) => return fail("invalid request"),
    };
    match run(operation, key) {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn allowlist_contains_product_secrets_and_daemon_secret_only() {
        assert!(key_allowed("openai_api_key"));
        assert!(key_allowed("whatsapp_cloud_verify_token"));
        assert!(key_allowed("agentd_bearer_secret"));
        assert!(key_allowed("user_501_openai_api_key"));
        assert!(key_allowed(
            "user_meharaj-01_team_2_whatsapp_cloud_verify_token"
        ));
        assert!(key_allowed(&format!(
            "user_{}_openai_api_key",
            "u".repeat(MAX_UID_BYTES)
        )));
        assert!(!key_allowed("unknown"));
        assert!(!key_allowed("user__openai_api_key"));
        assert!(!key_allowed("user_bad!uid_openai_api_key"));
        assert!(!key_allowed(&format!(
            "user_{}_openai_api_key",
            "u".repeat(MAX_UID_BYTES + 1)
        )));
        assert!(!key_allowed("user_501_unknown"));
        assert!(!key_allowed("user_501_agentd_bearer_secret"));
        assert!(!key_allowed("user_501openai_api_key"));
        assert!(!key_allowed(""));
    }

    #[test]
    fn request_parser_accepts_only_fixed_operations_and_keys() {
        assert_eq!(
            parse_request(&["set".into(), "openai_api_key".into()]),
            Ok((Operation::Set, "openai_api_key"))
        );
        assert!(parse_request(&["exec".into(), "openai_api_key".into()]).is_err());
        assert!(parse_request(&["get".into(), "unknown".into()]).is_err());
        assert!(parse_request(&["get".into(), "openai_api_key".into(), "secret".into()]).is_err());
    }

    #[test]
    fn stdin_secret_is_exact_and_bounded() {
        assert_eq!(
            read_secret(Cursor::new(b"secret\0bytes".to_vec())).unwrap(),
            b"secret\0bytes"
        );
        assert!(read_secret(Cursor::new(Vec::new())).is_err());
        assert!(read_secret(Cursor::new(vec![b'x'; MAX_SECRET_BYTES as usize + 1])).is_err());
    }
}
