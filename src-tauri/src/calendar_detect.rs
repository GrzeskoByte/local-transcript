//! Calendar auto-detection helpers. Both commands are read-only:
//! - `native_calendar_thunderbird` reads Thunderbird profiles' `prefs.js`
//!   and returns only the calendar-registry and mail-server lines (no
//!   passwords: Thunderbird keeps those encrypted elsewhere, never read here).
//! - `native_calendar_probe` sends one HTTP request (no redirects followed)
//!   and returns status, `Location`/`WWW-Authenticate`/`DAV` headers and
//!   the body, so the frontend can tell which calendar system a host runs.
//! Parsing of both lives in `src/integrations/calendar-detect.ts`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThunderbirdProfile {
    pub profile: String,
    /// Only `user_pref("calendar.registry.…` and `user_pref("mail.server.…`
    /// hostname/userName lines.
    pub lines: Vec<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Thunderbird roots that hold `profiles.ini` on each OS (incl. Snap/Flatpak).
fn thunderbird_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home_dir() {
        roots.push(home.join(".thunderbird"));
        roots.push(home.join("snap/thunderbird/common/.thunderbird"));
        roots.push(home.join(".var/app/org.mozilla.Thunderbird/.thunderbird"));
        roots.push(home.join("Library/Thunderbird"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Thunderbird"));
    }
    roots
}

/// Profile dirs listed in `profiles.ini` (`Path=` + `IsRelative=`).
fn profiles_from_ini(root: &Path, ini: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut relative = true;
    let flush = |path: &mut Option<String>, relative: bool, out: &mut Vec<PathBuf>| {
        if let Some(p) = path.take() {
            let p = p.replace('/', std::path::MAIN_SEPARATOR_STR);
            out.push(if relative { root.join(p) } else { PathBuf::from(p) });
        }
    };
    for line in ini.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            flush(&mut path, relative, &mut out);
            relative = true;
        } else if let Some(v) = line.strip_prefix("Path=") {
            path = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("IsRelative=") {
            relative = v.trim() != "0";
        }
    }
    flush(&mut path, relative, &mut out);
    out
}

fn wanted_pref(line: &str) -> bool {
    let l = line.trim_start();
    l.starts_with("user_pref(\"calendar.registry.")
        || (l.starts_with("user_pref(\"mail.server.server")
            && (l.contains(".hostname\"") || l.contains(".userName\"") || l.contains(".type\"")))
}

/// Filter `prefs.js` down to the lines detection needs.
pub fn filter_prefs(prefs: &str) -> Vec<String> {
    prefs
        .lines()
        .filter(|l| wanted_pref(l))
        .map(|l| l.trim().to_string())
        .collect()
}

fn scan_profiles() -> Vec<ThunderbirdProfile> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    for root in thunderbird_roots() {
        let mut dirs = match fs::read_to_string(root.join("profiles.ini")) {
            Ok(ini) => profiles_from_ini(&root, &ini),
            Err(_) => Vec::new(),
        };
        // Fallback: any `Profiles/*` dir with a prefs.js.
        if let Ok(entries) = fs::read_dir(root.join("Profiles")) {
            dirs.extend(entries.flatten().map(|e| e.path()));
        }
        for dir in dirs {
            let canonical = fs::canonicalize(&dir).unwrap_or(dir.clone());
            if seen.contains(&canonical) {
                continue;
            }
            let Ok(prefs) = fs::read_to_string(dir.join("prefs.js")) else {
                continue;
            };
            seen.push(canonical);
            let lines = filter_prefs(&prefs);
            if lines.is_empty() {
                continue;
            }
            let profile = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            out.push(ThunderbirdProfile { profile, lines });
        }
    }
    out
}

