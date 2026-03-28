import type { ServiceLayerErrorPayload } from "./types.js";

export class ServiceLayerError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly details?: ServiceLayerErrorPayload["error"];
  readonly body: string;

  constructor(params: {
    message: string;
    status: number;
    statusText: string;
    body: string;
    details?: ServiceLayerErrorPayload["error"];
  }) {
    super(params.message);
    this.name = "ServiceLayerError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.body = params.body;
    this.details = params.details;
  }

  static async fromResponse(response: Response): Promise<ServiceLayerError> {
    const body = await response.text();
    const parsed = tryParseErrorPayload(body);
    const message =
      parsed?.error?.message?.value ?? `${response.status} ${response.statusText}`;

    return new ServiceLayerError({
      message,
      status: response.status,
      statusText: response.statusText,
      body,
      details: parsed?.error
    });
  }
}

function tryParseErrorPayload(input: string): ServiceLayerErrorPayload | null {
  if (!input) {
    return null;
  }

  try {
    const parsed = JSON.parse(input) as ServiceLayerErrorPayload;
    if (!parsed.error) {
      return null;
    }

    if (typeof parsed.error.code === "number") {
      parsed.error.code = String(parsed.error.code);
    }

    if (typeof parsed.error.message === "string") {
      parsed.error.message = { value: parsed.error.message };
    }

    return parsed;
  } catch {
    return null;
  }
}
