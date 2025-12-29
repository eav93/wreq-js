// Import and re-export the auto-generated BrowserProfile and EmulationOS types
import type { BrowserProfile, EmulationOS } from "./generated-types.js";
import type { Session, Transport } from "./wreq-js.js";
export type { BrowserProfile, EmulationOS };

/**
 * Controls how cookies are scoped for a request.
 * - "session": reuse an explicit Session or sessionId across calls.
 * - "ephemeral": create an isolated, single-use session.
 */
export type CookieMode = "session" | "ephemeral";

/**
 * Minimal handle implemented by {@link Session}. Exposed for integrations
 * that only need to carry a session id.
 */
export interface SessionHandle {
  readonly id: string;
}

/**
 * A tuple of [name, value] pairs used for initializing headers.
 * Both name and value must be strings.
 *
 * @example
 * ```typescript
 * const headers: HeaderTuple = ['Content-Type', 'application/json'];
 * ```
 */
export type HeaderTuple = [string, string];

/**
 * Represents various input types accepted when creating or initializing headers.
 * Can be an iterable of header tuples, an array of tuples, or a plain object.
 *
 * @example
 * ```typescript
 * // As an object
 * const headers: HeadersInit = { 'Content-Type': 'application/json' };
 *
 * // As an array of tuples
 * const headers: HeadersInit = [['Content-Type', 'application/json']];
 *
 * // As an iterable
 * const headers: HeadersInit = new Map([['Content-Type', 'application/json']]);
 * ```
 */
export type HeadersInit =
  | Iterable<HeaderTuple>
  | Array<HeaderTuple>
  | Record<string, string | number | boolean | null | undefined>;

/**
 * Represents the various types of data that can be used as a request body.
 * Supports string, binary data (ArrayBuffer, ArrayBufferView), URL-encoded parameters, and Node.js Buffer.
 *
 * @example
 * ```typescript
 * // String body
 * const body: BodyInit = JSON.stringify({ key: 'value' });
 *
 * // URLSearchParams
 * const body: BodyInit = new URLSearchParams({ key: 'value' });
 *
 * // Buffer
 * const body: BodyInit = Buffer.from('data');
 * ```
 */
export type BodyInit = string | ArrayBuffer | ArrayBufferView | URLSearchParams | Buffer;

/**
 * Options for configuring a fetch request. Compatible with the standard Fetch API
 * with additional wreq-specific extensions for browser impersonation, proxies, and timeouts.
 *
 * @example
 * ```typescript
 * const options: RequestInit = {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ key: 'value' }),
 *   browser: 'chrome_142',
 *   proxy: 'http://proxy.example.com:8080',
 *   timeout: 5000
 * };
 * ```
 */
export interface RequestInit {
  /**
   * A string to set request's method.
   * @default 'GET'
   */
  method?: string;

  /**
   * A Headers object, an object literal, or an array of two-item arrays to set request's headers.
   */
  headers?: HeadersInit;

  /**
   * A BodyInit object or null to set request's body.
   */
  body?: BodyInit | null;

  /**
   * An AbortSignal to set request's signal.
   */
  signal?: AbortSignal | null;

  /**
   * A string indicating whether request follows redirects, results in an error upon
   * encountering a redirect, or returns the redirect (in an opaque fashion).
   * @default 'follow'
   */
  redirect?: "follow" | "manual" | "error";

  /**
   * Transport instance to use for this request. When provided, transport-level
   * options such as `browser`, `os`, `proxy`, and `insecure` must not be set.
   */
  transport?: Transport;

  /**
   * Browser profile to impersonate for this request.
   * Automatically applies browser-specific headers, TLS fingerprints, and HTTP/2 settings.
   * Ignored when `transport` is provided.
   * @default 'chrome_142'
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate for this request.
   * Influences platform-specific headers and TLS fingerprints.
   * Ignored when `transport` is provided.
   * @default 'macos'
   */
  os?: EmulationOS;

  /**
   * Proxy URL to route the request through (e.g., 'http://proxy.example.com:8080').
   * Supports HTTP and SOCKS5 proxies.
   * Ignored when `transport` is provided.
   */
  proxy?: string;

  /**
   * Request timeout in milliseconds. If the request takes longer than this value,
   * it will be aborted.
   * @default 30000
   */
  timeout?: number;

  /**
   * Controls how cookies are managed for this call.
   * - "ephemeral": default when no session/sessionId is provided. Creates an isolated session per request.
   * - "session": requires an explicit session or sessionId and reuses its cookie jar.
   */
  cookieMode?: CookieMode;

  /**
   * Session instance to bind this request to. When provided, {@link cookieMode}
   * automatically behaves like `"session"`.
   */
  session?: Session;

  /**
   * Identifier of an existing session created elsewhere (e.g., via {@link createSession}).
   */
  sessionId?: string;

  /**
   * Disable default headers from browser emulation. When enabled, only explicitly
   * provided headers will be sent with the request, preventing emulation headers
   * from being automatically added or appended.
   * @default false
   */
  disableDefaultHeaders?: boolean;

