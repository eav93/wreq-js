use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{Stream, StreamExt};
use indexmap::IndexMap;
use moka::sync::Cache;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::Mutex;
use uuid::Uuid;
use wreq::{Client as HttpClient, Method, Proxy, redirect};
use wreq_util::{Emulation, EmulationOS, EmulationOption};

pub static HTTP_RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create shared HTTP runtime")
});

static SESSION_MANAGER: Lazy<SessionManager> = Lazy::new(SessionManager::new);

#[derive(Debug, Clone, Copy, Default)]
pub enum RedirectMode {
    #[default]
    Follow,
    Manual,
    Error,
}

impl RedirectMode {
    fn as_policy(self) -> redirect::Policy {
        match self {
            RedirectMode::Follow => redirect::Policy::default(),
            RedirectMode::Manual => redirect::Policy::custom(|attempt| attempt.stop()),
            RedirectMode::Error => redirect::Policy::custom(|attempt| {
                attempt.error("Redirects are disabled for this request")
            }),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub url: String,
    pub emulation: Emulation,
    pub emulation_os: EmulationOS,
    pub headers: IndexMap<String, String>,
    pub method: String,
    pub body: Option<Vec<u8>>,
    pub proxy: Option<String>,
    pub timeout: u64,
    pub redirect: RedirectMode,
    pub session_id: String,
    pub ephemeral: bool,
    pub disable_default_headers: bool,
    pub insecure: bool,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: IndexMap<String, String>,
    pub body_handle: Option<u64>,
    pub cookies: IndexMap<String, String>,
    pub url: String,
    pub content_length: Option<u64>,
}

#[derive(Clone)]
struct SessionConfig {
    emulation: Emulation,
    emulation_os: EmulationOS,
    label: String,
    proxy: Option<String>,
    insecure: bool,
}

impl SessionConfig {
    fn from_request(options: &RequestOptions) -> Self {
        Self {
            emulation: options.emulation,
            emulation_os: options.emulation_os,
            label: emulation_label(&options.emulation, &options.emulation_os),
            proxy: options.proxy.clone(),
            insecure: options.insecure,
        }
    }

    fn new(emulation: Emulation, emulation_os: EmulationOS, proxy: Option<String>, insecure: bool) -> Self {
        let label = emulation_label(&emulation, &emulation_os);
        Self {
            emulation,
            emulation_os,
            label,
            proxy,
            insecure,
        }
    }

    fn matches(&self, other: &SessionConfig) -> bool {
        // Sessions must match on insecure setting to prevent reusing a client
        // with different certificate verification settings (security critical)
        self.label == other.label && self.proxy == other.proxy && self.insecure == other.insecure
    }
}

#[derive(Clone)]
struct SessionEntry {
    client: Arc<HttpClient>,
    config: SessionConfig,
}

struct SessionManager {
    cache: Cache<String, Arc<SessionEntry>>,
}

pub type ResponseBodyStream = Pin<Box<dyn Stream<Item = wreq::Result<Bytes>> + Send>>;

static BODY_STREAMS: Lazy<DashMap<u64, Arc<Mutex<ResponseBodyStream>>>> = Lazy::new(DashMap::new);
static NEXT_BODY_HANDLE: AtomicU64 = AtomicU64::new(1);

fn next_body_handle() -> u64 {
    NEXT_BODY_HANDLE.fetch_add(1, Ordering::Relaxed)
}

pub fn store_body_stream(stream: ResponseBodyStream) -> u64 {
    let handle = next_body_handle();
    BODY_STREAMS.insert(handle, Arc::new(Mutex::new(stream)));
    handle
}

pub async fn read_body_chunk(handle: u64) -> Result<Option<Bytes>> {
    let stream = BODY_STREAMS
        .get(&handle)
        .map(|entry| entry.value().clone())
        .ok_or_else(|| anyhow!("Body handle {} not found", handle))?;

    let mut guard = stream.lock().await;
    let next = guard.next().await;

    match next {
        Some(Ok(bytes)) => Ok(Some(bytes)),
        Some(Err(err)) => {
            BODY_STREAMS.remove(&handle);
            Err(err.into())
        }
        None => {
            BODY_STREAMS.remove(&handle);
            Ok(None)
        }
    }
}

pub fn drop_body_stream(handle: u64) {
    BODY_STREAMS.remove(&handle);
}

impl SessionManager {
    fn new() -> Self {
        Self {
            cache: Cache::builder()
                .time_to_idle(Duration::from_secs(300))
                .build(),
        }
    }

    fn client_for(&self, session_id: &str, config: SessionConfig) -> Result<Arc<HttpClient>> {
        if let Some(entry) = self.cache.get(session_id) {
            if entry.config.matches(&config) {
                return Ok(entry.client.clone());
            } else {
                anyhow::bail!(
                    "Session '{}' was created with different browser/os/proxy configuration",
                    session_id
                );
            }
        }

        let entry = self.build_entry(config)?;
        self.cache.insert(session_id.to_string(), entry.clone());
        Ok(entry.client.clone())
    }

    fn build_entry(&self, config: SessionConfig) -> Result<Arc<SessionEntry>> {
        let client = Arc::new(build_client(&config)?);
        Ok(Arc::new(SessionEntry { client, config }))
    }

    fn create_session(&self, session_id: String, config: SessionConfig) -> Result<String> {
        let entry = self.build_entry(config)?;
        self.cache.insert(session_id.clone(), entry);
        Ok(session_id)
    }

    fn clear_session(&self, session_id: &str) -> Result<()> {
        let existing = self
            .cache
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session '{}' not found", session_id))?;
        let config = existing.config.clone();
        let entry = self.build_entry(config)?;
        self.cache.insert(session_id.to_string(), entry);
        Ok(())
    }

    fn drop_session(&self, session_id: &str) {
        self.cache.invalidate(session_id);
    }
}

pub async fn make_request(options: RequestOptions) -> Result<Response> {
    let session_id = options.session_id.clone();
    let ephemeral = options.ephemeral;

    let result = make_request_inner(options).await;

    if ephemeral {
        SESSION_MANAGER.drop_session(&session_id);
    }

    result
}

async fn make_request_inner(options: RequestOptions) -> Result<Response> {
    let client = {
        let config = SessionConfig::from_request(&options);
        SESSION_MANAGER.client_for(&options.session_id, config)?
    };

    let RequestOptions {
        url,
        headers,
        method,
        body,
        timeout,
        redirect,
        disable_default_headers,
        ..
    } = options;

    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method
    };

    let method_upper = method.to_uppercase();

    let request_method = match method_upper.as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        "PATCH" => Method::PATCH,
        "HEAD" => Method::HEAD,
        "OPTIONS" => Method::OPTIONS,
        "CONNECT" => Method::CONNECT,
        "TRACE" => Method::TRACE,
        _ => Method::from_bytes(method_upper.as_bytes())
            .with_context(|| format!("Unsupported HTTP method: {}", method_upper))?,
    };

