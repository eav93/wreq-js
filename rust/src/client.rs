use anyhow::{Context, Result};
use moka::sync::Cache;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Runtime;
use uuid::Uuid;
use wreq::{Client as HttpClient, Proxy};
use wreq_util::Emulation;

pub static HTTP_RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to create shared HTTP runtime")
});

static SESSION_MANAGER: Lazy<SessionManager> = Lazy::new(SessionManager::new);

#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub url: String,
    pub emulation: Emulation,
    pub headers: HashMap<String, String>,
    pub method: String,
    pub body: Option<String>,
    pub proxy: Option<String>,
    pub timeout: u64,
    pub session_id: String,
    pub ephemeral: bool,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub cookies: HashMap<String, String>,
    pub url: String,
}

#[derive(Clone)]
struct SessionConfig {
    emulation: Emulation,
    label: String,
    proxy: Option<String>,
}

impl SessionConfig {
    fn from_request(options: &RequestOptions) -> Self {
        Self {
            emulation: options.emulation.clone(),
            label: emulation_label(&options.emulation),
            proxy: options.proxy.clone(),
        }
    }

    fn new(emulation: Emulation, proxy: Option<String>) -> Self {
        let label = emulation_label(&emulation);
        Self {
            emulation,
            label,
            proxy,
        }
    }

    fn matches(&self, other: &SessionConfig) -> bool {
        self.label == other.label && self.proxy == other.proxy
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
                    "Session '{}' was created with different browser/proxy configuration",
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
        ..
    } = options;

    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method
    };

    let method_upper = method.to_uppercase();

    // Build request
    let mut request = match method_upper.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        "HEAD" => client.head(&url),
        _ => return Err(anyhow::anyhow!("Unsupported HTTP method: {}", method_upper)),
    };

    // Apply custom headers
    for (key, value) in headers {
        request = request.header(&key, &value);
    }

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
    let mut response_headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            response_headers.insert(key.to_string(), value_str.to_string());
        }
    }

    // Extract cookies
    let mut cookies = HashMap::new();
    for cookie in response.cookies() {
        cookies.insert(cookie.name().to_string(), cookie.value().to_string());
    }

    // Get body
    let body = response
        .text()
        .await
        .context("Failed to read response body")?;

    Ok(Response {
        status,
        headers: response_headers,
        body,
        cookies,
        url: final_url,
    })
}

fn build_client(config: &SessionConfig) -> Result<HttpClient> {
    let mut client_builder = HttpClient::builder()
        .emulation(config.emulation.clone())
        .cookie_store(true);

    if let Some(proxy_url) = config.proxy.as_deref() {
        let proxy = Proxy::all(proxy_url).context("Failed to create proxy")?;
        client_builder = client_builder.proxy(proxy);
    }

    client_builder
        .build()
        .context("Failed to build HTTP client")
}

fn emulation_label(emulation: &Emulation) -> String {
    match serde_json::to_value(emulation) {
        Ok(Value::String(label)) => label,
        _ => "chrome_142".to_string(),
    }
}

pub fn create_managed_session(session_id: String, emulation: Emulation, proxy: Option<String>) -> Result<String> {
    let config = SessionConfig::new(emulation, proxy);
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
