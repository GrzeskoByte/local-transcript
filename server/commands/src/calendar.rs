//! Company calendar transport (CalDAV / Microsoft Graph / EWS) through the
//! server's `curl`, with the user's own credentials from the request.
// Ported from src-tauri/src/calendar.rs (create/fetch/test) and
// src-tauri/src/calendar_detect.rs (probe). Same validation; additionally the
// protocol is pinned to http(s) (`--proto`) so curl can never read local files.
use std::io::Write;
use std::process::Stdio;

use serde::{Deserialize, Serialize};

/// What the frontend sends: a fully-built body + where/how to deliver it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCreateRequest {
    /// `caldav` | `graph` | `ews` (used only for error context).
    pub provider: String,
    pub endpoint: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
    pub content_type: String,
    pub body: String,
    #[serde(default)]
    pub use_ntlm: bool,
    /// `PUT` | `POST` | `PROPFIND` | `GET` | `REPORT`.
    pub method: String,
    #[serde(default)]
    pub headers: Vec<String>,
}

fn valid_endpoint(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// POST/PUT `body` to `endpoint`, return the response on success.
pub fn curl_send(req: &CalendarCreateRequest) -> Result<String, String> {
    if !valid_endpoint(&req.endpoint) {
        return Err("Refusing non-HTTP(S) calendar endpoint.".to_string());
    }
    if !matches!(req.method.as_str(), "PUT" | "POST" | "PROPFIND" | "GET" | "REPORT") {
        return Err("Calendar method must be PUT, POST, PROPFIND, GET or REPORT.".to_string());
    }
    let mut cmd = crate::proc::command("curl");
    cmd.args(["-sS", "-f", "-X", &req.method, "--proto", "=http,https"]);
    cmd.arg("--connect-timeout").arg("15").arg("--max-time").arg("60");
    cmd.arg("-H").arg(format!("Content-Type: {}", req.content_type));
    for h in &req.headers {
        cmd.arg("-H").arg(h);
    }
    if let Some(token) = req.token.as_ref().filter(|t| !t.is_empty()) {
        cmd.arg("-H").arg(format!("Authorization: Bearer {token}"));
    } else if let Some(user) = req.username.as_ref().filter(|u| !u.is_empty()) {
        let pass = req.password.clone().unwrap_or_default();
        // NTLM is for on-prem Exchange only (and some curl builds lack it).
        if req.use_ntlm && req.provider == "ews" {
            cmd.arg("--ntlm");
        }
        cmd.arg("-u").arg(format!("{user}:{pass}"));
    }
    if req.method != "GET" {
        cmd.arg("--data-binary").arg("@-");
    }
    cmd.arg(&req.endpoint);
    let out = if req.method == "GET" {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Calendar request failed: {e}"))?
    } else {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Could not run curl ({}): {e}", req.provider))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "Could not pipe calendar payload.".to_string())?
            .write_all(req.body.as_bytes())
            .map_err(|e| format!("Could not send calendar payload: {e}"))?;
        child.wait_with_output().map_err(|e| format!("Calendar request failed: {e}"))?
    };
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Calendar server rejected the request ({}).", req.provider)
        } else {
            format!("Calendar request failed ({}): {}", req.provider, detail)
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Cheap per-provider connectivity check (creates nothing).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarTestRequest {
    pub provider: String,
    pub endpoint: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
    #[serde(default)]
    pub use_ntlm: bool,
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>"#;

const EWS_GET_FOLDER: &str = r#"<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header><soap:Body><m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="calendar"/></m:FolderIds></m:GetFolder></soap:Body></soap:Envelope>"#;

/// CalDAV: PROPFIND on the collection; Graph: GET /me; EWS: GetFolder on the calendar.
pub fn test(request: &CalendarTestRequest) -> Result<String, String> {
    let (method, endpoint, content_type, body, headers): (&str, String, &str, &str, Vec<String>) =
        match request.provider.as_str() {
            "graph" => ("GET", format!("{}/me", request.endpoint.trim_end_matches('/')), "application/json", "", vec![]),
            "ews" => ("POST", request.endpoint.clone(), "text/xml; charset=utf-8", EWS_GET_FOLDER, vec![]),
            _ => (
                "PROPFIND",
                request.endpoint.clone(),
                "text/xml; charset=utf-8",
                PROPFIND_BODY,
                vec!["Depth: 1".to_string()],
            ),
        };
    curl_send(&CalendarCreateRequest {
        provider: request.provider.clone(),
        endpoint,
        username: request.username.clone(),
        password: request.password.clone(),
        token: request.token.clone(),
        content_type: content_type.to_string(),
        body: body.to_string(),
        use_ntlm: request.use_ntlm,
        method: method.to_string(),
        headers,
    })
    .map(|_| "Connection OK.".to_string())
}

// --- server auto-detection probe -------------------------------------------

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

/// One curl request, no redirects, PROPFIND/GET/POST only.
pub fn probe(req: &ProbeRequest) -> Result<ProbeResponse, String> {
    let ep = &req.endpoint;
    if !valid_endpoint(ep) {
        return Err("Refusing non-HTTP(S) probe endpoint.".to_string());
    }
    if !matches!(req.method.as_str(), "PROPFIND" | "GET" | "POST") {
        return Err("Probe method must be PROPFIND, GET or POST.".to_string());
    }
    let mut cmd = crate::proc::command("curl");
    cmd.args(["-sS", "-i", "-X", &req.method, "--proto", "=http,https"])
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
    let out = child.wait_with_output().map_err(|e| format!("Probe failed: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if detail.is_empty() { "Host did not answer.".to_string() } else { detail });
    }
    Ok(parse_include(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(endpoint: &str) -> CalendarCreateRequest {
        CalendarCreateRequest {
            provider: "caldav".to_string(),
            endpoint: endpoint.to_string(),
            username: None,
            password: None,
            token: None,
            content_type: "text/calendar".to_string(),
            body: "BEGIN:VCALENDAR".to_string(),
            use_ntlm: false,
            method: "PUT".to_string(),
            headers: vec![],
        }
    }

    #[test]
    fn rejects_non_http_endpoints() {
        assert!(curl_send(&req("file:///etc/passwd")).is_err());
        assert!(curl_send(&req("javascript:alert(1)")).is_err());
        assert!(curl_send(&req("https://cal.example/x y")).is_err());
    }

    #[test]
    fn rejects_bad_methods() {
        let mut r = req("https://cal.example/dav/x.ics");
        r.method = "DELETE".to_string();
        assert!(curl_send(&r).is_err());
    }

    #[test]
    fn parses_curl_include_output() {
        let raw = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 301 Moved\r\nLocation: https://x/y\r\nWWW-Authenticate: Basic\r\nDAV: 1, calendar-access\r\n\r\n<body/>";
        let res = parse_include(raw);
        assert_eq!(res.status, 301);
        assert_eq!(res.location, "https://x/y");
        assert_eq!(res.www_authenticate, "Basic");
        assert_eq!(res.dav, "1, calendar-access");
        assert_eq!(res.body, "<body/>");
    }

    #[test]
    fn rejects_bad_probe_requests() {
        let bad = |endpoint: &str, method: &str| ProbeRequest {
            endpoint: endpoint.into(),
            method: method.into(),
            username: None,
            password: None,
            content_type: String::new(),
            body: String::new(),
            headers: vec![],
        };
        assert!(probe(&bad("file:///etc/passwd", "GET")).is_err());
        assert!(probe(&bad("https://a.example", "DELETE")).is_err());
    }
}