    // Build request
    let mut request = client.request(request_method, &url);

    // Apply custom headers
    for (key, value) in headers.iter() {
        request = request.header(key, value);
    }

    // Disable default headers if requested to prevent emulation headers from being appended
    if disable_default_headers {
        request = request.default_headers(false);
    }

    // Apply redirect policy
    request = request.redirect(redirect.as_policy());

    // Apply body if present
    if let Some(body) = body {
        request = request.body(body);
    }

    // Apply timeout
    request = request.timeout(Duration::from_millis(timeout));

    // Execute request
    let response = request
        .send()
        .await
        .with_context(|| format!("{} {}", method_upper, url))?;

    // Extract response data
    let status = response.status().as_u16();
    let final_url = response.uri().to_string();

    // Extract headers
    let mut response_headers = IndexMap::new();
    for (key, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            response_headers.insert(key.to_string(), value_str.to_string());
        }
    }

    // Extract cookies
    let mut cookies = IndexMap::new();
    for cookie in response.cookies() {
        cookies.insert(cookie.name().to_string(), cookie.value().to_string());
    }

    let content_length = response.content_length();
    let allows_body = response_allows_body(status, method_upper.as_str());

    let body_handle = if allows_body {
        let stream: ResponseBodyStream = Box::pin(response.bytes_stream());
        Some(store_body_stream(stream))
    } else {
        None
    };

    Ok(Response {
        status,
        headers: response_headers,
        body_handle,
        cookies,
        url: final_url,
        content_length,
    })
}

fn build_client(config: &SessionConfig) -> Result<HttpClient> {
    let emulation = EmulationOption::builder()
        .emulation(config.emulation)
        .emulation_os(config.emulation_os)
        .build();

    let mut client_builder = HttpClient::builder()
        .emulation(emulation)
        .cookie_store(true);

    if let Some(proxy_url) = config.proxy.as_deref() {
        let proxy = Proxy::all(proxy_url).context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    if config.insecure {
        client_builder = client_builder.cert_verification(false);
    }

    client_builder
        .build()
        .context("Failed to build HTTP client")
}

fn emulation_label(emulation: &Emulation, os: &EmulationOS) -> String {
    let browser = match serde_json::to_value(emulation) {
        Ok(Value::String(label)) => label,
        _ => "chrome_142".to_string(),
    };

    let os_label = match serde_json::to_value(os) {
        Ok(Value::String(label)) => label,
        _ => "macos".to_string(),
    };

    format!("{}@{}", browser, os_label)
}

fn response_allows_body(status: u16, method: &str) -> bool {
    if method.eq_ignore_ascii_case("HEAD") {
        return false;
    }

    match status {
        101 | 204 | 205 | 304 => false,
        _ => true,
    }
}

pub fn create_managed_session(
    session_id: String,
    emulation: Emulation,
    emulation_os: EmulationOS,
    proxy: Option<String>,
    insecure: bool,
) -> Result<String> {
    let config = SessionConfig::new(emulation, emulation_os, proxy, insecure);
    SESSION_MANAGER.create_session(session_id, config)
}

pub fn clear_managed_session(session_id: &str) -> Result<()> {
    SESSION_MANAGER.clear_session(session_id)
}

pub fn drop_managed_session(session_id: &str) {
    SESSION_MANAGER.drop_session(session_id);
}

pub fn generate_session_id() -> String {
    Uuid::new_v4().to_string()
}
