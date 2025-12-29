import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { createRequire } from "node:module";
import { ReadableStream } from "node:stream/web";
import type {
  BodyInit,
  BrowserProfile,
  CookieMode,
  CreateSessionOptions,
  CreateTransportOptions,
  EmulationOS,
  HeadersInit,
  HeaderTuple,
  NativeResponse,
  NativeWebSocketConnection,
  RequestOptions,
  SessionHandle,
  WebSocketOptions,
  RequestInit as WreqRequestInit,
} from "./types.js";
import { RequestError } from "./types.js";

interface NativeWebSocketOptions {
  url: string;
  browser: BrowserProfile;
  os: EmulationOS;
  headers: Record<string, string> | HeaderTuple[];
  proxy?: string;
  onMessage: (data: string | Buffer) => void;
  onClose?: () => void;
  onError?: (error: string) => void;
}

interface NativeSessionOptions {
  sessionId: string;
}

interface NativeTransportOptions {
  browser: BrowserProfile;
  os: EmulationOS;
  proxy?: string;
  insecure?: boolean;
  poolIdleTimeout?: number;
  poolMaxIdlePerHost?: number;
  poolMaxSize?: number;
  connectTimeout?: number;
  readTimeout?: number;
}

interface NativeRequestOptions {
  url: string;
  method: string;
  browser?: BrowserProfile;
  os?: EmulationOS;
  headers?: HeaderTuple[];
  body?: Buffer;
  proxy?: string;
  timeout?: number;
  redirect?: "follow" | "manual" | "error";
  sessionId: string;
  ephemeral: boolean;
  disableDefaultHeaders?: boolean;
  insecure?: boolean;
  transportId?: string;
}

let nativeBinding: {
  request: (options: NativeRequestOptions, requestId: number, enableCancellation?: boolean) => Promise<NativeResponse>;
  cancelRequest: (requestId: number) => void;
  readBodyChunk: (handleId: number) => Promise<Buffer | null>;
  readBodyAll: (handleId: number) => Promise<Buffer>;
  cancelBody: (handleId: number) => void;
  getProfiles: () => string[];
  websocketConnect: (options: NativeWebSocketOptions) => Promise<NativeWebSocketConnection>;
  websocketSend: (ws: NativeWebSocketConnection, data: string | Buffer) => Promise<void>;
  websocketClose: (ws: NativeWebSocketConnection) => Promise<void>;
  createSession: (options: NativeSessionOptions) => string;
  clearSession: (sessionId: string) => void;
  dropSession: (sessionId: string) => void;
  createTransport: (options: NativeTransportOptions) => string;
  dropTransport: (transportId: string) => void;
  getOperatingSystems?: () => string[];
};

let cachedProfiles: BrowserProfile[] | undefined;
let cachedOperatingSystems: EmulationOS[] | undefined;

function detectLibc(): "gnu" | "musl" | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }

  const envLibc = process.env.LIBC ?? process.env.npm_config_libc;
  if (envLibc) {
    return envLibc.toLowerCase().includes("musl") ? "musl" : "gnu";
  }

  try {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const glibcVersion = report?.header?.glibcVersionRuntime;

    if (glibcVersion) {
      return "gnu";
    }

    return "musl";
  } catch {
    return "gnu";
  }
}

const require =
  typeof import.meta !== "undefined" && import.meta.url ? createRequire(import.meta.url) : createRequire(__filename);