#[tauri::command]
pub async fn native_calendar_thunderbird() -> Result<Vec<ThunderbirdProfile>, String> {
    tauri::async_runtime::spawn_blocking(scan_profiles)
        .await
        .map_err(|e| format!("Thunderbird scan failed: {e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRequest {
    pub endpoint: String,
    /// `PROPFIND` | `GET` | `POST`.
    pub method: String,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub content_type: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub headers: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResponse {
    pub status: u16,
    pub location: String,
    pub www_authenticate: String,
    pub dav: String,
    pub body: String,
}

const MAX_BODY: usize = 256 * 1024;

/// Split `curl -i` output: skip `1xx` blocks, read status + a few headers.
pub fn parse_include(raw: &str) -> ProbeResponse {
    let mut rest = raw;
    loop {
        let (head, body) = match rest.find("\r\n\r\n") {
            Some(i) => (&rest[..i], &rest[i + 4..]),
            None => match rest.find("\n\n") {
                Some(i) => (&rest[..i], &rest[i + 2..]),
                None => (rest, ""),
            },
        };
        let mut lines = head.lines();
        let status: u16 = lines
            .next()
            .and_then(|s| s.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if (100..200).contains(&status) && body.starts_with("HTTP/") {
            rest = body;
            continue;
        }
        let mut res = ProbeResponse {
            status,
            location: String::new(),
            www_authenticate: String::new(),
            dav: String::new(),
            body: body.chars().take(MAX_BODY).collect(),
        };
        for line in lines {
            let Some((k, v)) = line.split_once(':') else { continue };
            let v = v.trim().to_string();
            match k.trim().to_ascii_lowercase().as_str() {
                "location" => res.location = v,
                "www-authenticate" => {
                    if !res.www_authenticate.is_empty() {
                        res.www_authenticate.push_str(", ");
                    }
                    res.www_authenticate.push_str(&v);
                }
                "dav" => res.dav = v,
                _ => {}
            }
        }
        return res;
    }
}

fn probe(req: &ProbeRequest) -> Result<ProbeResponse, String> {
    let ep = &req.endpoint;
    if !(ep.starts_with("https://") || ep.starts_with("http://"))
        || ep.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("Refusing non-HTTP(S) probe endpoint.".to_string());
    }
    if !matches!(req.method.as_str(), "PROPFIND" | "GET" | "POST") {
        return Err("Probe method must be PROPFIND, GET or POST.".to_string());
    }
    let mut cmd = crate::proc::command("curl");
    cmd.args(["-sS", "-i", "-X", &req.method])
        .args(["--connect-timeout", "8", "--max-time", "20"]);
    if !req.content_type.is_empty() {
        cmd.arg("-H").arg(format!("Content-Type: {}", req.content_type));
    }
    for h in &req.headers {
        cmd.arg("-H").arg(h);
    }
    if let Some(user) = req.username.as_ref().filter(|u| !u.is_empty()) {
        if let Some(pass) = req.password.as_ref().filter(|p| !p.is_empty()) {
            cmd.arg("-u").arg(format!("{user}:{pass}"));
        }
    }
    let has_body = req.method != "GET";
    if has_body {
        cmd.arg("--data-binary").arg("@-");
    }
    cmd.arg(ep)
        .stdin(if has_body { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not run curl: {e}"))?;
    if has_body {
        child
            .stdin
            .take()
            .ok_or_else(|| "Could not pipe probe body.".to_string())?
            .write_all(req.body.as_bytes())
            .map_err(|e| format!("Could not send probe body: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("Probe failed: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if detail.is_empty() { "Host did not answer.".to_string() } else { detail });
    }
    Ok(parse_include(&String::from_utf8_lossy(&out.stdout)))
}

#[tauri::command]
pub async fn native_calendar_probe(request: ProbeRequest) -> Result<ProbeResponse, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&request))
        .await
        .map_err(|e| format!("Probe task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_prefs_to_calendar_and_mail_lines() {
        let prefs = concat!(
            "user_pref(\"browser.foo\", 1);\n",
            "user_pref(\"calendar.registry.abc.uri\", \"https://h/SOGo/dav/me/Calendar/personal/\");\n",
            "user_pref(\"mail.server.server1.hostname\", \"mail.host.com\");\n",
            "user_pref(\"mail.server.server1.userName\", \"me\");\n",
            "user_pref(\"mail.server.server1.check_new_mail\", true);\n",
            "user_pref(\"signon.x\", \"secret\");\n",
        );
        let lines = filter_prefs(prefs);
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|l| !l.contains("secret") && !l.contains("browser")));
    }

    #[test]
    fn reads_relative_and_absolute_profiles() {
        let ini = "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default\n\n[Profile1]\nIsRelative=0\nPath=/data/tb\n[General]\nVersion=2\n";
        let dirs = profiles_from_ini(Path::new("/r"), ini);
        assert_eq!(dirs.len(), 2);
        assert!(dirs[0].ends_with("abc.default"));
        assert_eq!(dirs[1], PathBuf::from("/data/tb"));
    }

    #[test]
    fn parses_curl_include_output() {
        let raw = "HTTP/1.1 100 Continue\r\n\r\nHTTP/2 301\r\nlocation: /SOGo/dav/\r\nDAV: 1, 2, calendar-access\r\nWWW-Authenticate: Basic realm=\"x\"\r\n\r\n<body/>";
        let r = parse_include(raw);
        assert_eq!(r.status, 301);
        assert_eq!(r.location, "/SOGo/dav/");
        assert_eq!(r.dav, "1, 2, calendar-access");
        assert_eq!(r.www_authenticate, "Basic realm=\"x\"");
        assert_eq!(r.body, "<body/>");
    }

    #[test]
    fn rejects_bad_probe_requests() {
        let mut r = ProbeRequest {
            endpoint: "file:///etc/passwd".into(),
            method: "GET".into(),
            username: None,
            password: None,
            content_type: String::new(),
            body: String::new(),
            headers: vec![],
        };
        assert!(probe(&r).is_err());
        r.endpoint = "https://h/".into();
        r.method = "DELETE".into();
        assert!(probe(&r).is_err());
    }
}
