use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{Stream, StreamExt};
use moka::sync::Cache;
use std::borrow::Cow;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::Mutex;
use uuid::Uuid;
use wreq::{Client as HttpClient, Method, Proxy, redirect};
use wreq::cookie::Jar;
use wreq_util::{Emulation, EmulationOS, EmulationOption};

pub static HTTP_RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create shared HTTP runtime")
});

static SESSION_MANAGER: LazyLock<SessionManager> = LazyLock::new(SessionManager::new);
static EPHEMERAL_MANAGER: LazyLock<EphemeralClientManager> = LazyLock::new(EphemeralClientManager::new);
static TRANSPORT_MANAGER: LazyLock<TransportManager> = LazyLock::new(TransportManager::new);

// Responses at or below this size (bytes) are fully buffered in Rust and returned
// inline to Node, avoiding an extra round-trip to stream the body.
const INLINE_BODY_MAX: u64 = 64 * 1024;

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
    pub headers: Vec<(String, String)>,
    pub method: String,
    pub body: Option<Vec<u8>>,
    pub proxy: Option<Arc<str>>,
    pub timeout: u64,
    pub redirect: RedirectMode,
    pub session_id: String,
    pub ephemeral: bool,
    pub disable_default_headers: bool,
    pub insecure: bool,
    pub transport_id: Option<String>,
    pub pool_idle_timeout: Option<u64>,
    pub pool_max_idle_per_host: Option<usize>,
    pub pool_max_size: Option<u32>,
    pub connect_timeout: Option<u64>,
    pub read_timeout: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_handle: Option<u64>,
    pub body_bytes: Option<Bytes>,
    pub cookies: Vec<(String, String)>,
    pub url: String,
    pub content_length: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SessionConfig {
    emulation: Emulation,
    emulation_os: EmulationOS,
    proxy: Option<Arc<str>>,
    insecure: bool,
}

impl SessionConfig {
    #[inline]
    fn from_request(options: &RequestOptions) -> Self {
        Self {
            emulation: options.emulation,
            emulation_os: options.emulation_os,
            proxy: options.proxy.clone(),
            insecure: options.insecure,
        }
    }
}

#[derive(Debug, Clone)]
struct TransportConfig {
    emulation: Emulation,
    emulation_os: EmulationOS,
    proxy: Option<Arc<str>>,
    insecure: bool,
    pool_idle_timeout: Option<Duration>,
    pool_max_idle_per_host: Option<usize>,
    pool_max_size: Option<u32>,
    connect_timeout: Option<Duration>,
    read_timeout: Option<Duration>,
}

impl TransportConfig {
    #[inline]
    fn from_request(options: &RequestOptions) -> Self {
        Self {
            emulation: options.emulation,
            emulation_os: options.emulation_os,
            proxy: options.proxy.clone(),
            insecure: options.insecure,
            pool_idle_timeout: options.pool_idle_timeout.map(Duration::from_millis),
            pool_max_idle_per_host: options.pool_max_idle_per_host,
            pool_max_size: options.pool_max_size,
            connect_timeout: options.connect_timeout.map(Duration::from_millis),
            read_timeout: options.read_timeout.map(Duration::from_millis),
        }
    }

    #[inline]
    fn new(
        emulation: Emulation,
        emulation_os: EmulationOS,
        proxy: Option<Arc<str>>,
        insecure: bool,
        pool_idle_timeout: Option<u64>,
        pool_max_idle_per_host: Option<usize>,
        pool_max_size: Option<u32>,
        connect_timeout: Option<u64>,
        read_timeout: Option<u64>,
    ) -> Self {
        Self {
            emulation,
            emulation_os,
            proxy,
            insecure,
            pool_idle_timeout: pool_idle_timeout.map(Duration::from_millis),
            pool_max_idle_per_host,
            pool_max_size,
            connect_timeout: connect_timeout.map(Duration::from_millis),
            read_timeout: read_timeout.map(Duration::from_millis),
        }
    }
}

#[derive(Clone)]
struct TransportEntry {
    client: Arc<HttpClient>,
}

#[derive(Clone)]
struct SessionEntry {
    cookie_jar: Arc<Jar>,
}

struct TransportManager {
    explicit: DashMap<String, Arc<TransportEntry>>,
}

struct SessionManager {
    cache: Cache<String, Arc<SessionEntry>>,
}

struct EphemeralClientManager {
    cache: Cache<SessionConfig, Arc<HttpClient>>,
}

pub type ResponseBodyStream = Pin<Box<dyn Stream<Item = wreq::Result<Bytes>> + Send>>;

static BODY_STREAMS: LazyLock<DashMap<u64, Arc<Mutex<ResponseBodyStream>>>> = LazyLock::new(DashMap::new);
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

