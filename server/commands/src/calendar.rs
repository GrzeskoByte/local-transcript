//! Company calendar transport (CalDAV / Microsoft Graph / EWS).
// Ported from src-tauri/src/calendar.rs and src-tauri/src/calendar_detect.rs.
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ipnet::IpNet;
use reqwest::{
    blocking::{Client, RequestBuilder, Response},
    header::{self, HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
    Method, Url,
};
use serde::{Deserialize, Serialize};
use url::Host;

const MAX_PROBE_BODY: u64 = 256 * 1024;
const MAX_CALENDAR_BODY: u64 = 16 * 1024 * 1024;

fn endpoint(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "Invalid calendar endpoint.")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Refusing non-HTTP(S) calendar endpoint.".into());
    }
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || input.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(
            "Expected an HTTP(S) calendar endpoint without credentials or a fragment.".into(),
        );
    }
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_documentation()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && matches!(b, 18 | 19)))
        }
        IpAddr::V6(ip) => {
            let [a, b, ..] = ip.segments();
            // Global unicast only, excluding special-use space, documentation and 6to4.
            a & 0xe000 == 0x2000
                && (a != 0x2001 || (b >= 0x0200 && b != 0x0db8))
                && !matches!(a, 0x2002 | 0x3fff)
        }
    }
}

fn check_addresses(host: &str, addresses: &[SocketAddr], allowed: &[String]) -> Result<(), String> {
    let allowed_host = allowed.iter().any(|entry| {
        entry
            .trim_end_matches('.')
            .eq_ignore_ascii_case(host.trim_end_matches('.'))
    });
    let networks: Vec<IpNet> = allowed
        .iter()
        .filter_map(|entry| entry.parse().ok())
        .collect();
    if addresses.is_empty()
        || addresses.iter().any(|address| {
            let ip = address.ip();
            !allowed_host
                && !public_ip(ip)
                && !networks
                    .iter()
                    .any(|network| network.contains(&ip) || network.contains(&ip.to_canonical()))
        })
    {
        return Err("Calendar endpoint resolves to a restricted address. Ask the server administrator to allow this host.".into());
    }
    Ok(())
}

fn client(
    url: &Url,
    allowed: &[String],
    connect_secs: u64,
    request_secs: u64,
) -> Result<Client, String> {
    let host = url.host_str().ok_or("Calendar endpoint has no host.")?;
    let port = url
        .port_or_known_default()
        .ok_or("Calendar endpoint has no port.")?;
    let addresses: Vec<_> = match url.host() {
        Some(Host::Ipv4(ip)) => vec![SocketAddr::new(ip.into(), port)],
        Some(Host::Ipv6(ip)) => vec![SocketAddr::new(ip.into(), port)],
        _ => (host, port)
            .to_socket_addrs()
            .map_err(|_| "Could not resolve the calendar endpoint.")?
            .collect(),
    };
    check_addresses(host, &addresses, allowed)?;
    // Keep the original URL for Host and TLS verification. Only dial the checked addresses.
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(connect_secs))
        .timeout(Duration::from_secs(request_secs))
        .build()
        .map_err(|_| "Could not initialize the calendar client.".into())
}

fn request_headers(content_type: &str, headers: &[String]) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    if !content_type.is_empty() {
        map.insert(header::CONTENT_TYPE, header_value(content_type)?);
    }
    for raw in headers {
        let (name, value) = raw
            .split_once(':')
            .ok_or("Expected a calendar header name and value.")?;
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid calendar header name.")?;
        // The app sends these transport headers. The client owns routing, framing and credentials.
        if !matches!(name.as_str(), "depth" | "soapaction" | "content-type") {
            return Err("Unsupported calendar transport header.".into());
        }
        map.insert(name, header_value(value)?);
    }
    Ok(map)
}

fn header_value(value: &str) -> Result<HeaderValue, String> {
    if value.contains(['\r', '\n']) {
        return Err("Calendar headers and credentials must not contain CR or LF.".into());
    }
    HeaderValue::from_str(value.trim()).map_err(|_| "Invalid calendar header value.".into())
}