  /**
   * Disable HTTPS certificate verification. When enabled, self-signed and invalid
   * certificates will be accepted.
   * Ignored when `transport` is provided.
   *
   * # Warning
   *
   * You should think very carefully before using this method. If invalid
   * certificates are trusted, *any* certificate for *any* site will be
   * trusted for use. This includes expired certificates. This introduces
   * significant vulnerabilities, and should only be used as a last resort.
   *
   * @default false
   */
  insecure?: boolean;
}

/**
 * Configuration for {@link createSession}.
 */
export interface CreateSessionOptions {
  /**
   * Provide a custom identifier instead of an auto-generated random ID.
   */
  sessionId?: string;

  /**
   * Default headers applied to every request made through this session.
   */
  defaultHeaders?: HeadersInit;

  /**
   * Browser profile to bind to this session. Defaults to 'chrome_142'.
   *
   * @deprecated Use {@link createTransport} and pass the transport to requests instead.
   */
  browser?: BrowserProfile;

  /**
   * Operating system to bind to this session. Defaults to 'macos'.
   *
   * @deprecated Use {@link createTransport} and pass the transport to requests instead.
   */
  os?: EmulationOS;
  /**
   * Optional proxy for every request made through the session.
   *
   * @deprecated Use {@link createTransport} and pass the transport to requests instead.
   */
  proxy?: string;
  /**
   * Default timeout applied when {@link Session.fetch} is called without
   * overriding `timeout`.
   */
  timeout?: number;

  /**
   * Disable HTTPS certificate verification. When enabled, self-signed and invalid
   * certificates will be accepted for all requests made through this session.
   *
   * @deprecated Use {@link createTransport} and pass the transport to requests instead.
   *
   * # Warning
   *
   * You should think very carefully before using this method. If invalid
   * certificates are trusted, *any* certificate for *any* site will be
   * trusted for use. This includes expired certificates. This introduces
   * significant vulnerabilities, and should only be used as a last resort.
   *
   * @default false
   */
  insecure?: boolean;
}

/**
 * Configuration for {@link createTransport}.
 */
export interface CreateTransportOptions {
  /**
   * Proxy URL to route requests through (e.g., 'http://proxy.example.com:8080').
   */
  proxy?: string;

  /**
   * Browser profile to impersonate for this transport.
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate for this transport.
   */
  os?: EmulationOS;

  /**
   * Disable HTTPS certificate verification for this transport.
   */
  insecure?: boolean;

  /**
   * Idle timeout for pooled connections (ms).
   */
  poolIdleTimeout?: number;

  /**
   * Maximum number of idle connections per host.
   */
  poolMaxIdlePerHost?: number;

  /**
   * Maximum total connections in the pool.
   */
  poolMaxSize?: number;

  /**
   * TCP connect timeout (ms).
   */
  connectTimeout?: number;

  /**
   * Read timeout (ms).
   */
  readTimeout?: number;
}

/**
 * Legacy request options interface. This interface is deprecated and will be removed in a future version.
 *
 * @deprecated Use {@link RequestInit} with the standard `fetch()` API instead.
 *
 * @example
 * ```typescript
 * // Old (deprecated):
 * const options: RequestOptions = {
 *   url: 'https://api.example.com',
 *   method: 'POST',
 *   body: JSON.stringify({ data: 'value' })
 * };
 *
 * // New (recommended):
 * const response = await fetch('https://api.example.com', {
 *   method: 'POST',
 *   body: JSON.stringify({ data: 'value' })
 * });
 * ```
 */
export interface RequestOptions {
  /**
   * The URL to request.
   */
  url: string;

  /**
   * Browser profile to impersonate.
   * Automatically applies browser-specific headers, TLS fingerprints, and HTTP/2 settings.
   * @default 'chrome_142'
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate.
   * @default 'macos'
   */
  os?: EmulationOS;

  /**
   * HTTP method to use for the request.
   * @default 'GET'
   */
  method?: string;

  /**
   * Additional headers to send with the request.
   * Browser-specific headers will be automatically added based on the selected browser profile.
   */
  headers?: Record<string, string> | HeaderTuple[];

  /**
   * Request body data (for POST, PUT, PATCH requests).
   */
  body?: Buffer;

  /**
   * Transport instance to use for this request. When provided, transport-level
   * options such as `browser`, `os`, `proxy`, and `insecure` must not be set.
   */
  transport?: Transport;

  /**
   * Proxy URL to route the request through (e.g., 'http://proxy.example.com:8080').
   * Supports HTTP and SOCKS5 proxies.
   */
  proxy?: string;

  /**
   * Redirect policy applied to this request. Matches the `redirect` option accepted by {@link fetch}.
   * @default "follow"
   */
  redirect?: "follow" | "manual" | "error";

  /**
   * Request timeout in milliseconds. If the request takes longer than this value,
   * it will be aborted.
   * @default 30000
   */
  timeout?: number;

