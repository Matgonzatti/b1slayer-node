import type { ServiceLayerClient } from "./client.js";
import type { ServiceLayerCollectionRoot } from "./types.js";
import { getNextSkip, parseInlineCount } from "./utils.js";

interface RequestExecutionOptions {
  allowAnyHttpStatus?: boolean;
  allowedStatusCodes?: Set<number>;
}

export class ServiceLayerRequest {
  private readonly query = new URLSearchParams();
  private readonly headers = new Headers();
  private readonly options: RequestExecutionOptions = {};

  constructor(
    private readonly client: ServiceLayerClient,
    private readonly resourcePath: string
  ) {}

  filter(filter: string): this {
    this.query.set("$filter", filter);
    return this;
  }

  select(select: string): this {
    this.query.set("$select", select);
    return this;
  }

  orderBy(orderBy: string): this {
    this.query.set("$orderby", orderBy);
    return this;
  }

  top(top: number): this {
    this.query.set("$top", String(top));
    return this;
  }

  skip(skip: number): this {
    this.query.set("$skip", String(skip));
    return this;
  }

  apply(apply: string): this {
    this.query.set("$apply", apply);
    return this;
  }

  expand(expand: string): this {
    this.query.set("$expand", expand);
    return this;
  }

  setQueryParam(name: string, value: string | number | null | undefined): this {
    if (value === null || value === undefined) {
      this.query.delete(name);
      return this;
    }

    this.query.set(name, String(value));
    return this;
  }

  withPageSize(pageSize: number): this {
    return this.withHeader("B1S-PageSize", String(pageSize));
  }

  withCaseInsensitive(): this {
    return this.withHeader("B1S-CaseInsensitive", "true");
  }

  withReplaceCollectionsOnPatch(): this {
    return this.withHeader("B1S-ReplaceCollectionsOnPatch", "true");
  }

  withReturnNoContent(): this {
    return this.withHeader("Prefer", "return-no-content");
  }

  withHeader(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  allowHttpStatus(...statusCodes: number[]): this {
    this.options.allowedStatusCodes = new Set(statusCodes);
    return this;
  }

  allowAnyHttpStatus(): this {
    this.options.allowAnyHttpStatus = true;
    return this;
  }

  withTimeout(timeoutMs: number): this {
    return this.withHeader("x-b1slayer-timeout-ms", String(timeoutMs));
  }

  async get<T>(unwrapCollection = true): Promise<T> {
    const response = await this.send("GET");
    return parsePayload<T>(response, unwrapCollection);
  }

  async getString(): Promise<string> {
    const response = await this.send("GET");
    return response.text();
  }

  async getBytes(): Promise<Uint8Array> {
    const response = await this.send("GET");
    return new Uint8Array(await response.arrayBuffer());
  }

  async getWithInlineCount<T>(
    unwrapCollection = true
  ): Promise<{ result: T; count: number }> {
    this.query.set("$inlinecount", "allpages");
    const response = await this.send("GET");
    const payload = await parseRawPayload(response);

    const payloadRecord = payload as Record<string, unknown>;
    const count = parseInlineCount(
      payloadRecord["odata.count"] ?? payloadRecord["@odata.count"] ?? 0
    );
    const data = getUnwrappedPayload<T>(payload, unwrapCollection);

    return { result: data, count };
  }

  async getAll<T>(): Promise<T[]> {
    const allResults: T[] = [];
    let skip = Number.parseInt(this.query.get("$skip") ?? "0", 10);
    if (Number.isNaN(skip)) {
      skip = 0;
    }

    while (true) {
      this.query.set("$skip", String(skip));
      const response = await this.send("GET");
      const payload = (await response.json()) as ServiceLayerCollectionRoot<T>;

      if (Array.isArray(payload.value)) {
        allResults.push(...payload.value);
      }

      const nextLink = payload["@odata.nextLink"] ?? payload["odata.nextLink"];
      skip = getNextSkip(nextLink);
      if (skip <= 0) {
        break;
      }
    }

    return allResults;
  }

  async getCount(): Promise<number> {
    const countRequest = this.clone();
    const response = await countRequest.send("GET", {
      pathSuffix: "/$count"
    });
    const content = await response.text();
    return Number.parseInt(content, 10) || 0;
  }

  async post<T>(data?: unknown, unwrapCollection = true): Promise<T> {
    const response = await this.send("POST", { data });
    return parsePayload<T>(response, unwrapCollection);
  }

  async postVoid(data?: unknown): Promise<void> {
    await this.send("POST", { data });
  }

  async postString(data: string): Promise<void> {
    await this.send("POST", {
      rawBody: data,
      contentType: "application/json"
    });
  }

  async patch(data: unknown): Promise<void> {
    await this.send("PATCH", { data });
  }

  async put(data: unknown): Promise<void> {
    await this.send("PUT", { data });
  }

  async delete(): Promise<void> {
    await this.send("DELETE");
  }

  async patchWithFile(fileName: string, content: Uint8Array): Promise<void> {
    const form = new FormData();
    form.append("files", new Blob([Buffer.from(content)]), fileName);
    await this.send("PATCH", { rawBody: form });
  }

  private clone(): ServiceLayerRequest {
    const request = new ServiceLayerRequest(this.client, this.resourcePath);
    this.query.forEach((value, key) => request.query.set(key, value));
    this.headers.forEach((value, key) => request.headers.set(key, value));
    request.options.allowAnyHttpStatus = this.options.allowAnyHttpStatus;
    request.options.allowedStatusCodes = this.options.allowedStatusCodes
      ? new Set(this.options.allowedStatusCodes)
      : undefined;

    return request;
  }

  private async send(
    method: string,
    options?: {
      data?: unknown;
      rawBody?: BodyInit;
      contentType?: string;
      pathSuffix?: string;
    }
  ): Promise<Response> {
    const queryString = this.query.toString();
    const path = `${this.resourcePath}${options?.pathSuffix ?? ""}${
      queryString ? `?${queryString}` : ""
    }`;

    const headers = new Headers(this.headers);
    let body: BodyInit | undefined;

    const requestTimeout = headers.get("x-b1slayer-timeout-ms");
    if (requestTimeout) {
      headers.delete("x-b1slayer-timeout-ms");
    }

    if (options?.rawBody !== undefined) {
      body = options.rawBody;
      if (options.contentType) {
        headers.set("content-type", options.contentType);
      }
    } else if (options?.data !== undefined) {
      body = JSON.stringify(options.data);
      headers.set("content-type", "application/json");
    }

    const timeoutMs = requestTimeout ? Number.parseInt(requestTimeout, 10) : undefined;

    return this.client.execute(method, path, {
      headers,
      body,
      timeoutMs,
      allowAnyHttpStatus: this.options.allowAnyHttpStatus,
      allowedStatusCodes: this.options.allowedStatusCodes
    });
  }
}

async function parsePayload<T>(
  response: Response,
  unwrapCollection: boolean
): Promise<T> {
  const payload = await parseRawPayload(response);
  return getUnwrappedPayload(payload, unwrapCollection);
}

async function parseRawPayload(response: Response): Promise<unknown> {
  const content = await response.text();
  if (!content) {
    return null;
  }

  return JSON.parse(content) as unknown;
}

function getUnwrappedPayload<T>(payload: unknown, unwrapCollection: boolean): T {
  if (typeof payload === "string") {
    return payload as T;
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (unwrapCollection && Array.isArray(record.value)) {
      return record.value as T;
    }
  }

  return payload as T;
}