/// Read entire body into a single buffer. More efficient than streaming for small bodies.
pub async fn read_body_all(handle: u64) -> Result<Bytes> {
    let stream = BODY_STREAMS
        .remove(&handle)
        .map(|(_, v)| v)
        .ok_or_else(|| anyhow!("Body handle {} not found", handle))?;

    let mut guard = stream.lock().await;
    let mut chunks: Vec<Bytes> = Vec::new();
    let mut total_len = 0usize;

    while let Some(result) = guard.next().await {
        let bytes = result?;
        total_len += bytes.len();
        chunks.push(bytes);
    }

    // Fast path: single chunk or empty
    if chunks.is_empty() {
        return Ok(Bytes::new());
    }
    if chunks.len() == 1 {
        return Ok(chunks.into_iter().next().unwrap());
    }

    // Multiple chunks: consolidate
    let mut buf = Vec::with_capacity(total_len);
    for chunk in chunks {
        buf.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(buf))
}

pub fn drop_body_stream(handle: u64) {
    BODY_STREAMS.remove(&handle);
}

impl TransportManager {
    fn new() -> Self {
        Self {
            explicit: DashMap::new(),
        }
    }

    fn create_transport(&self, config: TransportConfig) -> Result<String> {
        let client = Arc::new(build_client(&config)?);
        let entry = Arc::new(TransportEntry { client });
        let id = Uuid::new_v4().to_string();
        self.explicit.insert(id.clone(), entry);
        Ok(id)
    }

    fn get_transport(&self, transport_id: &str) -> Result<Arc<HttpClient>> {
        self.explicit
            .get(transport_id)
            .map(|entry| entry.client.clone())
            .ok_or_else(|| anyhow!("Transport '{}' not found", transport_id))
    }

    fn drop_transport(&self, transport_id: &str) {
        self.explicit.remove(transport_id);
    }
}

impl SessionManager {
    fn new() -> Self {
        Self {
            cache: Cache::builder()
                .time_to_idle(Duration::from_secs(300))
                .build(),
        }
    }

    fn jar_for(&self, session_id: &str) -> Result<Arc<Jar>> {
        if let Some(entry) = self.cache.get(session_id) {
            return Ok(entry.cookie_jar.clone());
        }

        let entry = Arc::new(SessionEntry {
            cookie_jar: Arc::new(Jar::default()),
        });
        self.cache.insert(session_id.to_string(), entry.clone());
        Ok(entry.cookie_jar.clone())
    }

    fn create_session(&self, session_id: String) -> Result<String> {
        let entry = Arc::new(SessionEntry {
            cookie_jar: Arc::new(Jar::default()),
        });
        self.cache.insert(session_id.clone(), entry);
        Ok(session_id)
    }

    fn clear_session(&self, session_id: &str) -> Result<()> {
        let entry = self
            .cache
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session '{}' not found", session_id))?;
        entry.cookie_jar.clear();
        Ok(())
    }

    fn drop_session(&self, session_id: &str) {
        self.cache.invalidate(session_id);
    }
}

impl EphemeralClientManager {
    fn new() -> Self {
        Self {
            cache: Cache::builder()
                .time_to_idle(Duration::from_secs(300))
                .build(),
        }
    }

    fn client_for(&self, config: SessionConfig) -> Result<Arc<HttpClient>> {
        if let Some(client) = self.cache.get(&config) {
            return Ok(client);
        }

        let client = Arc::new(build_ephemeral_client(&config)?);
        self.cache.insert(config, client.clone());
        Ok(client)
    }
}

pub async fn make_request(options: RequestOptions) -> Result<Response> {
    let transport_id = options.transport_id.clone();

    // Resolve client: explicit transport > ephemeral cache > fresh client
    let client = if let Some(ref tid) = transport_id {
        TRANSPORT_MANAGER.get_transport(tid)?
    } else if options.ephemeral {
        let config = SessionConfig::from_request(&options);
        EPHEMERAL_MANAGER.client_for(config)?
    } else {
        let config = TransportConfig::from_request(&options);
        Arc::new(build_client(&config)?)
    };

    // Resolve cookie jar: ephemeral gets a fresh jar, sessions share one
    let cookie_jar = if options.ephemeral {
        Arc::new(Jar::default())
    } else {
        SESSION_MANAGER.jar_for(&options.session_id)?
    };

    make_request_inner(options, client, cookie_jar).await
}

