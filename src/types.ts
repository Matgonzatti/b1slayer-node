import type { Dispatcher } from "undici";

export interface ServiceLayerErrorMessage {
  lang?: string;
  value?: string;
}

export interface ServiceLayerErrorDetails {
  code?: string;
  message?: ServiceLayerErrorMessage;
}

export interface ServiceLayerErrorPayload {
  error?: ServiceLayerErrorDetails;
}

export interface ServiceLayerLoginResponse {
  SessionId: string;
  Version?: string;
  SessionTimeout: number;
}

export interface ServiceLayerPingResponse {
  message?: string;
  sender?: string;
  timestamp?: number | string;
}

export interface ServiceLayerCollectionRoot<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "odata.nextLink"?: string;
  "@odata.count"?: number | string;
  "odata.count"?: number | string;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryStatusCodes?: number[];
}

export interface BatchRequest {
  method: string;
  resource: string;
  data?: unknown;
  contentId?: number;
  headers?: Record<string, string>;
  httpVersion?: string;
}

export interface BatchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface BeforeRequestContext {
  url: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
}

export interface AfterResponseContext {
  url: string;
  method: string;
  response: Response;
}

export interface ErrorContext {
  url: string;
  method: string;
  error: unknown;
}

export interface SessionCacheEntry {
  cookies: string;
  loginResponse: ServiceLayerLoginResponse;
  cachedAt: number;
}

export interface SessionStore {
  get(key: string): Promise<SessionCacheEntry | null>;
  set(key: string, value: SessionCacheEntry, ttlMs: number): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ServiceLayerClientOptions {
  baseUrl: string;
  companyDB: string;
  userName: string;
  password: string;
  language?: number;
  retry?: RetryOptions;
  requestTimeoutMs?: number;
  batchTimeoutMs?: number;
  allowInsecureTLS?: boolean;
  sessionStore?: SessionStore;
  sessionCacheKey?: string;
  fetch?: typeof fetch;
  beforeRequest?: (ctx: BeforeRequestContext) => Promise<void> | void;
  afterResponse?: (ctx: AfterResponseContext) => Promise<void> | void;
  onError?: (ctx: ErrorContext) => Promise<void> | void;
  dispatcher?: Dispatcher;
}