function loadNativeBinding() {
  const platform = process.platform;
  const arch = process.arch;
  const libc = detectLibc();

  const platformArchMap: Record<string, Record<string, string | Record<"gnu" | "musl", string>>> = {
    darwin: { x64: "darwin-x64", arm64: "darwin-arm64" },
    linux: {
      x64: { gnu: "linux-x64-gnu", musl: "linux-x64-musl" },
      arm64: "linux-arm64-gnu",
    },
    win32: { x64: "win32-x64-msvc" },
  };

  const platformArchMapEntry = platformArchMap[platform]?.[arch];
  const platformArch =
    typeof platformArchMapEntry === "string"
      ? platformArchMapEntry
      : platformArchMapEntry?.[(libc ?? "gnu") as "gnu" | "musl"];

  if (!platformArch) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}${libc ? `-${libc}` : ""}. ` +
        `Supported platforms: darwin-x64, darwin-arm64, linux-x64-gnu, linux-x64-musl, ` +
        `linux-arm64-gnu, win32-x64-msvc`,
    );
  }

  const binaryName = `wreq-js.${platformArch}.node`;

  try {
    return require(`../rust/${binaryName}`);
  } catch {
    try {
      return require("../rust/wreq-js.node");
    } catch {
      throw new Error(
        `Failed to load native module for ${platform}-${arch}. ` +
          `Tried: ../rust/${binaryName} and ../rust/wreq-js.node. ` +
          `Make sure the package is installed correctly and the native module is built for your platform.`,
      );
    }
  }
}

nativeBinding = loadNativeBinding();

const websocketFinalizer =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<NativeWebSocketConnection>((connection: NativeWebSocketConnection) => {
        void nativeBinding.websocketClose(connection).catch(() => undefined);
      })
    : undefined;

type NativeBodyHandle = { id: number; released: boolean };

const bodyHandleFinalizer =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<NativeBodyHandle>((handle: NativeBodyHandle) => {
        if (handle.released) {
          return;
        }

        handle.released = true;
        try {
          nativeBinding.cancelBody(handle.id);
        } catch {
          // Best-effort cleanup; ignore binding-level failures.
        }
      })
    : undefined;

const DEFAULT_BROWSER: BrowserProfile = "chrome_142";
const DEFAULT_OS: EmulationOS = "macos";
const SUPPORTED_OSES: readonly EmulationOS[] = ["windows", "macos", "linux", "android", "ios"];
const UTF8_DECODER = new TextDecoder("utf-8");

type SessionDefaults = {
  browser: BrowserProfile;
  os: EmulationOS;
  proxy?: string;
  timeout?: number;
  insecure?: boolean;
  defaultHeaders?: HeaderTuple[];
  transportId?: string;
  ownsTransport?: boolean;
};

type SessionResolution = {
  sessionId: string;
  cookieMode: CookieMode;
  dropAfterRequest: boolean;
  defaults?: SessionDefaults;
};

type TransportResolution = {
  transportId?: string;
  browser?: BrowserProfile;
  os?: EmulationOS;
  proxy?: string;
  insecure?: boolean;
};

function generateSessionId(): string {
  return randomUUID();
}

function normalizeSessionOptions(options?: CreateSessionOptions): { sessionId: string; defaults: SessionDefaults } {
  const sessionId = options?.sessionId ?? generateSessionId();
  const defaults: SessionDefaults = {
    browser: options?.browser ?? DEFAULT_BROWSER,
    os: options?.os ?? DEFAULT_OS,
  };

  if (options?.proxy !== undefined) {
    defaults.proxy = options.proxy;
  }

  if (options?.timeout !== undefined) {
    validateTimeout(options.timeout);
    defaults.timeout = options.timeout;
  }

  if (options?.insecure !== undefined) {
    defaults.insecure = options.insecure;
  }

  if (options?.defaultHeaders !== undefined) {
    defaults.defaultHeaders = headersToTuples(options.defaultHeaders);
  }

  return { sessionId, defaults };
}

type HeaderStoreEntry = {
  name: string;
  values: string[];
};

function isIterable<T>(value: unknown): value is Iterable<T> {
  return Boolean(value) && typeof (value as Iterable<T>)[Symbol.iterator] === "function";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function coerceHeaderValue(value: unknown): string {
  return String(value);
}

export class Headers implements Iterable<[string, string]> {
  private readonly store = new Map<string, HeaderStoreEntry>();

  constructor(init?: HeadersInit) {
    if (init) {
      this.applyInit(init);
    }
  }

  private applyInit(init: HeadersInit) {
    if (init instanceof Headers) {
      for (const [name, value] of init) {
        this.append(name, value);
      }
      return;
    }

    if (Array.isArray(init) || isIterable<[string, string]>(init)) {
      for (const tuple of init as Iterable<[string, string]>) {
        if (!tuple) {
          continue;
        }
        const [name, value] = tuple;
        this.append(name, value);
      }
      return;
    }

    if (isPlainObject(init)) {
      for (const [name, value] of Object.entries(init)) {
        if (value === undefined || value === null) {
          continue;
        }
        this.set(name, coerceHeaderValue(value));
      }
    }
  }

  private normalizeName(name: string): { key: string; display: string } {
    if (typeof name !== "string") {
      throw new TypeError("Header name must be a string");
    }
    const trimmed = name.trim();
    if (!trimmed) {
      throw new TypeError("Header name must not be empty");
    }
    return { key: trimmed.toLowerCase(), display: trimmed };
  }

  private assertValue(value: unknown): string {
    if (value === undefined || value === null) {
      throw new TypeError("Header value must not be null or undefined");
    }

    return coerceHeaderValue(value);
  }

  append(name: string, value: unknown): void {
    const normalized = this.normalizeName(name);
    const existing = this.store.get(normalized.key);
    const coercedValue = this.assertValue(value);

    if (existing) {
      existing.values.push(coercedValue);
      return;
    }

    this.store.set(normalized.key, {
      name: normalized.display,
      values: [coercedValue],
    });
  }

  set(name: string, value: unknown): void {
    const normalized = this.normalizeName(name);
    const coercedValue = this.assertValue(value);

    this.store.set(normalized.key, {
      name: normalized.display,
      values: [coercedValue],
    });
  }

  get(name: string): string | null {
    const normalized = this.normalizeName(name);
    const entry = this.store.get(normalized.key);
    return entry ? entry.values.join(", ") : null;
  }

  has(name: string): boolean {
    const normalized = this.normalizeName(name);
    return this.store.has(normalized.key);
  }

  delete(name: string): void {
    const normalized = this.normalizeName(name);
    this.store.delete(normalized.key);
  }

  entries(): IterableIterator<[string, string]> {
    return this[Symbol.iterator]();
  }

  *keys(): IterableIterator<string> {
    for (const [name] of this) {
      yield name;
    }
  }

  *values(): IterableIterator<string> {
    for (const [, value] of this) {
      yield value;
    }
  }

  forEach(callback: (value: string, name: string, parent: Headers) => void, thisArg?: unknown): void {
    for (const [name, value] of this) {
      callback.call(thisArg, value, name, this);
    }
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    const generator = function* (store: Map<string, HeaderStoreEntry>) {
      for (const entry of store.values()) {
        yield [entry.name, entry.values.join(", ")] as [string, string];
      }
    };

    return generator(this.store);
  }

  toObject(): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of this) {
      result[name] = value;
    }

    return result;
  }

  toTuples(): HeaderTuple[] {
    const result: HeaderTuple[] = [];

    for (const [name, value] of this) {
      result.push([name, value]);
    }

    return result;
  }
}

function headersToTuples(init: HeadersInit): HeaderTuple[] {
  // Fast paths for common high-throughput cases.
  if (Array.isArray(init)) {
    return init as HeaderTuple[];
  }

  if (init instanceof Headers) {
    return init.toTuples();
  }

  const out: HeaderTuple[] = [];

  if (isPlainObject(init)) {
    for (const name in init) {
      if (!Object.hasOwn(init, name)) {
        continue;
      }

      const value = init[name];
      if (value === undefined || value === null) {
        continue;
      }

      out.push([name, String(value)]);
    }

    return out;
  }

  if (isIterable<HeaderTuple>(init)) {
    for (const tuple of init) {
      if (!tuple) {
        continue;
      }
      const [name, value] = tuple;
      out.push([name, value]);
    }

    return out;
  }

  return out;
}

function mergeHeaderTuples(
  defaults: HeaderTuple[] | undefined,
  overrides: HeadersInit | undefined,
): HeaderTuple[] | undefined {
  if (!defaults) {
    return overrides === undefined ? undefined : headersToTuples(overrides);
  }

  if (overrides === undefined) {
    return defaults;
  }

  const overrideTuples = headersToTuples(overrides);
  if (overrideTuples.length === 0) {
    return defaults;
  }

  const overrideKeys = new Set(overrideTuples.map(([name]) => name.toLowerCase()));
  const merged = defaults.filter(([name]) => !overrideKeys.has(name.toLowerCase()));
  merged.push(...overrideTuples);
  return merged;
}

type ResponseType = "basic" | "cors" | "error" | "opaque" | "opaqueredirect";

function cloneNativeResponse(payload: NativeResponse): NativeResponse {
  return {
    status: payload.status,
    headers: payload.headers.map(([name, value]): HeaderTuple => [name, value]),
    bodyHandle: payload.bodyHandle,
    bodyBytes: payload.bodyBytes,
    contentLength: payload.contentLength,
    cookies: payload.cookies.map(([name, value]): HeaderTuple => [name, value]),
    url: payload.url,
  };
}

function releaseNativeBody(handle: NativeBodyHandle): void {
  if (handle.released) {
    return;
  }

  handle.released = true;

  try {
    nativeBinding.cancelBody(handle.id);
  } catch {
    // Best-effort cleanup; ignore binding errors.
  }

  bodyHandleFinalizer?.unregister(handle);
}

function createNativeBodyStream(handleId: number): ReadableStream<Uint8Array> {
  const handle: NativeBodyHandle = { id: handleId, released: false };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await nativeBinding.readBodyChunk(handle.id);

        if (chunk === null) {
          releaseNativeBody(handle);
          controller.close();
          return;
        }

        controller.enqueue(chunk);
      } catch (error) {
        releaseNativeBody(handle);
        controller.error(error);
      }
    },
    cancel() {
      releaseNativeBody(handle);
    },
  });

  bodyHandleFinalizer?.register(stream, handle, handle);

  return stream;
}

function wrapBodyStream(source: ReadableStream<Uint8Array>, onFirstUse: () => void): ReadableStream<Uint8Array> {
  let started = false;
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        onFirstUse();
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export class Response {
  readonly status: number;
  readonly ok: boolean;
  readonly contentLength: number | null;
  readonly url: string;
  readonly type: ResponseType = "basic";
  bodyUsed = false;

  private readonly payload: NativeResponse;
  private readonly requestUrl: string;
  private redirectedMemo: boolean | undefined;
  private readonly headersInit: HeaderTuple[];
  private headersInstance: Headers | null;
  private readonly cookiesInit: HeaderTuple[];
  private cookiesRecord: Record<string, string | string[]> | null;
  private inlineBody: Buffer | null;
  private bodySource: ReadableStream<Uint8Array> | null;
  private bodyStream: ReadableStream<Uint8Array> | null | undefined;
  // Track if we can use the fast path (native handle not yet wrapped in a stream)
  private nativeHandleAvailable: boolean;

  constructor(payload: NativeResponse, requestUrl: string, bodySource?: ReadableStream<Uint8Array> | null) {
    this.payload = payload;
    this.requestUrl = requestUrl;
    this.status = this.payload.status;
    this.ok = this.status >= 200 && this.status < 300;
    this.headersInit = this.payload.headers;
    this.headersInstance = null;
    this.url = this.payload.url;
    this.cookiesInit = this.payload.cookies;
    this.cookiesRecord = null;
    this.contentLength = this.payload.contentLength ?? null;
    this.inlineBody = this.payload.bodyBytes ?? null;

    if (typeof bodySource !== "undefined") {
      // External stream provided (e.g., from clone) - no fast path
      this.bodySource = bodySource;
      this.nativeHandleAvailable = false;
    } else if (this.inlineBody !== null) {
      // Inline body provided by native layer
      this.bodySource = null;
      this.nativeHandleAvailable = false;
    } else if (this.payload.bodyHandle !== null) {
      // Defer stream creation - we might use fast path instead
      this.bodySource = null;
      this.nativeHandleAvailable = true;
    } else {
      this.bodySource = null;
      this.nativeHandleAvailable = false;
    }

    this.bodyStream = undefined;
  }

  get redirected(): boolean {
    if (this.redirectedMemo !== undefined) {
      return this.redirectedMemo;
    }

    if (this.url === this.requestUrl) {
      this.redirectedMemo = false;
      return false;
    }

    const normalizedRequestUrl = normalizeUrlForComparison(this.requestUrl);
    this.redirectedMemo = normalizedRequestUrl ? this.url !== normalizedRequestUrl : true;
    return this.redirectedMemo;
  }

  get statusText(): string {
    return STATUS_CODES[this.status] ?? "";
  }

  get headers(): Headers {
    if (!this.headersInstance) {
      this.headersInstance = new Headers(this.headersInit);
    }
    return this.headersInstance;
  }

  get cookies(): Record<string, string | string[]> {
    if (!this.cookiesRecord) {
      const record: Record<string, string | string[]> = Object.create(null);
      for (const [name, value] of this.cookiesInit) {
        const existing = record[name];
        if (existing === undefined) {
          record[name] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          record[name] = [existing, value];
        }
      }
      this.cookiesRecord = record;
    }

    return this.cookiesRecord;
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (this.inlineBody && this.bodySource === null) {
      const bytes = this.inlineBody;
      this.inlineBody = null;
      this.bodySource = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }

    if (this.inlineBody === null && this.payload.bodyHandle === null && this.bodySource === null) {
      return null;
    }

    // Lazily create the stream if needed (disables fast path)
    if (this.bodySource === null && this.nativeHandleAvailable && this.payload.bodyHandle !== null) {
      this.bodySource = createNativeBodyStream(this.payload.bodyHandle);
      this.nativeHandleAvailable = false;
    }

    if (this.bodySource === null) {
      return null;
    }

    if (this.bodyStream === undefined) {
      this.bodyStream = wrapBodyStream(this.bodySource, () => {
        this.bodyUsed = true;
      });
    }

    return this.bodyStream;
  }

  async json<T = unknown>(): Promise<T> {
    const text = await this.text();
    return JSON.parse(text) as T;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.consumeBody();
    const { buffer, byteOffset, byteLength } = bytes;

    if (buffer instanceof ArrayBuffer) {
      return buffer.slice(byteOffset, byteOffset + byteLength);
    }

    const view = new Uint8Array(byteLength);
    view.set(bytes);
    return view.buffer;
  }

  async text(): Promise<string> {
    const bytes = await this.consumeBody();
    return UTF8_DECODER.decode(bytes);
  }

  clone(): Response {
    if (this.bodyUsed || this.bodyStream) {
      throw new TypeError("Cannot clone a Response whose body is already used");
    }

    // If we still have the native handle (fast path), we need to create the stream first
    if (this.nativeHandleAvailable && this.payload.bodyHandle !== null) {
      this.bodySource = createNativeBodyStream(this.payload.bodyHandle);
      this.nativeHandleAvailable = false;
    }

    if (this.bodySource === null) {
      return new Response(cloneNativeResponse(this.payload), this.requestUrl, null);
    }

    const [branchA, branchB] = this.bodySource.tee();

    // Reset cached stream so the original response uses the new branch lazily.
    this.bodySource = branchA;
    this.bodyStream = undefined;

    return new Response(cloneNativeResponse(this.payload), this.requestUrl, branchB);
  }

  private assertBodyAvailable(): void {
    if (this.bodyUsed) {
      throw new TypeError("Response body is already used");
    }
  }

  private async consumeBody(): Promise<Buffer> {
    this.assertBodyAvailable();
    this.bodyUsed = true;

    if (this.inlineBody) {
      const bytes = this.inlineBody;
      this.inlineBody = null;
      return bytes;
    }

    // Fast path: if native handle is still available, read entire body in one Rust call
    if (this.nativeHandleAvailable && this.payload.bodyHandle !== null) {
      this.nativeHandleAvailable = false;
      try {
        return await nativeBinding.readBodyAll(this.payload.bodyHandle);
      } catch (error) {
        // Handle already consumed or error
        if (String(error).includes("not found")) {
          return Buffer.alloc(0);
        }
        throw error;
      }
    }

    // Slow path: stream was accessed, use streaming consumption
    const stream = this.body;
    if (!stream) {
      return Buffer.alloc(0);
    }

    const reader = stream.getReader();
    const chunks: Buffer[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value && value.byteLength > 0) {
          if (Buffer.isBuffer(value)) {
            chunks.push(value);
          } else {
            chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          }
        }
      }
    } finally {
      // reader.releaseLock() is unnecessary here; letting the stream close naturally
      // ensures the underlying native handle is released.
    }

    return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
  }
}

export class Transport {
  readonly id: string;
  private disposed = false;

  constructor(id: string) {
    this.id = id;
  }

  get closed(): boolean {
    return this.disposed;
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    try {
      nativeBinding.dropTransport(this.id);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }
}

export class Session implements SessionHandle {
  readonly id: string;
  private disposed = false;
  private readonly defaults: SessionDefaults;

  constructor(id: string, defaults: SessionDefaults) {
    this.id = id;
    this.defaults = defaults;
  }

  get closed(): boolean {
    return this.disposed;
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new RequestError("Session has been closed");
    }
  }

  /** @internal */
  getDefaults(): SessionDefaults {
    const snapshot: SessionDefaults = { ...this.defaults };
    if (this.defaults.defaultHeaders) {
      snapshot.defaultHeaders = [...this.defaults.defaultHeaders];
    }
    return snapshot;
  }

  /** @internal */
  _defaultsRef(): SessionDefaults {
    return this.defaults;
  }

  async fetch(input: string | URL, init?: WreqRequestInit): Promise<Response> {
    this.ensureActive();
    const config: WreqRequestInit = init ? { ...init, session: this } : { session: this };
    return fetch(input, config);
  }

  async clearCookies(): Promise<void> {
    this.ensureActive();
    try {
      nativeBinding.clearSession(this.id);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const transportId = this.defaults.transportId;
    const ownsTransport = this.defaults.ownsTransport;

    try {
      nativeBinding.dropSession(this.id);
    } catch (error) {
      if (!ownsTransport || !transportId) {
        throw new RequestError(String(error));
      }
      // Fall through to transport cleanup and surface the original error after.
      const originalError = error;
      try {
        nativeBinding.dropTransport(transportId);
      } catch {
        // Ignore transport cleanup errors when a session drop error already occurred.
      }
      throw new RequestError(String(originalError));
    }

    if (ownsTransport && transportId) {
      try {
        nativeBinding.dropTransport(transportId);
      } catch (error) {
        throw new RequestError(String(error));
      }
    }
  }
}

function resolveSessionContext(config: WreqRequestInit): SessionResolution {
  const requestedMode = config.cookieMode ?? "ephemeral";
  const sessionCandidate = config.session;
  const providedSessionId = typeof config.sessionId === "string" ? config.sessionId.trim() : undefined;

  if (sessionCandidate && providedSessionId) {
    throw new RequestError("Provide either `session` or `sessionId`, not both.");
  }

  if (sessionCandidate) {
    if (!(sessionCandidate instanceof Session)) {
      throw new RequestError("`session` must be created via createSession()");
    }

    if (sessionCandidate.closed) {
      throw new RequestError("Session has been closed");
    }

    return {
      sessionId: sessionCandidate.id,
      cookieMode: "session",
      dropAfterRequest: false,
      defaults: sessionCandidate._defaultsRef(),
    };
  }

  if (providedSessionId) {
    if (!providedSessionId) {
      throw new RequestError("sessionId must not be empty");
    }

    if (requestedMode === "ephemeral") {
      throw new RequestError("cookieMode 'ephemeral' cannot be combined with sessionId");
    }

    return {
      sessionId: providedSessionId,
      cookieMode: "session",
      dropAfterRequest: false,
    };
  }

  if (requestedMode === "session") {
    throw new RequestError("cookieMode 'session' requires a session or sessionId");
  }

  return {
    sessionId: generateSessionId(),
    cookieMode: "ephemeral",
    dropAfterRequest: true,
  };
}

function resolveTransportContext(config: WreqRequestInit, sessionDefaults?: SessionDefaults): TransportResolution {
  if (config.transport !== undefined) {
    if (!(config.transport instanceof Transport)) {
      throw new RequestError("`transport` must be created via createTransport()");
    }

    if (config.transport.closed) {
      throw new RequestError("Transport has been closed");
    }

    const hasProxy = Object.hasOwn(config as object, "proxy");
    if (config.browser !== undefined || config.os !== undefined || hasProxy || config.insecure !== undefined) {
      throw new RequestError("`transport` cannot be combined with browser/os/proxy/insecure options");
    }

    return { transportId: config.transport.id };
  }

  if (sessionDefaults?.transportId) {
    if (config.browser !== undefined) {
      validateBrowserProfile(config.browser);
      if (config.browser !== sessionDefaults.browser) {
        throw new RequestError("Session browser cannot be changed after creation");
      }
    }

    if (config.os !== undefined) {
      validateOperatingSystem(config.os);
      if (config.os !== sessionDefaults.os) {
        throw new RequestError("Session operating system cannot be changed after creation");
      }
    }

    const initHasProxy = Object.hasOwn(config as object, "proxy");
    const requestedProxy = initHasProxy ? (config as { proxy?: string | null }).proxy : undefined;
    if (initHasProxy && requestedProxy !== undefined && (sessionDefaults.proxy ?? null) !== (requestedProxy ?? null)) {
      throw new RequestError("Session proxy cannot be changed after creation");
    }

    if (config.insecure !== undefined) {
      const lockedInsecure = sessionDefaults.insecure ?? false;
      if (config.insecure !== lockedInsecure) {
        throw new RequestError("Session insecure setting cannot be changed after creation");
      }
    }

    return { transportId: sessionDefaults.transportId };
  }

  const browser = config.browser ?? DEFAULT_BROWSER;
  const os = config.os ?? DEFAULT_OS;

  validateBrowserProfile(browser);
  validateOperatingSystem(os);

  const resolved: TransportResolution = { browser, os };
  if (config.proxy !== undefined) {
    resolved.proxy = config.proxy;
  }
  if (config.insecure !== undefined) {
    resolved.insecure = config.insecure;
  }
  return resolved;
}

interface AbortHandler {
  promise: Promise<never>;
  cleanup: () => void;
}

function createAbortError(reason?: unknown): Error {
  const fallbackMessage = typeof reason === "string" ? reason : "The operation was aborted";

  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return reason.name === "AbortError" ? reason : new DOMException(reason.message || fallbackMessage, "AbortError");
  }

  if (reason instanceof Error) {
    reason.name = "AbortError";
    return reason;
  }

  if (typeof DOMException !== "undefined") {
    return new DOMException(fallbackMessage, "AbortError");
  }

  const error = new Error(fallbackMessage);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): error is Error {
  return Boolean(error) && typeof (error as Error).name === "string" && (error as Error).name === "AbortError";
}

// Request IDs must stay below 2^48 to preserve integer precision across the bridge.
const REQUEST_ID_MAX = 2 ** 48;
// Seed with a monotonic-ish value derived from hrtime to avoid collisions after reloads.
let requestIdCounter = Math.trunc(Number(process.hrtime.bigint() % BigInt(REQUEST_ID_MAX - 1))) + 1;

function generateRequestId(): number {
  requestIdCounter += 1;
  if (requestIdCounter >= REQUEST_ID_MAX) {
    requestIdCounter = 1;
  }

  return requestIdCounter;
}

function setupAbort(signal: AbortSignal | null | undefined, cancelNative: () => void): AbortHandler | null {
  if (!signal) {
    return null;
  }

  if (signal.aborted) {
    cancelNative();
    throw createAbortError(signal.reason);
  }

  let onAbortListener: (() => void) | undefined;

  const promise = new Promise<never>((_, reject) => {
    onAbortListener = () => {
      cancelNative();
      reject(createAbortError(signal.reason));
    };

    signal.addEventListener("abort", onAbortListener, { once: true });
  });

  const cleanup = () => {
    if (onAbortListener) {
      signal.removeEventListener("abort", onAbortListener);
      onAbortListener = undefined;
    }
  };

  return { promise, cleanup };
}

function coerceUrlInput(input: string | URL): string {
  const value = typeof input === "string" ? input.trim() : input.href;

  if (!value) {
    throw new RequestError("URL is required");
  }

  return value;
}

function normalizeUrlForComparison(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function validateRedirectMode(mode?: WreqRequestInit["redirect"]): void {
  if (mode === undefined || mode === "follow" || mode === "manual" || mode === "error") {
    return;
  }

  throw new RequestError(`Redirect mode '${mode}' is not supported`);
}

function serializeBody(body?: BodyInit | null): Buffer | undefined {
  if (body === null || body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), "utf8");
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  throw new TypeError("Unsupported body type; expected string, Buffer, ArrayBuffer, or URLSearchParams");
}

function ensureMethod(method?: string): string {
  const normalized = method?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : "GET";
}

function ensureBodyAllowed(method: string, body?: Buffer): void {
  if (body === undefined) {
    return;
  }

  if (method === "GET" || method === "HEAD") {
    throw new RequestError(`Request with ${method} method cannot have a body`);
  }
}

function validateBrowserProfile(browser?: BrowserProfile): void {
  if (!browser) {
    return;
  }

  const profiles = getProfiles();

  if (!profiles.includes(browser)) {
    throw new RequestError(`Invalid browser profile: ${browser}. Available profiles: ${profiles.join(", ")}`);
  }
}

function validateOperatingSystem(os?: EmulationOS): void {
  if (!os) {
    return;
  }

  const operatingSystems = getOperatingSystems();

  if (!operatingSystems.includes(os)) {
    throw new RequestError(`Invalid operating system: ${os}. Available options: ${operatingSystems.join(", ")}`);
  }
}

function validateTimeout(timeout?: number): void {
  if (timeout === undefined) {
    return;
  }

  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    throw new RequestError("Timeout must be a finite number");
  }

  if (timeout <= 0) {
    throw new RequestError("Timeout must be greater than 0");
  }
}

function validatePositiveNumber(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestError(`${label} must be a finite number`);
  }

  if (value <= 0) {
    throw new RequestError(`${label} must be greater than 0`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RequestError(`${label} must be an integer`);
  }

  if (value < 0) {
    throw new RequestError(`${label} must be greater than or equal to 0`);
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RequestError(`${label} must be an integer`);
  }

  if (value <= 0) {
    throw new RequestError(`${label} must be greater than 0`);
  }
}

async function dispatchRequest(
  options: NativeRequestOptions,
  requestUrl: string,
  signal?: AbortSignal | null,
): Promise<Response> {
  // Fast path when no abort signal is provided: avoid Promise.race/allocation overhead.
  if (!signal) {
    const requestId = generateRequestId();
    let payload: NativeResponse;

    try {
      payload = (await nativeBinding.request(options, requestId, false)) as NativeResponse;
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }
      throw new RequestError(String(error));
    }

    return new Response(payload, requestUrl);
  }

  const requestId = generateRequestId();
  const cancelNative = () => {
    try {
      nativeBinding.cancelRequest(requestId);
    } catch {
      // Cancellation is best-effort; ignore binding errors here.
    }
  };

  const abortHandler = setupAbort(signal, cancelNative);
  if (!abortHandler) {
    // setupAbort only returns null when the signal is already aborted; treat as immediate abort.
    cancelNative();
    throw createAbortError(signal.reason);
  }

  const pending = Promise.race([nativeBinding.request(options, requestId, true), abortHandler.promise]);

  let payload: NativeResponse;

  try {
    payload = (await pending) as NativeResponse;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (error instanceof RequestError) {
      throw error;
    }

    throw new RequestError(String(error));
  } finally {
    abortHandler.cleanup();
  }

  return new Response(payload, requestUrl);
}

/**
 * Fetch-compatible entry point that adds browser impersonation controls.
 *
 * **Important:** The default fetch is isolated and non-persistent by design. Each request
 * uses a fresh connection with no shared state (cookies, TLS sessions). This prevents
 * TLS fingerprint leakage between requests.
 *
 * **Use {@link createSession} or {@link withSession} if you need:**
 * - Cookie persistence across requests
 * - TLS connection reuse for performance
 * - Shared connection state
 *
 * **Concurrency:** The core is unthrottled by design. Callers are expected to implement
 * their own concurrency control (e.g., p-limit) if needed. Built-in throttling would
 * reduce performance for high-throughput workloads.
 *
 * @param input - Request URL (string or URL instance)
 * @param init - Fetch-compatible init options
 *
 * @example
 * ```typescript
 * // Isolated request (no state persistence)
 * const response = await fetch('https://example.com');
 *
 * // For persistent cookies and connection reuse, use a session:
 * await withSession(async (session) => {
 *   await session.fetch('https://example.com/login', { method: 'POST', body: loginData });
 *   await session.fetch('https://example.com/protected'); // Cookies from login are sent
 * });
 * ```
 */
export async function fetch(input: string | URL, init?: WreqRequestInit): Promise<Response> {
  const url = coerceUrlInput(input);
  const config = init ?? {};
  const sessionContext = resolveSessionContext(config);
  const sessionDefaults = sessionContext.defaults;

  validateRedirectMode(config.redirect);

  if (config.timeout !== undefined) {
    validateTimeout(config.timeout);
  }

  const method = ensureMethod(config.method);
  const body = serializeBody(config.body ?? null);

  ensureBodyAllowed(method, body);

  // Only normalize headers when provided; avoids per-request header allocations on hot paths.
  // If the caller already provides HeaderTuple[], pass it through.
  const headerTuples = mergeHeaderTuples(sessionDefaults?.defaultHeaders, config.headers);

  const transport = resolveTransportContext(config, sessionDefaults);
  const timeout = config.timeout ?? sessionDefaults?.timeout;

  const requestOptions: NativeRequestOptions = {
    url,
    method,
    sessionId: sessionContext.sessionId,
    ephemeral: sessionContext.dropAfterRequest,
  };

  if (body !== undefined) {
    requestOptions.body = body;
  }

  if (transport.transportId) {
    requestOptions.transportId = transport.transportId;
  } else {
    requestOptions.browser = transport.browser ?? DEFAULT_BROWSER;
    requestOptions.os = transport.os ?? DEFAULT_OS;
    if (transport.proxy !== undefined) {
      requestOptions.proxy = transport.proxy;
    }
    if (transport.insecure !== undefined) {
      requestOptions.insecure = transport.insecure;
    }
  }

  if (timeout !== undefined) {
    requestOptions.timeout = timeout;
  }
  if (config.redirect !== undefined) {
    requestOptions.redirect = config.redirect;
  }
  if (config.disableDefaultHeaders !== undefined) {
    requestOptions.disableDefaultHeaders = config.disableDefaultHeaders;
  }

  if (headerTuples && headerTuples.length > 0) {
    requestOptions.headers = headerTuples;
  }

  return dispatchRequest(requestOptions, url, config.signal ?? null);
}

export async function createTransport(options?: CreateTransportOptions): Promise<Transport> {
  const browser = options?.browser ?? DEFAULT_BROWSER;
  const os = options?.os ?? DEFAULT_OS;

  validateBrowserProfile(browser);
  validateOperatingSystem(os);

  if (options?.poolIdleTimeout !== undefined) {
    validatePositiveNumber(options.poolIdleTimeout, "poolIdleTimeout");
  }
  if (options?.poolMaxIdlePerHost !== undefined) {
    validateNonNegativeInteger(options.poolMaxIdlePerHost, "poolMaxIdlePerHost");
  }
  if (options?.poolMaxSize !== undefined) {
    validatePositiveInteger(options.poolMaxSize, "poolMaxSize");
  }
  if (options?.connectTimeout !== undefined) {
    validatePositiveNumber(options.connectTimeout, "connectTimeout");
  }
  if (options?.readTimeout !== undefined) {
    validatePositiveNumber(options.readTimeout, "readTimeout");
  }

  try {
    const id = nativeBinding.createTransport({
      browser,
      os,
      ...(options?.proxy !== undefined && { proxy: options.proxy }),
      ...(options?.insecure !== undefined && { insecure: options.insecure }),
      ...(options?.poolIdleTimeout !== undefined && { poolIdleTimeout: options.poolIdleTimeout }),
      ...(options?.poolMaxIdlePerHost !== undefined && { poolMaxIdlePerHost: options.poolMaxIdlePerHost }),
      ...(options?.poolMaxSize !== undefined && { poolMaxSize: options.poolMaxSize }),
      ...(options?.connectTimeout !== undefined && { connectTimeout: options.connectTimeout }),
      ...(options?.readTimeout !== undefined && { readTimeout: options.readTimeout }),
    });

    return new Transport(id);
  } catch (error) {
    throw new RequestError(String(error));
  }
}

export async function createSession(options?: CreateSessionOptions): Promise<Session> {
  const { sessionId, defaults } = normalizeSessionOptions(options);

  validateBrowserProfile(defaults.browser);
  validateOperatingSystem(defaults.os);

  let createdId: string;
  let transportId: string;

  try {
    transportId = nativeBinding.createTransport({
      browser: defaults.browser,
      os: defaults.os,
      ...(defaults.proxy !== undefined && { proxy: defaults.proxy }),
      ...(defaults.insecure !== undefined && { insecure: defaults.insecure }),
    });
  } catch (error) {
    throw new RequestError(String(error));
  }

  try {
    createdId = nativeBinding.createSession({
      sessionId,
    });
  } catch (error) {
    try {
      nativeBinding.dropTransport(transportId);
    } catch {
      // Best-effort cleanup; prefer surfacing the original error.
    }
    throw new RequestError(String(error));
  }

  defaults.transportId = transportId;
  defaults.ownsTransport = true;

  return new Session(createdId, defaults);
}

export async function withSession<T>(
  fn: (session: Session) => Promise<T> | T,
  options?: CreateSessionOptions,
): Promise<T> {
  const session = await createSession(options);

  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/**
 * @deprecated Use {@link fetch} instead.
 */
export async function request(options: RequestOptions): Promise<Response> {
  if (!options.url) {
    throw new RequestError("URL is required");
  }

  const { url, ...rest } = options;
  const init: WreqRequestInit = {};

  if (rest.method !== undefined) {
    init.method = rest.method;
  }

  if (rest.headers !== undefined) {
    init.headers = rest.headers;
  }

  if (rest.body !== undefined) {
    init.body = rest.body;
  }

  if (rest.browser !== undefined) {
    init.browser = rest.browser;
  }

  if (rest.os !== undefined) {
    init.os = rest.os;
  }

  if (rest.proxy !== undefined) {
    init.proxy = rest.proxy;
  }

  if (rest.timeout !== undefined) {
    init.timeout = rest.timeout;
  }

  if (rest.sessionId !== undefined) {
    init.sessionId = rest.sessionId;
  }

  if (rest.transport !== undefined) {
    init.transport = rest.transport;
  }

  if (rest.disableDefaultHeaders !== undefined) {
    init.disableDefaultHeaders = rest.disableDefaultHeaders;
  }

  if (rest.redirect !== undefined) {
    init.redirect = rest.redirect;
  }

  return fetch(url, init);
}

/**
 * Get list of available browser profiles
 *
 * @returns Array of browser profile names
 *
 * @example
 * ```typescript
 * import { getProfiles } from 'wreq-js';
 *
 * const profiles = getProfiles();
 * console.log(profiles); // ['chrome_120', 'chrome_131', 'firefox', ...]
 * ```
 */
export function getProfiles(): BrowserProfile[] {
  if (!cachedProfiles) {
    cachedProfiles = nativeBinding.getProfiles() as BrowserProfile[];
  }

  return cachedProfiles;
}

/**
 * Get list of supported operating systems for emulation.
 *
 * @returns Array of operating system identifiers
 */
export function getOperatingSystems(): EmulationOS[] {
  if (!cachedOperatingSystems) {
    const fromNative = nativeBinding.getOperatingSystems?.() as EmulationOS[] | undefined;
    cachedOperatingSystems = fromNative && fromNative.length > 0 ? fromNative : [...SUPPORTED_OSES];
  }

  return cachedOperatingSystems;
}

/**
 * Convenience helper for GET requests using {@link fetch}.
 */
export async function get(url: string, init?: Omit<WreqRequestInit, "method">): Promise<Response> {
  const config: WreqRequestInit = {};
  if (init) {
    Object.assign(config, init);
  }
  config.method = "GET";
  return fetch(url, config);
}

/**
 * Convenience helper for POST requests using {@link fetch}.
 */
export async function post(
  url: string,
  body?: BodyInit | null,
  init?: Omit<WreqRequestInit, "method" | "body">,
): Promise<Response> {
  const config: WreqRequestInit = {};
  if (init) {
    Object.assign(config, init);
  }
  config.method = "POST";
  if (body !== undefined) {
    config.body = body;
  }

  return fetch(url, config);
}

/**
 * WebSocket connection class
 *
 * @example
 * ```typescript
 * import { websocket } from 'wreq-js';
 *
 * const ws = await websocket({
 *   url: 'wss://echo.websocket.org',
 *   browser: 'chrome_142',
 *   onMessage: (data) => {
 *     console.log('Received:', data);
 *   },
 *   onClose: () => {
 *     console.log('Connection closed');
 *   },
 *   onError: (error) => {
 *     console.error('Error:', error);
 *   }
 * });
 *
 * // Send text message
 * await ws.send('Hello World');
 *
 * // Send binary message
 * await ws.send(Buffer.from([1, 2, 3]));
 *
 * // Close connection
 * await ws.close();
 * ```
 */
export class WebSocket {
  private _connection: NativeWebSocketConnection;
  private _finalizerToken: NativeWebSocketConnection | undefined;
  private _closed = false;

  constructor(connection: NativeWebSocketConnection) {
    this._connection = connection;

    if (websocketFinalizer) {
      this._finalizerToken = connection;
      websocketFinalizer.register(this, connection, connection);
    }
  }

  /**
   * Send a message (text or binary)
   */
  async send(data: string | Buffer): Promise<void> {
    try {
      await nativeBinding.websocketSend(this._connection, data);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }

  /**
   * Close the WebSocket connection
   */
  async close(): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;

    if (this._finalizerToken && websocketFinalizer) {
      websocketFinalizer.unregister(this._finalizerToken);
      this._finalizerToken = undefined;
    }

    try {
      await nativeBinding.websocketClose(this._connection);
    } catch (error) {
      throw new RequestError(String(error));
    }
  }
}

/**
 * Create a WebSocket connection with browser impersonation
 *
 * @param options - WebSocket options
 * @returns Promise that resolves to the WebSocket instance
 */
export async function websocket(options: WebSocketOptions): Promise<WebSocket> {
  if (!options.url) {
    throw new RequestError("URL is required");
  }

  if (!options.onMessage) {
    throw new RequestError("onMessage callback is required");
  }

  validateBrowserProfile(options.browser);
  const os = options.os ?? DEFAULT_OS;
  validateOperatingSystem(os);
  const browser = options.browser ?? DEFAULT_BROWSER;

  try {
    const connection = await nativeBinding.websocketConnect({
      url: options.url,
      browser,
      os,
      headers: options.headers ?? {},
      ...(options.proxy !== undefined && { proxy: options.proxy }),
      onMessage: options.onMessage,
      ...(options.onClose !== undefined && { onClose: options.onClose }),
      ...(options.onError !== undefined && { onError: options.onError }),
    });

    return new WebSocket(connection);
  } catch (error) {
    throw new RequestError(String(error));
  }
}

export type {
  BodyInit,
  BrowserProfile,
  CookieMode,
  CreateSessionOptions,
  CreateTransportOptions,
  EmulationOS,
  HeadersInit,
  RequestInit,
  RequestOptions,
  SessionHandle,
  WebSocketOptions,
} from "./types.js";

export { RequestError };

export default {
  fetch,
  request,
  get,
  post,
  getProfiles,
  getOperatingSystems,
  createTransport,
  createSession,
  withSession,
  websocket,
  WebSocket,
  Headers,
  Response,
  Transport,
  Session,
};
