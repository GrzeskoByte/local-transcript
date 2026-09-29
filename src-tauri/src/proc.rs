//! Spawning external programs (curl, whisper-cli, voxtype, opencode, xdg-open…).
//!
//! Inside an AppImage the AppRun sets `LD_LIBRARY_PATH` (and GTK/GIO/GStreamer
//! module paths) to the libraries bundled in `$APPDIR` — built on Ubuntu 22.04.
//! A child such as the system `curl` inherits them and then loads the host's
//! newer `libcurl` against the bundle's older `libnghttp2`, dying with
//! `symbol lookup error: … undefined symbol: nghttp2_option_set_no_rfc9113…`.
//! `command()` strips every `$APPDIR` entry from those variables so children
//! run with the host's own libraries. Outside an AppImage it is `Command::new`.

use std::ffi::OsStr;
use std::process::Command;

/// Path-list variables an AppImage may point into `$APPDIR`.
const PATH_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PATH",
    "XDG_DATA_DIRS",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GSETTINGS_SCHEMA_DIR",
    "GI_TYPELIB_PATH",
    "GST_PLUGIN_PATH",
    "GST_PLUGIN_PATH_1_0",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_SCANNER",
    "GST_PLUGIN_SCANNER_1_0",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
];

/// What to do with one variable for a child process.
#[derive(Debug, PartialEq)]
pub enum EnvChange {
    Set(String, String),
    Remove(String),
}

/// Changes that drop `$APPDIR` entries from the path-list variables in `vars`.
/// Pure (tested below); `appdir` is the AppImage mount point.
pub fn appimage_env_changes(vars: &[(String, String)], appdir: &str) -> Vec<EnvChange> {
    let root = appdir.trim_end_matches('/');
    if root.is_empty() {
        return Vec::new();
    }
    let inside = |p: &str| p == root || p.starts_with(&format!("{root}/"));
    let mut out = Vec::new();
    for (key, value) in vars {
        if !PATH_VARS.contains(&key.as_str()) {
            continue;
        }
        let sep = if key == "LD_PRELOAD" { [':', ' '] } else { [':', ':'] };
        let parts: Vec<&str> = value.split(|c| sep.contains(&c)).filter(|p| !p.is_empty()).collect();
        if !parts.iter().any(|p| inside(p)) {
            continue;
        }
        let kept: Vec<&str> = parts.into_iter().filter(|p| !inside(p)).collect();
        if kept.is_empty() {
            out.push(EnvChange::Remove(key.clone()));
        } else {
            out.push(EnvChange::Set(key.clone(), kept.join(":")));
        }
    }
    out
}

/// `Command::new(program)` with the AppImage's bundled-library paths removed.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    if let Some(appdir) = std::env::var_os("APPDIR").filter(|_| std::env::var_os("APPIMAGE").is_some()) {
        let vars: Vec<(String, String)> = std::env::vars().collect();
        for change in appimage_env_changes(&vars, &appdir.to_string_lossy()) {
            match change {
                EnvChange::Set(k, v) => {
                    cmd.env(k, v);
                }
                EnvChange::Remove(k) => {
                    cmd.env_remove(k);
                }
            }
        }
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(k: &str, val: &str) -> (String, String) {
        (k.to_string(), val.to_string())
    }

    #[test]
    fn strips_appdir_entries_and_keeps_host_ones() {
        let vars = vec![
            v("LD_LIBRARY_PATH", "/tmp/.mount_LTabc/usr/lib:/tmp/.mount_LTabc/usr/lib/x86_64-linux-gnu"),
            v("PATH", "/tmp/.mount_LTabc/usr/bin:/usr/local/bin:/usr/bin"),
            v("XDG_DATA_DIRS", "/tmp/.mount_LTabc/usr/share:/usr/share"),
            v("GIO_MODULE_DIR", "/tmp/.mount_LTabc/usr/lib/gio/modules"),
            v("HOME", "/home/me"),
            v("GST_PLUGIN_PATH", "/opt/gst"),
        ];
        let changes = appimage_env_changes(&vars, "/tmp/.mount_LTabc/");
        assert_eq!(
            changes,
            vec![
                EnvChange::Remove("LD_LIBRARY_PATH".into()),
                EnvChange::Set("PATH".into(), "/usr/local/bin:/usr/bin".into()),
                EnvChange::Set("XDG_DATA_DIRS".into(), "/usr/share".into()),
                EnvChange::Remove("GIO_MODULE_DIR".into()),
            ]
        );
    }

    #[test]
    fn does_not_touch_lookalike_prefixes_or_empty_appdir() {
        let vars = vec![v("LD_LIBRARY_PATH", "/tmp/.mount_LTabcdef/usr/lib:/opt/lib")];
        assert!(appimage_env_changes(&vars, "/tmp/.mount_LTabc").is_empty());
        assert!(appimage_env_changes(&vars, "").is_empty());
    }

    #[test]
    fn ld_preload_accepts_space_separators() {
        let vars = vec![v("LD_PRELOAD", "/app/usr/lib/libx.so /usr/lib/liby.so")];
        assert_eq!(
            appimage_env_changes(&vars, "/app"),
            vec![EnvChange::Set("LD_PRELOAD".into(), "/usr/lib/liby.so".into())]
        );
    }

    #[test]
    fn command_outside_appimage_is_plain() {
        // Not running as an AppImage in tests: no env overrides are applied.
        let cmd = command("true");
        assert_eq!(cmd.get_envs().count(), 0);
    }
}
