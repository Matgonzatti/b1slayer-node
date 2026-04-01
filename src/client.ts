import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import fetchCookieImport from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import { Agent } from "undici";
import { ServiceLayerError } from "./error.js";
import { ServiceLayerRequest } from "./request.js";
import { MemorySessionStore } from "./session-store.js";
import type {
  BatchRequest,
  BatchResponse,
  ServiceLayerClientOptions,
  ServiceLayerLoginResponse,
  SessionStore
} from "./types.js";
import {
  DEFAULT_RETRY_STATUS_CODES,
  buildBatchPayload,
  buildEntityPath,
  parseBatchResponse,
  sanitizeBaseUrl,
  sleep
} from "./utils.js";

const fetchCookie =
  typeof fetchCookieImport === "function"
    ? fetchCookieImport
    : ((fetchCookieImport as unknown as { default?: typeof fetchCookieImport }).default as typeof fetchCookieImport);

interface ExecuteOptions {
  headers?: Headers;
  body?: BodyInit;
  timeoutMs?: number;
  allowAnyHttpStatus?: boolean;
  allowedStatusCodes?: Set<number>;
  skipAuth?: boolean;
}

export class ServiceLayerClient {
  readonly baseUrl: string;
  readonly companyDB: string;
  readonly userName: string;
  readonly password: string;
  readonly language?: number;
  readonly sessionCacheKey: string;
  readonly retryOptions: Required<NonNullable<ServiceLayerClientOptions["retry"]>>;
  readonly requestTimeoutMs: number;
  readonly batchTimeoutMs: number;

  private readonly sessionStore: SessionStore;
  private readonly cookieJar: CookieJar;
  private readonly fetchWithCookies: typeof fetch;
  private loginResponse: ServiceLayerLoginResponse | null = null;
  private loginTimestamp: number | null = null;
  private loginPromise: Promise<void> | null = null;

  private readonly beforeRequestHook?: ServiceLayerClientOptions["beforeRequest"];
  private readonly afterResponseHook?: ServiceLayerClientOptions["afterResponse"];
  private readonly onErrorHook?: ServiceLayerClientOptions["onError"];

  constructor(options: ServiceLayerClientOptions) {
    this.baseUrl = sanitizeBaseUrl(options.baseUrl);
    this.companyDB = options.companyDB;
    this.userName = options.userName;
    this.password = options.password;
    this.language = options.language;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 100_000;
    this.batchTimeoutMs = options.batchTimeoutMs ?? 300_000;
    this.sessionStore = options.sessionStore ?? new MemorySessionStore();
    this.sessionCacheKey =
      options.sessionCacheKey ??
      `b1slayer-node:session:${this.baseUrl}:${this.companyDB}:${this.userName}`;

    this.beforeRequestHook = options.beforeRequest;
    this.afterResponseHook = options.afterResponse;
    this.onErrorHook = options.onError;

    this.retryOptions = {
      attempts: options.retry?.attempts ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? 200,
      maxDelayMs: options.retry?.maxDelayMs ?? 2_000,
      retryStatusCodes: options.retry?.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES
    };

    const dispatcher =
      options.dispatcher ??
      (options.allowInsecureTLS
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined);

    const baseFetch = options.fetch ?? fetch;
    const configuredFetch: typeof fetch = dispatcher
      ? ((input, init) =>
          baseFetch(input, {
            ...init,
            dispatcher
          } as RequestInit & { dispatcher: Agent }))
      : baseFetch;

    this.cookieJar = new CookieJar();
    this.fetchWithCookies = fetchCookie(configuredFetch, this.cookieJar, false);
  }

  request(resource: string, id?: unknown): ServiceLayerRequest {
    return new ServiceLayerRequest(this, buildEntityPath(resource, id));
  }

  async login(): Promise<ServiceLayerLoginResponse> {
    await this.ensureLoggedIn(true);
    if (!this.loginResponse) {
      throw new Error("Login did not return a valid session.");
    }

    return this.loginResponse;
  }

  async logout(): Promise<void> {
    await this.execute("POST", "Logout", { skipAuth: false, allowAnyHttpStatus: true });
    await this.invalidateSession();
  }

  async invalidateSession(): Promise<void> {
    this.loginResponse = null;
    this.loginTimestamp = null;
    await this.sessionStore.remove(this.sessionCacheKey);
    await this.cookieJar.removeAllCookies();
  }

  async ping(): Promise<unknown> {
    return this.pingPath("ping/");
  }

  async pingNode(node?: number): Promise<unknown> {
    return this.pingPath(node === undefined ? "ping/load-balancer" : `ping/node/${node}`);
  }

  async postBatch(
    requests: BatchRequest[],
    singleChangeSet = true
  ): Promise<BatchResponse[]> {
    if (requests.length === 0) {
      throw new Error("No requests to be sent.");
    }

    const payload = buildBatchPayload({
      baseUrl: this.baseUrl,
      requests,
      singleChangeSet
    });

    const response = await this.execute("POST", "$batch", {
      headers: new Headers({
        "content-type": `multipart/mixed; boundary=${payload.boundary}`
      }),
      body: payload.body,
      timeoutMs: this.batchTimeoutMs
    });

    const text = await response.text();
    return parseBatchResponse(text);
  }

  async postAttachmentFromPath(path: string): Promise<unknown> {
    const content = await readFile(path);
    return this.postAttachment(basename(path), content);
  }

  async postAttachment(fileName: string, content: Uint8Array): Promise<unknown> {
    const form = new FormData();
    form.append("files", new Blob([Buffer.from(content)]), fileName);
    const response = await this.execute("POST", "Attachments2", {
      body: form
    });
    return response.json();
  }

