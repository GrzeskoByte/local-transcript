//! Spawning external programs (curl, xdg-open, voxtype, opencode, …).
//!
//! Inside an AppImage the launcher (AppRun + linuxdeploy's GTK hook) points
//! `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS`, GIO/GTK module paths and more at
//! the libraries bundled in the image (built on Ubuntu 22.04). Every child
//! process inherits that, so the HOST's `curl` ends up loading the bundled
//! `libnghttp2`/`libidn2`/krb5 and dies with
//! `symbol lookup error: … undefined symbol: nghttp2_option_set_no_rfc9113_…`,
//! and `gio`/`xdg-open` die the same way. That broke calendar sync, model
//! downloads and opening links on every distro newer than Ubuntu 22.04.
//!
//! [`command`] is a drop-in for `Command::new` that gives children the host's
//! own environment back: AppImage entries are stripped from path lists (the
//! user's original values, which AppRun appends, survive) and the variables
//! the image injected are removed. Outside an AppImage it is `Command::new`.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Colon-separated search paths that AppRun / the GTK hook prefix with APPDIR.
const PATH_LISTS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "GI_TYPELIB_PATH",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
];

/// Variables the image sets outright (removed when they point into APPDIR).
const INJECTED: &[&str] = &[
    "PYTHONHOME",
    "GIO_MODULE_DIR",
    "GSETTINGS_SCHEMA_DIR",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GST_PLUGIN_SCANNER",
];

/// Set unconditionally by the image, whatever their value (a forced Adwaita
/// theme / Python flag should not leak into the user's other apps).
const ALWAYS_REMOVE: &[&str] = &["GTK_THEME", "PYTHONDONTWRITEBYTECODE"];

/// `Command::new`, minus the AppImage's library environment.
pub fn command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    if let Some(appdir) = appimage_dir() {
        for (key, value) in host_env_changes(std::env::vars_os(), &appdir) {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
    }
    cmd
}

/// APPDIR, only when this process really runs from it (a stray APPDIR set
/// by the user's shell must not change anything).
fn appimage_dir() -> Option<PathBuf> {
    if cfg!(not(target_os = "linux")) {
        return None;
    }
    let appdir = PathBuf::from(std::env::var_os("APPDIR")?);
    let exe = std::env::current_exe().ok()?;
    exe.starts_with(&appdir).then_some(appdir)
}

/// The edits that turn the AppImage environment back into the host's:
/// `Some(v)` = set to `v`, `None` = remove. Pure, for testing.
pub fn host_env_changes(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    appdir: &Path,
) -> Vec<(OsString, Option<OsString>)> {
    let inside = |p: &Path| p.starts_with(appdir);
    let mut out = Vec::new();
    for (key, value) in vars {
        let name = key.to_string_lossy();
        if PATH_LISTS.contains(&name.as_ref()) {
            let kept: Vec<PathBuf> = std::env::split_paths(&value)
                .filter(|p| !p.as_os_str().is_empty() && !inside(p))
                .collect();
            let changed = std::env::split_paths(&value).any(|p| p.as_os_str().is_empty() || inside(&p));
            if !changed {
                continue;
            }
            if kept.is_empty() {
                out.push((key, None));
            } else if let Ok(joined) = std::env::join_paths(kept) {
                out.push((key, Some(joined)));
            }
        } else if INJECTED.contains(&name.as_ref()) {
            if inside(Path::new(&value)) {
                out.push((key, None));
            }
        } else if ALWAYS_REMOVE.contains(&name.as_ref()) {
            out.push((key, None));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    fn changes(pairs: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        host_env_changes(env(pairs), Path::new("/tmp/.mount_LocalT"))
            .into_iter()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
            .collect()
    }

    #[test]
    fn strips_bundled_library_dirs_and_keeps_the_users_own() {
        // AppRun prepends its dirs and appends the original value.
        let c = changes(&[(
            "LD_LIBRARY_PATH",
            "/tmp/.mount_LocalT/usr/lib/:/tmp/.mount_LocalT/lib/x86_64-linux-gnu/:/opt/cuda/lib64",
        )]);
        assert_eq!(c, vec![("LD_LIBRARY_PATH".into(), Some("/opt/cuda/lib64".into()))]);
    }

    #[test]
    fn removes_library_path_entirely_when_only_appimage_dirs_were_set() {
        let c = changes(&[("LD_LIBRARY_PATH", "/tmp/.mount_LocalT/usr/lib/:/tmp/.mount_LocalT/lib/:")]);
        assert_eq!(c, vec![("LD_LIBRARY_PATH".into(), None)]);
    }

    #[test]
    fn restores_path_and_xdg_data_dirs() {
        let c = changes(&[
            ("PATH", "/tmp/.mount_LocalT/usr/bin/:/tmp/.mount_LocalT/usr/sbin/:/usr/local/bin:/usr/bin"),
            ("XDG_DATA_DIRS", "/tmp/.mount_LocalT/usr/share:/usr/share:"),
        ]);
        assert!(c.contains(&("PATH".into(), Some("/usr/local/bin:/usr/bin".into()))));
        assert!(c.contains(&("XDG_DATA_DIRS".into(), Some("/usr/share".into()))));
    }

    #[test]
    fn removes_injected_gtk_gio_python_variables() {
        let c = changes(&[
            ("GIO_MODULE_DIR", "/tmp/.mount_LocalT//usr/lib/gio/modules"),
            ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_LocalT//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
            ("PYTHONHOME", "/tmp/.mount_LocalT/usr/"),
            ("GTK_THEME", "Adwaita:dark"),
        ]);
        assert_eq!(c.len(), 4);
        assert!(c.iter().all(|(_, v)| v.is_none()));
    }

    #[test]
    fn leaves_unrelated_and_user_owned_variables_alone() {
        let c = changes(&[
            ("HOME", "/home/me"),
            ("PATH", "/usr/local/bin:/usr/bin"),
            ("GIO_MODULE_DIR", "/usr/lib/gio/modules"),
            ("HTTPS_PROXY", "http://proxy:3128"),
        ]);
        assert!(c.is_empty());
    }
}
