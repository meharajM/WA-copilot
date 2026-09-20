use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
use std::process::ExitCode;

const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;

fn parse_args(args: &[String]) -> Result<(&Path, u64), ()> {
    if !(1..=2).contains(&args.len()) {
        return Err(());
    }
    let path = Path::new(&args[0]);
    if !path.is_absolute() {
        return Err(());
    }
    let max_bytes = args
        .get(1)
        .map(|value| value.parse::<u64>().map_err(|_| ()))
        .transpose()?
        .unwrap_or(DEFAULT_MAX_BYTES);
    if max_bytes == 0 || max_bytes > DEFAULT_MAX_BYTES {
        return Err(());
    }
    Ok((path, max_bytes))
}

#[cfg(unix)]
fn open_readonly(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn open_windows_directory(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let file = OpenOptions::new()
        .read(true)
        // Keep directory parents alive and non-deletable while the final file
        // is opened. This prevents a reparse/rename swap between checks.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "reparse directory",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_readonly(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "absolute path required",
        ));
    }

    // Validate and hold every parent directory with OPEN_REPARSE_POINT. The
    // parent handles disallow delete/rename while the final handle is opened.
    let mut parents = Vec::<File>::new();
    let mut current = path.parent();
    let mut directories = Vec::<PathBuf>::new();
    while let Some(directory) = current {
        directories.push(directory.to_path_buf());
        let parent = directory.parent();
        if parent == Some(directory) {
            break;
        }
        current = parent;
    }
    directories.reverse();
    for directory in directories {
        if !directory.as_os_str().is_empty() {
            parents.push(open_windows_directory(&directory)?);
        }
    }
    let _parents = parents;

    let file = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "reparse file"));
    }
    Ok(file)
}

#[cfg(all(not(unix), not(windows)))]
fn open_readonly(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn read_file(path: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let mut file = open_readonly(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid migration file",
        ));
    }
    if metadata.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "migration file too large",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "migration file too large",
        ));
    }
    Ok(bytes)
}

fn fail(message: &str) -> ExitCode {
    let _ = writeln!(io::stderr().lock(), "aica-migration-reader: {message}");
    ExitCode::FAILURE
}

fn fail_code(message: &str, code: u8) -> ExitCode {
    let _ = writeln!(io::stderr().lock(), "aica-migration-reader: {message}");
    ExitCode::from(code)
}

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let (path, max_bytes) = match parse_args(&args) {
        Ok(value) => value,
        Err(()) => return fail("invalid request"),
    };
    match read_file(path, max_bytes) {
        Ok(bytes) => io::stdout()
            .lock()
            .write_all(&bytes)
            .map_or_else(|_| fail("write failed"), |_| ExitCode::SUCCESS),
        Err(error) if error.to_string() == "migration file too large" => {
            fail_code("migration file too large", 3)
        }
        Err(_) => fail("migration file unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_requires_absolute_bounded_path_and_size() {
        assert!(parse_args(&["relative".into()]).is_err());
        let absolute_path = if cfg!(windows) {
            r"C:\aica\migration.json"
        } else {
            "/tmp/file"
        };
        assert!(parse_args(&[absolute_path.into(), "0".into()]).is_err());
        assert!(parse_args(&[absolute_path.into(), (DEFAULT_MAX_BYTES + 1).to_string()]).is_err());
        assert_eq!(
            parse_args(&[absolute_path.into()]).unwrap().1,
            DEFAULT_MAX_BYTES
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_rejects_symlink_final_component() {
        let root =
            std::env::temp_dir().join(format!("aica-migration-reader-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("real"), b"safe").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        assert!(read_file(&root.join("link"), 16).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