  async patchAttachment(
    attachmentEntry: number,
    fileName: string,
    content: Uint8Array
  ): Promise<void> {
    const form = new FormData();
    form.append("files", new Blob([Buffer.from(content)]), fileName);
    await this.execute("PATCH", `Attachments2(${attachmentEntry})`, {
      body: form
    });
  }

  async getAttachmentAsBytes(
    attachmentEntry: number,
    fileName?: string
  ): Promise<Uint8Array> {
    const query = fileName ? `?filename='${encodeURIComponent(fileName)}'` : "";
    const response = await this.execute(
      "GET",
      `Attachments2(${attachmentEntry})/$value${query}`
    );

    return new Uint8Array(await response.arrayBuffer());
  }

  async execute(method: string, path: string, options?: ExecuteOptions): Promise<Response> {
    const requestUrl = `${this.baseUrl}/${path}`.replace(/([^:]\/)\//g, "$1");
    const headers = options?.headers ? new Headers(options.headers) : new Headers();
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const attempts = Math.max(1, this.retryOptions.attempts);

    if (!options?.skipAuth) {
      await this.ensureLoggedIn(false);
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        await this.beforeRequestHook?.({
          url: requestUrl,
          method,
          headers,
          body: options?.body
        });

        const response = await this.fetchWithCookies(requestUrl, {
          method,
          headers,
          body: options?.body ?? null,
          signal: controller.signal
        });

        await this.afterResponseHook?.({
          url: requestUrl,
          method,
          response
        });

        if (
          response.ok ||
          options?.allowAnyHttpStatus ||
          options?.allowedStatusCodes?.has(response.status)
        ) {
          return response;
        }

        const isRetryable = this.retryOptions.retryStatusCodes.includes(response.status);
        if (!isRetryable || attempt >= attempts) {
          throw await ServiceLayerError.fromResponse(response);
        }

        if (response.status === 401 && !options?.skipAuth) {
          await this.invalidateSession();
          await this.ensureLoggedIn(true);
        }

        await sleep(this.getRetryDelay(attempt, response));
      } catch (error) {
        lastError = error;
        await this.onErrorHook?.({ url: requestUrl, method, error });

        if (error instanceof ServiceLayerError) {
          const retryable = this.retryOptions.retryStatusCodes.includes(error.status);
          if (!retryable) {
            throw error;
          }

          if (attempt >= attempts) {
            throw error;
          }
        } else if (attempt >= attempts) {
          throw error;
        }

        await sleep(this.getRetryDelay(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Could not process request");
  }

  private async pingPath(path: string): Promise<unknown> {
    const url = new URL(this.baseUrl);
    const root = `${url.protocol}//${url.host}`;
    const response = await this.fetchWithCookies(`${root}/${path}`);
    const bodyText = await response.text();

    try {
      return {
        ...(JSON.parse(bodyText) as Record<string, unknown>),
        statusCode: response.status,
        isSuccessStatusCode: response.ok
      };
    } catch {
      return {
        message: bodyText,
        statusCode: response.status,
        isSuccessStatusCode: response.ok
      };
    }
  }

  private async ensureLoggedIn(force = false): Promise<void> {
    if (!force && this.hasValidSession()) {
      return;
    }

    if (this.loginPromise) {
      await this.loginPromise;
      return;
    }

    this.loginPromise = this.loginInternal(force);
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async loginInternal(force: boolean): Promise<void> {
    if (!force) {
      const cached = await this.sessionStore.get(this.sessionCacheKey);
      if (cached && this.isCacheEntryValid(cached.loginResponse, cached.cachedAt)) {
        const deserialized = await CookieJar.deserialize(JSON.parse(cached.cookies) as object);
        await this.cookieJar.removeAllCookies();
        for (const cookie of await deserialized.getCookies(this.baseUrl)) {
          await this.cookieJar.setCookie(cookie.toString(), this.baseUrl);
        }
        this.loginResponse = cached.loginResponse;
        this.loginTimestamp = cached.cachedAt;
        return;
      }
    }

    const loginBody: Record<string, unknown> = {
      CompanyDB: this.companyDB,
      UserName: this.userName,
      Password: this.password
    };

    if (this.language !== undefined) {
      loginBody.Language = this.language;
    }

    const response = await this.execute("POST", "Login", {
      skipAuth: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(loginBody)
    });

    const loginResponse = (await response.json()) as ServiceLayerLoginResponse;
    this.loginResponse = loginResponse;
    this.loginTimestamp = Date.now();

    const ttlMs = Math.max(1, loginResponse.SessionTimeout) * 60_000;
    const serializedJar = await this.cookieJar.serialize();
    await this.sessionStore.set(
      this.sessionCacheKey,
      {
        cookies: JSON.stringify(serializedJar),
        loginResponse,
        cachedAt: this.loginTimestamp
      },
      ttlMs
    );
  }

  private hasValidSession(): boolean {
    if (!this.loginResponse) {
      return false;
    }

    if (!this.loginTimestamp) {
      return false;
    }

    return this.isCacheEntryValid(this.loginResponse, this.loginTimestamp);
  }

  private isCacheEntryValid(login: ServiceLayerLoginResponse, fromTimestamp: number): boolean {
    const ageMs = Date.now() - fromTimestamp;
    const sessionDurationMs = Math.max(1, login.SessionTimeout) * 60_000;
    return ageMs < sessionDurationMs - 5_000;
  }

  private getRetryDelay(attempt: number, response?: Response): number {
    const retryAfter = response?.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        return Math.min(seconds * 1000, this.retryOptions.maxDelayMs);
      }
    }

    const exponential = this.retryOptions.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * this.retryOptions.baseDelayMs);
    return Math.min(exponential + jitter, this.retryOptions.maxDelayMs);
  }
}
