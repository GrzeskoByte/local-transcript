//! Company calendar integration: create events on CalDAV / Microsoft Graph /
//! EWS (on-prem Exchange) servers. Payloads are built in TypeScript
//! (`src/integrations/calendar.ts`, unit-tested there); this module only
//! transports them with the system `curl` binary, so no new crates are needed.
//! Credentials stay in the app: they are passed as argv/stdin to a child
//! process, never logged.

use std::io::Write;
use std::process::Stdio;

use serde::Deserialize;

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
    pub use_ntlm: bool,
    /// HTTP method: `PUT` (CalDAV create), `POST` (Graph/EWS),
    /// `PROPFIND` (CalDAV probe), `GET` (Graph probe/fetch) or
    /// `REPORT` (CalDAV fetch).
    pub method: String,
    /// Extra `-H` headers, e.g. `Depth: 1`.
    #[serde(default)]
    pub headers: Vec<String>,
}

fn valid_endpoint(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn curl_program() -> &'static str {
    "curl"
}

/// POST/PUT `body` to `endpoint`, return the response on success.
fn curl_send(req: &CalendarCreateRequest) -> Result<String, String> {
    if !valid_endpoint(&req.endpoint) {
        return Err("Refusing non-HTTP(S) calendar endpoint.".to_string());
    }
    if req.method != "PUT"
        && req.method != "POST"
        && req.method != "PROPFIND"
        && req.method != "GET"
        && req.method != "REPORT"
    {
        return Err("Calendar method must be PUT, POST, PROPFIND, GET or REPORT.".to_string());
    }
    let mut cmd = crate::proc::command(curl_program());
    cmd.args(["-sS", "-f", "-X", &req.method]);
    cmd.arg("--connect-timeout")
        .arg("15")
        .arg("--max-time")
        .arg("60");
    cmd.arg("-H")
        .arg(format!("Content-Type: {}", req.content_type));
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
        // No body: plain request, no stdin pipe.
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Calendar request failed: {e}"))?
    } else {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not run curl ({}): {e}", req.provider))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "Could not pipe calendar payload.".to_string())?
            .write_all(req.body.as_bytes())
            .map_err(|e| format!("Could not send calendar payload: {e}"))?;
        child
            .wait_with_output()
            .map_err(|e| format!("Calendar request failed: {e}"))?
    };
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Calendar server rejected the request ({}).", req.provider)
        } else {
            // Strip any echoed secret: curl never echoes -u/token, but be safe.
            format!("Calendar request failed ({}): {}", req.provider, detail)
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Create a calendar event. Returns the server response (Graph returns the
/// event JSON incl. `webLink`; CalDAV/EWS return an empty body on success).
#[tauri::command]
pub async fn native_calendar_create(request: CalendarCreateRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || curl_send(&request))
        .await
        .map_err(|e| format!("Calendar task failed: {e}"))?
}

/// Fetch events in a time window (CalDAV REPORT, Graph calendarview, EWS
/// FindItem). Returns the raw server response for the frontend to parse.
#[tauri::command]
pub async fn native_calendar_fetch(request: CalendarCreateRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || curl_send(&request))
        .await
        .map_err(|e| format!("Calendar task failed: {e}"))?
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
    pub use_ntlm: bool,
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>"#;

const EWS_GET_FOLDER: &str = r#"<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header><soap:Body><m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="calendar"/></m:FolderIds></m:GetFolder></soap:Body></soap:Envelope>"#;

#[tauri::command]
pub async fn native_calendar_test(request: CalendarTestRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // CalDAV: PROPFIND on the collection; Graph: GET /me;
        // EWS: GetFolder on the calendar. None creates anything.
        let (method, endpoint, content_type, body, headers): (
            &str,
            String,
            &str,
            &str,
            Vec<String>,
        ) = match request.provider.as_str() {
            "graph" => (
                "GET",
                format!("{}/me", request.endpoint.trim_end_matches('/')),
                "application/json",
                "",
                vec![],
            ),
            "ews" => (
                "POST",
                request.endpoint.clone(),
                "text/xml; charset=utf-8",
                EWS_GET_FOLDER,
                vec![],
            ),
            _ => (
                "PROPFIND",
                request.endpoint.clone(),
                "text/xml; charset=utf-8",
                PROPFIND_BODY,
                vec!["Depth: 1".to_string()],
            ),
        };
        let send = CalendarCreateRequest {
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
        };
        curl_send(&send).map(|_| "Connection OK.".to_string())
    })
    .await
    .map_err(|e| format!("Calendar test failed: {e}"))?
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
}