async fn make_request_inner(
    options: RequestOptions,
    client: Arc<HttpClient>,
    cookie_jar: Arc<Jar>,
) -> Result<Response> {

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

    // Methods are already normalized to uppercase in JS; default to GET when empty.
    let method = if method.is_empty() {
        Cow::Borrowed("GET")
    } else {
        Cow::Owned(method)
    };

    let request_method = match method.as_ref() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        "PATCH" => Method::PATCH,
        "HEAD" => Method::HEAD,
        "OPTIONS" => Method::OPTIONS,
        "CONNECT" => Method::CONNECT,
        "TRACE" => Method::TRACE,
        _ => Method::from_bytes(method.as_bytes())
            .with_context(|| format!("Unsupported HTTP method: {}", method))?,
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

    request = request.cookie_provider(cookie_jar);

    // Execute request
    let response = request
        .send()
        .await
        .with_context(|| format!("{} {}", method, url))?;

    // Extract response data
    let status = response.status().as_u16();
    let final_url = response.uri().to_string();

    // Extract headers into a pre-allocated Vec (avoids IndexMap hashing overhead)
    let raw_headers = response.headers();
    let mut response_headers = Vec::with_capacity(raw_headers.len());
    for (key, value) in raw_headers {
        if let Ok(value_str) = value.to_str() {
            response_headers.push((key.as_str().to_owned(), value_str.to_owned()));
        }
    }

    // Extract cookies into a Vec
    let cookies: Vec<(String, String)> = response
        .cookies()
        .map(|c| (c.name().to_owned(), c.value().to_owned()))
        .collect();

    let mut content_length = response.content_length();
    let allows_body = response_allows_body(status, method.as_ref());

    let (body_handle, body_bytes) = if allows_body {
        let inline_eligible = content_length.map(|len| len <= INLINE_BODY_MAX).unwrap_or(false);

        if inline_eligible {
            let bytes = response.bytes().await?;
            content_length = Some(bytes.len() as u64);
            (None, Some(bytes))
        } else {
            let stream: ResponseBodyStream = Box::pin(response.bytes_stream());
            (Some(store_body_stream(stream)), None)
        }
    } else {
        (None, None)
    };

    Ok(Response {
        status,
        headers: response_headers,
        body_handle,
        body_bytes,
        cookies,
        url: final_url,
        content_length,
    })
}

/// Build a client for explicit transports (full pooling config).
fn build_client(config: &TransportConfig) -> Result<HttpClient> {
    let emulation = EmulationOption::builder()
        .emulation(config.emulation)
        .emulation_os(config.emulation_os)
        .build();

    let mut client_builder = HttpClient::builder().emulation(emulation);

    if let Some(proxy_url) = config.proxy.as_deref() {
        let proxy = Proxy::all(proxy_url).context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    if config.insecure {
        client_builder = client_builder.cert_verification(false);
    }

    if let Some(pool_idle_timeout) = config.pool_idle_timeout {
        client_builder = client_builder.pool_idle_timeout(pool_idle_timeout);
    }

    if let Some(pool_max_idle_per_host) = config.pool_max_idle_per_host {
        client_builder = client_builder.pool_max_idle_per_host(pool_max_idle_per_host);
    }

    if let Some(pool_max_size) = config.pool_max_size {
        client_builder = client_builder.pool_max_size(pool_max_size);
    }

    if let Some(connect_timeout) = config.connect_timeout {
        client_builder = client_builder.connect_timeout(connect_timeout);
    }

    if let Some(read_timeout) = config.read_timeout {
        client_builder = client_builder.read_timeout(read_timeout);
    }

    client_builder
        .build()
        .context("Failed to build HTTP client")
}

/// Build a client for ephemeral (stateless) requests - no connection pooling.
fn build_ephemeral_client(config: &SessionConfig) -> Result<HttpClient> {
    let emulation = EmulationOption::builder()
        .emulation(config.emulation)
        .emulation_os(config.emulation_os)
        .build();

    let mut client_builder = HttpClient::builder()
        .emulation(emulation)
        .pool_max_idle_per_host(0);

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

fn response_allows_body(status: u16, method: &str) -> bool {
    if method.eq_ignore_ascii_case("HEAD") {
        return false;
    }

    match status {
        101 | 204 | 205 | 304 => false,
        _ => true,
    }
}

pub fn create_managed_session(session_id: String) -> Result<String> {
    SESSION_MANAGER.create_session(session_id)
}

pub fn clear_managed_session(session_id: &str) -> Result<()> {
    SESSION_MANAGER.clear_session(session_id)
}

pub fn drop_managed_session(session_id: &str) {
    SESSION_MANAGER.drop_session(session_id);
}

pub fn create_managed_transport(
    emulation: Emulation,
    emulation_os: EmulationOS,
    proxy: Option<Arc<str>>,
    insecure: bool,
    pool_idle_timeout: Option<u64>,
    pool_max_idle_per_host: Option<usize>,
    pool_max_size: Option<u32>,
    connect_timeout: Option<u64>,
    read_timeout: Option<u64>,
) -> Result<String> {
    let config = TransportConfig::new(
        emulation,
        emulation_os,
        proxy,
        insecure,
        pool_idle_timeout,
        pool_max_idle_per_host,
        pool_max_size,
        connect_timeout,
        read_timeout,
    );
    TRANSPORT_MANAGER.create_transport(config)
}

pub fn drop_managed_transport(transport_id: &str) {
    TRANSPORT_MANAGER.drop_transport(transport_id);
}

pub fn generate_session_id() -> String {
    Uuid::new_v4().to_string()
}
