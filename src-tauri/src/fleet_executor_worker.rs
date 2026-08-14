use super::*;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const WORK_BODY: &str = r#"{"action":"work-once"}"#;
const APP_QUIT_BODY: &str = r#"{"action":"app-quit"}"#;

static WORKER_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkerTarget {
    host: String,
    port: u16,
    token: Option<String>,
}

fn worker_target(url: &Url) -> Option<WorkerTarget> {
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return None;
    }
    let port = url.port()?;
    let token = url
        .query_pairs()
        .find_map(|(key, value)| (key == "covenCaveToken").then(|| value.into_owned()))
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 512
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        });
    Some(WorkerTarget {
        host: url.host_str()?.to_string(),
        port,
        token,
    })
}

fn post_action(target: &WorkerTarget, body: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect((target.host.as_str(), target.port))
        .map_err(|error| format!("could not connect to Cave worker endpoint: {error}"))?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("could not bound Cave worker response: {error}"))?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("could not bound Cave worker request: {error}"))?;
    let token_header = target
        .token
        .as_ref()
        .map(|token| format!("x-coven-cave-token: {token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "POST /api/fleet HTTP/1.1\r\nHost: {}:{}\r\ncontent-type: application/json\r\n{}content-length: {}\r\nconnection: close\r\n\r\n{}",
        target.host,
        target.port,
        token_header,
        body.len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("could not send Cave worker request: {error}"))?;
    let mut response = Vec::new();
    stream
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|error| format!("could not read Cave worker response: {error}"))?;
    if response.len() > MAX_RESPONSE_BYTES {
        return Err("Cave worker response exceeded its size limit".to_string());
    }
    let status_line = response
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    if !status_line.starts_with(b"HTTP/1.1 200 ") && !status_line.starts_with(b"HTTP/1.0 200 ") {
        return Err(format!(
            "Cave worker endpoint returned {}",
            String::from_utf8_lossy(status_line).trim()
        ));
    }
    Ok(())
}

fn post_work_once(target: &WorkerTarget) -> Result<(), String> {
    post_action(target, WORK_BODY)
}

/// Resolve where to reach Cave, authenticating with this process's own token.
///
/// The URL supplies only the loopback address and port. Its `covenCaveToken` is
/// not a dependable credential: SidecarAuthBridge strips the parameter from the
/// address bar right after boot, and `main_url_for_child_windows` falls back to
/// that live (stripped) URL whenever no startup URL was memoised — which is
/// exactly what left every poll unauthenticated, answered `401 Unauthorized` by
/// the proxy's access gate. Prefer the credential the sidecar was started with;
/// fall back to the URL's copy so a tokenless dev server still works.
fn authenticated_worker_target(app: &tauri::AppHandle) -> Option<WorkerTarget> {
    let mut target = main_url_for_child_windows(app)
        .as_ref()
        .and_then(worker_target)?;
    if let Some(token) = current_sidecar_auth_token() {
        target.token = Some(token);
    }
    Some(target)
}

pub(super) fn stop_owned_fleet_daemon(app: &tauri::AppHandle) {
    let Some(target) = authenticated_worker_target(app) else {
        return;
    };
    if let Err(error) = post_action(&target, APP_QUIT_BODY) {
        log::warn!("[cave] could not stop the Cave-owned Coven daemon: {error}");
    }
}

pub(super) fn start_fleet_executor_worker(app: tauri::AppHandle) {
    if WORKER_STARTED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    thread::spawn(move || loop {
        if let Some(target) = authenticated_worker_target(&app) {
            if let Err(error) = post_work_once(&target) {
                log::debug!("[cave] Fleet executor poll skipped: {error}");
            }
        }
        thread::sleep(POLL_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn worker_accepts_only_bounded_loopback_targets() {
        let target = worker_target(
            &Url::parse("http://127.0.0.1:43123/?covenCaveToken=abc_123-def").unwrap(),
        )
        .unwrap();
        assert_eq!(target.host, "127.0.0.1");
        assert_eq!(target.port, 43123);
        assert_eq!(target.token.as_deref(), Some("abc_123-def"));
        assert!(worker_target(&Url::parse("https://127.0.0.1:43123/").unwrap()).is_none());
        assert!(worker_target(&Url::parse("http://tailnet.example:43123/").unwrap()).is_none());
        assert!(worker_target(&Url::parse("http://127.0.0.1/").unwrap()).is_none());
    }

    /// The webview URL is stripped of `covenCaveToken` moments after boot, so a
    /// poll that trusted it authenticated as nobody and the proxy answered
    /// `401 Unauthorized` on every tick. The minted credential must win over
    /// whatever the URL happens to still carry, including nothing at all.
    #[test]
    fn the_minted_credential_outranks_the_stripped_url() {
        let stripped = Url::parse("http://127.0.0.1:43123/").unwrap();
        assert!(
            worker_target(&stripped).unwrap().token.is_none(),
            "a stripped URL yields no credential — this is the 401 state"
        );

        remember_sidecar_auth_token("f00dcafe");
        assert_eq!(current_sidecar_auth_token().as_deref(), Some("f00dcafe"));

        // A later sidecar start replaces it, so a stale credential can never
        // outlive the sidecar it authenticated.
        remember_sidecar_auth_token("beefbeef");
        assert_eq!(current_sidecar_auth_token().as_deref(), Some("beefbeef"));
    }

    #[test]
    fn malformed_tokens_are_never_copied_into_headers() {
        let target = worker_target(
            &Url::parse("http://localhost:3000/?covenCaveToken=bad%0D%0Aheader").unwrap(),
        )
        .unwrap();
        assert_eq!(target.token, None);
    }

    #[test]
    fn native_worker_posts_the_local_authenticated_action() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = vec![0; 4096];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("POST /api/fleet HTTP/1.1\r\n"));
            assert!(request.contains("x-coven-cave-token: test_token\r\n"));
            assert!(request.ends_with(WORK_BODY));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
                .unwrap();
        });
        post_work_once(&WorkerTarget {
            host: "127.0.0.1".into(),
            port,
            token: Some("test_token".into()),
        })
        .unwrap();
        server.join().unwrap();
    }
}
