import type { BatchRequest, BatchResponse } from "./types.js";

export const DEFAULT_RETRY_STATUS_CODES = [401, 500, 502, 503, 504];

export const QUERY_METHODS = new Set(["GET", "HEAD"]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function buildEntityPath(resource: string, id?: unknown): string {
  if (id === undefined || id === null) {
    return resource;
  }

  if (typeof id === "string") {
    const escaped = id.replace(/'/g, "''");
    return `${resource}('${escaped}')`;
  }

  return `${resource}(${String(id)})`;
}

export function parseInlineCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function getNextSkip(nextLink: string | undefined): number {
  if (!nextLink) {
    return 0;
  }

  const match = /(?:\?|&)\$skip=(\d+)/.exec(nextLink);
  if (!match) {
    return 0;
  }

  const skip = match[1];
  return skip ? Number.parseInt(skip, 10) : 0;
}

export function buildBatchPayload(params: {
  baseUrl: string;
  requests: BatchRequest[];
  singleChangeSet: boolean;
}): { boundary: string; body: string } {
  const boundary = `batch_${crypto.randomUUID()}`;
  const base = new URL(params.baseUrl);
  const host = base.port ? `${base.hostname}:${base.port}` : base.hostname;
  const serviceRootPath = base.pathname.replace(/\/$/, "");
  const lines: string[] = [];

  let currentChangeSetId: string | null = null;

  const appendRequestPart = (request: BatchRequest, boundaryId: string): void => {
    lines.push(`--${boundaryId}`);
    lines.push("Content-Type: application/http; msgtype=request");
    lines.push("content-transfer-encoding: binary");
    if (request.contentId !== undefined) {
      lines.push(`Content-ID: ${request.contentId}`);
    }
    lines.push("");

    const method = request.method.toUpperCase();
    const path = `${serviceRootPath}/${request.resource}`.replace(/\/\//g, "/");
    const httpVersion = request.httpVersion ?? "1.1";
    lines.push(`${method} ${path} HTTP/${httpVersion}`);
    lines.push(`Host: ${host}`);

    const headers = request.headers ?? {};
    for (const [header, headerValue] of Object.entries(headers)) {
      lines.push(`${header}: ${headerValue}`);
    }

    if (request.data !== undefined) {
      lines.push("Content-Type: application/json; charset=utf-8");
      lines.push("");
      lines.push(
        typeof request.data === "string" ? request.data : JSON.stringify(request.data)
      );
    }

    lines.push("");
  };

  for (const request of params.requests) {
    const method = request.method.toUpperCase();
    const isQuery = QUERY_METHODS.has(method);

    if (params.singleChangeSet && !isQuery) {
      if (!currentChangeSetId) {
        currentChangeSetId = `changeset_${crypto.randomUUID()}`;
        lines.push(`--${boundary}`);
        lines.push(`Content-Type: multipart/mixed; boundary=${currentChangeSetId}`);
        lines.push("");
      }

      appendRequestPart(request, currentChangeSetId);
      continue;
    }

    if (currentChangeSetId) {
      lines.push(`--${currentChangeSetId}--`);
      lines.push("");
      currentChangeSetId = null;
    }

    if (!isQuery && !params.singleChangeSet) {
      const oneChangeSet = `changeset_${crypto.randomUUID()}`;
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: multipart/mixed; boundary=${oneChangeSet}`);
      lines.push("");
      appendRequestPart(request, oneChangeSet);
      lines.push(`--${oneChangeSet}--`);
      lines.push("");
      continue;
    }

    lines.push(`--${boundary}`);
    appendRequestPart(request, boundary);
  }

  if (currentChangeSetId) {
    lines.push(`--${currentChangeSetId}--`);
    lines.push("");
  }

  lines.push(`--${boundary}--`);
  lines.push("");

  return {
    boundary,
    body: lines.join("\r\n")
  };
}

export function parseBatchResponse(body: string): BatchResponse[] {
  const results: BatchResponse[] = [];
  const parts = body.split("HTTP/").slice(1);

  for (const part of parts) {
    const cleaned = `HTTP/${part}`.trim();
    const lineEnd = cleaned.indexOf("\n");
    const statusLine = (lineEnd < 0 ? cleaned : cleaned.slice(0, lineEnd)).trim();
    const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine);
    if (!statusMatch) {
      continue;
    }

    const rawRest = (lineEnd < 0 ? "" : cleaned.slice(lineEnd + 1)).replace(/\r/g, "");
    const divider = rawRest.indexOf("\n\n");
    const headerBlock = divider >= 0 ? rawRest.slice(0, divider) : rawRest;
    const bodyBlock = divider >= 0 ? rawRest.slice(divider + 2) : "";
    const headers: Record<string, string> = {};

    for (const rawHeaderLine of headerBlock.split("\n")) {
      const headerLine = rawHeaderLine.trim();
      if (!headerLine || headerLine.startsWith("--")) {
        continue;
      }

      const separator = headerLine.indexOf(":");
      if (separator < 0) {
        continue;
      }

      const key = headerLine.slice(0, separator).trim();
      const value = headerLine.slice(separator + 1).trim();
      headers[key.toLowerCase()] = value;
    }

    results.push({
      status: Number.parseInt(statusMatch[1] ?? "0", 10),
      statusText: statusMatch[2]?.trim() ?? "",
      headers,
      body: bodyBlock.replace(/\n--[\s\S]*$/, "").trim()
    });
  }

  return results;
}