  /**
   * Identifier for the session that should handle this request.
   * @internal
   */
  sessionId?: string;

  /**
   * Internal flag indicating whether the session should be discarded once the
   * request finishes.
   * @internal
   */
  ephemeral?: boolean;

  /**
   * Disable default headers from browser emulation. When enabled, only explicitly
   * provided headers will be sent with the request, preventing emulation headers
   * from being automatically added or appended.
   * @default false
   */
  disableDefaultHeaders?: boolean;

  /**
   * Disable HTTPS certificate verification. When enabled, self-signed and invalid
   * certificates will be accepted.
   *
   * # Warning
   *
   * You should think very carefully before using this method. If invalid
   * certificates are trusted, *any* certificate for *any* site will be
   * trusted for use. This includes expired certificates. This introduces
   * significant vulnerabilities, and should only be used as a last resort.
   *
   * @default false
   */
  insecure?: boolean;
}

/**
 * Internal response payload returned from the native Rust binding.
 * This interface represents the raw response data before it's converted
 * to a standard Response object.
 *
 * @internal
 */
export interface NativeResponse {
  /**
   * HTTP status code (e.g., 200, 404, 500).
   */
  status: number;

  /**
   * Response headers as [name, value] tuples.
   * Header names are normalized to lowercase.
   */
  headers: HeaderTuple[];

  /**
   * Handle for streaming response body chunks from the native layer.
   * When `null`, the response does not have a body (e.g., HEAD/204/304).
   */
  bodyHandle: number | null;

  /**
   * Inline body buffer returned for small payloads. When present, `bodyHandle`
   * will be `null` to avoid a second native round-trip to read the body.
   */
  bodyBytes: Buffer | null;

  /**
   * Optional Content-Length hint reported by the server after decompression.
   */
  contentLength: number | null;

  /**
   * Cookies set by the server as [name, value] tuples.
   */
  cookies: HeaderTuple[];

  /**
   * Final URL after following any redirects.
   * If no redirects occurred, this will match the original request URL.
   */
  url: string;
}

/**
 * Configuration options for creating a WebSocket connection.
 * Supports browser impersonation and proxies, similar to HTTP requests.
 *
 * @example
 * ```typescript
 * const ws = await createWebSocket({
 *   url: 'wss://echo.websocket.org',
 *   browser: 'chrome_142',
 *   headers: { 'Authorization': 'Bearer token' },
 *   onMessage: (data) => {
 *     console.log('Received:', data);
 *   },
 *   onClose: () => {
 *     console.log('Connection closed');
 *   },
 *   onError: (error) => {
 *     console.error('WebSocket error:', error);
 *   }
 * });
 * ```
 */
export interface WebSocketOptions {
  /**
   * The WebSocket URL to connect to. Must use wss:// (secure) or ws:// (insecure) protocol.
   */
  url: string;

  /**
   * Browser profile to impersonate for the WebSocket upgrade request.
   * Automatically applies browser-specific headers and TLS fingerprints.
   * @default 'chrome_142'
   */
  browser?: BrowserProfile;

  /**
   * Operating system to emulate for the WebSocket handshake.
   * @default 'macos'
   */
  os?: EmulationOS;

  /**
   * Additional headers to send with the WebSocket upgrade request.
   * Common headers include Authorization, Origin, or custom application headers.
   */
  headers?: Record<string, string> | HeaderTuple[];

  /**
   * Proxy URL to route the connection through (e.g., 'http://proxy.example.com:8080').
   * Supports HTTP and SOCKS5 proxies.
   */
  proxy?: string;

  /**
   * Callback function invoked when a message is received from the server.
   * The data parameter will be a string for text frames or a Buffer for binary frames.
   *
   * @param data - The received message as a string or Buffer
   */
  onMessage: (data: string | Buffer) => void;

  /**
   * Callback function invoked when the WebSocket connection is closed.
   * This is called for both clean closes and connection errors.
   */
  onClose?: () => void;

  /**
   * Callback function invoked when a connection or protocol error occurs.
   *
   * @param error - A string describing the error that occurred
   */
  onError?: (error: string) => void;
}

/**
 * Internal WebSocket connection object returned from the native Rust binding.
 * This interface contains the connection ID used to reference the WebSocket
 * in subsequent operations like sending messages or closing the connection.
 *
 * @internal
 */
export interface NativeWebSocketConnection {
  /**
   * Unique identifier for this WebSocket connection.
   * Used internally to track and manage the connection.
   * @internal
   */
  _id: number;
}

/**
 * Error thrown when a request fails. This can occur due to network errors,
 * timeouts, invalid URLs, or other request-related issues.
 *
 * @example
 * ```typescript
 * try {
 *   const response = await fetch('https://api.example.com');
 * } catch (error) {
 *   if (error instanceof RequestError) {
 *     console.error('Request failed:', error.message);
 *   }
 * }
 * ```
 */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}