fn basic_auth(headers: &mut HeaderMap, username: &str, password: &str) -> Result<(), String> {
    if username.contains(['\r', '\n']) || password.contains(['\r', '\n']) {
        return Err("Calendar headers and credentials must not contain CR or LF.".into());
    }
    let mut value = header_value(&format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    ))?;
    value.set_sensitive(true);
    headers.insert(header::AUTHORIZATION, value);
    Ok(())
}

fn send_request(builder: RequestBuilder, method: &str, body: &str) -> Result<Response, String> {
    let builder = if method == "GET" {
        builder
    } else {
        builder.body(body.to_owned())
    };
    builder
        .send()
        .map_err(|_| "Calendar request failed.".into())
}

fn response_body(response: Response, limit: u64, truncate: bool) -> Result<String, String> {
    let mut body = Vec::new();
    response
        .take(limit + u64::from(!truncate))
        .read_to_end(&mut body)
        .map_err(|_| "Could not read the calendar response.")?;
    if body.len() as u64 > limit {
        return Err("Calendar response exceeds the maximum size.".into());
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// What the frontend sends: a fully-built body + where/how to deliver it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCreateRequest {
    /// `caldav` | `graph` | `ews`.
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

/// POST/PUT `body` to `endpoint`, return the response on success.
pub fn send(req: &CalendarCreateRequest, allowed: &[String]) -> Result<String, String> {
    let url = endpoint(&req.endpoint)?;
    if !matches!(
        req.method.as_str(),
        "PUT" | "POST" | "PROPFIND" | "GET" | "REPORT"
    ) {
        return Err("Calendar method must be PUT, POST, PROPFIND, GET or REPORT.".into());
    }
    let method =
        Method::from_bytes(req.method.as_bytes()).map_err(|_| "Invalid calendar method.")?;
    let mut headers = request_headers(&req.content_type, &req.headers)?;
    if let Some(token) = req.token.as_ref().filter(|token| !token.is_empty()) {
        let mut value = header_value(&format!("Bearer {token}"))?;
        value.set_sensitive(true);
        headers.insert(header::AUTHORIZATION, value);
    }
    let basic = req
        .username
        .as_deref()
        .filter(|username| !username.is_empty())
        .filter(|_| !headers.contains_key(header::AUTHORIZATION));
    if basic.is_some() && req.use_ntlm && req.provider == "ews" {
        return Err("NTLM is unavailable in the server edition. Configure EWS with Basic or Bearer authentication.".into());
    }
    if let Some(username) = basic {
        basic_auth(
            &mut headers,
            username,
            req.password.as_deref().unwrap_or_default(),
        )?;
    }
    let client = client(&url, allowed, 15, 60)?;
    let response = send_request(
        client.request(method, url).headers(headers),
        &req.method,
        &req.body,
    )?;
    if !response.status().is_success() {
        return Err(format!(
            "Calendar server returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    Ok(response_body(response, MAX_CALENDAR_BODY, false)?
        .trim()
        .to_string())
}

/// Cheap per-provider connectivity check (creates nothing).
#[derive(Deserialize)]
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
pub fn test(request: &CalendarTestRequest, allowed: &[String]) -> Result<String, String> {
    let (method, endpoint, content_type, body, headers): (&str, String, &str, &str, Vec<String>) =
        match request.provider.as_str() {
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
    send(
        &CalendarCreateRequest {
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
        },
        allowed,
    )
    .map(|_| "Connection OK.".to_string())
}

// --- server auto-detection probe -------------------------------------------

#[derive(Deserialize)]
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

/// The caller handles same-origin redirects using the returned Location header.
pub fn probe(req: &ProbeRequest, allowed: &[String]) -> Result<ProbeResponse, String> {
    let url = endpoint(&req.endpoint)?;
    if !matches!(req.method.as_str(), "PROPFIND" | "GET" | "POST") {
        return Err("Probe method must be PROPFIND, GET or POST.".into());
    }
    let method = Method::from_bytes(req.method.as_bytes()).map_err(|_| "Invalid probe method.")?;
    let mut headers = request_headers(&req.content_type, &req.headers)?;
    if let Some((username, password)) = req
        .username
        .as_deref()
        .zip(req.password.as_deref())
        .filter(|(user, pass)| !user.is_empty() && !pass.is_empty())
    {
        basic_auth(&mut headers, username, password)?;
    }
    let client = client(&url, allowed, 8, 20)?;
    let response = send_request(
        client.request(method, url).headers(headers),
        &req.method,
        &req.body,
    )?;
    let headers = response.headers();
    let field = |name| {
        headers
            .get(name)
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .unwrap_or_default()
    };
    Ok(ProbeResponse {
        status: response.status().as_u16(),
        location: field(header::LOCATION),
        www_authenticate: headers
            .get_all(header::WWW_AUTHENTICATE)
            .iter()
            .map(|value| String::from_utf8_lossy(value.as_bytes()))
            .collect::<Vec<_>>()
            .join(", "),
        dav: field(HeaderName::from_static("dav")),
        body: response_body(response, MAX_PROBE_BODY, true)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener};

    #[test]
    fn rejects_restricted_addresses_including_mapped_ipv4() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "224.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.1.1",
            "::ffff:100.64.0.1",
            "::ffff:0.0.0.0",
            "::ffff:224.0.0.1",
        ] {
            let address = SocketAddr::new(ip.parse().unwrap(), 443);
            assert!(
                check_addresses("calendar.example", &[address], &[]).is_err(),
                "{ip}"
            );
        }
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let private: SocketAddr = "10.0.0.1:443".parse().unwrap();
        let public_v6: SocketAddr = "[2606:4700::1111]:443".parse().unwrap();
        assert!(check_addresses("calendar.example", &[public, public_v6], &[]).is_ok());
        assert!(check_addresses("calendar.example", &[public, private], &[]).is_err());
        assert!(check_addresses("calendar.example", &[private], &["10.0.0.0/24".into()]).is_ok());
        assert!(check_addresses("calendar.example", &[private], &["10.0.1.0/24".into()]).is_err());
        assert!(check_addresses("calendar.example", &[private], &["example".into()]).is_err());
    }

    #[test]
    fn accepts_allowlisted_private_host_and_returns_redirect_to_caller() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://localhost:{}/dav",
            listener.local_addr().unwrap().port()
        );
        let request = ProbeRequest {
            endpoint,
            method: "GET".into(),
            username: Some("user".into()),
            password: Some("pass".into()),
            content_type: String::new(),
            body: String::new(),
            headers: vec![],
        };
        assert!(probe(&request, &[])
            .unwrap_err()
            .contains("restricted address"));
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            use std::io::BufRead;
            let request: String = std::io::BufReader::new(&stream)
                .lines()
                .map(Result::unwrap)
                .take_while(|line| !line.is_empty())
                .map(|line| format!("{line}\n"))
                .collect();
            assert!(request.starts_with("GET /dav HTTP/1.1"));
            assert!(request.contains("authorization: Basic dXNlcjpwYXNz"));
            stream.write_all(b"HTTP/1.1 301 Moved\r\nLocation: /calendar/\r\nWWW-Authenticate: Basic\r\nWWW-Authenticate: Bearer\r\nDAV: 1, calendar-access\r\nContent-Length: 7\r\nConnection: close\r\n\r\n<body/>").unwrap();
        });
        let response = probe(&request, &["LOCALHOST.".into()]).unwrap();
        server.join().unwrap();
        assert_eq!(response.status, 301);
        assert_eq!(response.location, "/calendar/");
        assert_eq!(response.www_authenticate, "Basic, Bearer");
        assert_eq!(response.dav, "1, calendar-access");
        assert_eq!(response.body, "<body/>");
    }

    #[test]
    fn rejects_unsafe_urls_and_headers() {
        for url in [
            "file:///tmp/calendar",
            "javascript:alert(1)",
            "https://calendar.example/a b",
            "https://user:pass@calendar.example/",
            "https://calendar.example/#fragment",
        ] {
            assert!(endpoint(url).is_err(), "{url}");
        }
        for raw in [
            "@headers",
            "Host: other.example",
            "Depth: 1\r",
            "Depth: 1\n",
            "Depth: 1\r\nDepth: 2",
        ] {
            assert!(request_headers("", &[raw.into()]).is_err(), "{raw:?}");
        }
        assert!(request_headers("text/plain\r", &[]).is_err());
        assert!(basic_auth(&mut HeaderMap::new(), "user", "pass\n").is_err());
    }
}
