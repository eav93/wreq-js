use std::net::SocketAddr;

use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

static SMALL_BODY: &[u8] = b"OK";
static JSON_BODY: &[u8] = b"{\"ok\":true,\"message\":\"hello\"}";

const MAX_BINARY_LEN: usize = 1024 * 1024;
const DEFAULT_BINARY_LEN: usize = 4096;

fn parse_query_param(query: Option<&str>, key: &str) -> Option<usize> {
    query?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            v.parse().ok()
        } else {
            None
        }
    })
}

async fn handle(
    req: Request<Incoming>,
    binary_4k: Bytes,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let method = req.method();
    let path = req.uri().path();
    let query = req.uri().query();

    if method == Method::GET && path == "/small" {
        let resp = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/plain; charset=utf-8")
            .header("content-length", SMALL_BODY.len())
            .body(Full::new(Bytes::from_static(SMALL_BODY)))
            .unwrap();
        return Ok(resp);
    }

    if method == Method::GET && path == "/json" {
        let resp = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json; charset=utf-8")
            .header("content-length", JSON_BODY.len())
            .body(Full::new(Bytes::from_static(JSON_BODY)))
            .unwrap();
        return Ok(resp);
    }

    if method == Method::GET && path == "/binary" {
        let len = parse_query_param(query, "len")
            .map(|n| n.min(MAX_BINARY_LEN).max(1))
            .unwrap_or(DEFAULT_BINARY_LEN);

        let body = if len == DEFAULT_BINARY_LEN {
            binary_4k.clone()
        } else {
            Bytes::from(vec![0xab_u8; len])
        };

        let resp = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/octet-stream")
            .header("content-length", body.len())
            .body(Full::new(body))
            .unwrap();
        return Ok(resp);
    }

    if method == Method::POST && path == "/echo-len" {
        let expected_len = parse_query_param(query, "len").unwrap_or(0);

        // Drain the body
        use http_body_util::BodyExt;
        let collected = req.into_body().collect().await?.to_bytes();
        let received = collected.len();

        if expected_len > 0 && received != expected_len {
            let msg = format!("expected {expected_len}, got {received}");
            let resp = Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header("content-type", "text/plain; charset=utf-8")
                .body(Full::new(Bytes::from(msg)))
                .unwrap();
            return Ok(resp);
        }

        let resp = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Full::new(Bytes::new()))
            .unwrap();
        return Ok(resp);
    }

    let resp = Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from_static(b"not found")))
        .unwrap();
    Ok(resp)
}

fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build runtime");

    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, server_loop());
}

async fn server_loop() {
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = TcpListener::bind(addr).await.expect("failed to bind");
    let local_addr = listener.local_addr().expect("failed to get local addr");

    // Print port on first stdout line (read by JS launcher)
    println!("{}", local_addr.port());

    // Pre-allocate the 4KB binary body
    let binary_4k = Bytes::from(vec![0xab_u8; DEFAULT_BINARY_LEN]);

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(conn) => conn,
            Err(_) => continue,
        };

        let io = TokioIo::new(stream);
        let binary_4k = binary_4k.clone();

        tokio::task::spawn_local(async move {
            let service = service_fn(move |req| {
                let binary_4k = binary_4k.clone();
                handle(req, binary_4k)
            });

            if let Err(err) = hyper::server::conn::http1::Builder::new()
                .keep_alive(true)
                .serve_connection(io, service)
                .await
            {
                if !err.is_incomplete_message() {
                    eprintln!("connection error: {err}");
                }
            }
        });
    }
}
