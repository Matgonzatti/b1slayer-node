import type { BatchRequest } from "./types.js";

export class SLBatchRequest implements BatchRequest {
  method: string;
  resource: string;
  data?: unknown;
  contentId?: number;
  headers: Record<string, string>;
  httpVersion?: string;

  constructor(
    method: string,
    resource: string,
    data?: unknown,
    contentId?: number
  ) {
    this.method = method.toUpperCase();
    this.resource = resource;
    this.data = data;
    this.contentId = contentId;
    this.headers = {};
  }

  withCaseInsensitive(): this {
    this.headers["B1S-CaseInsensitive"] = "true";
    return this;
  }

  withReplaceCollectionsOnPatch(): this {
    this.headers["B1S-ReplaceCollectionsOnPatch"] = "true";
    return this;
  }

  withReturnNoContent(): this {
    this.headers.Prefer = "return-no-content";
    return this;
  }

  withHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  withHttpVersion(httpVersion: string): this {
    this.httpVersion = httpVersion;
    return this;
  }
}
