export type ConnectorErrorCode =
  | "INVALID_INPUT" //        the agent sent something Zoho rejected; fix the arguments
  | "NOT_FOUND" //            the record doesn't exist in this organization
  | "RATE_LIMITED" //         Zoho per-minute/daily limit; retry after retryAfterMs
  | "REAUTH_REQUIRED" //      refresh token revoked/expired; merchant must reconnect
  | "FORBIDDEN_SCOPE" //      the connection wasn't granted the scope this needs
  | "UPSTREAM_UNAVAILABLE" // Zoho timed out or returned 5xx after retries
  | "UPSTREAM_ERROR"; //      any other Zoho error

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly zohoCode?: number;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    opts: { retryable?: boolean; retryAfterMs?: number; zohoCode?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = opts.retryable ?? (code === "RATE_LIMITED" || code === "UPSTREAM_UNAVAILABLE");
    this.retryAfterMs = opts.retryAfterMs;
    this.zohoCode = opts.zohoCode;
  }

  /** Shape returned to the agent. Includes a hint so the model knows what to do next. */
  toAgentPayload() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.retryAfterMs !== undefined && { retry_after_ms: this.retryAfterMs }),
        hint: AGENT_HINTS[this.code],
      },
    };
  }
}

const AGENT_HINTS: Record<ConnectorErrorCode, string> = {
  INVALID_INPUT: "Check the arguments against the tool's input schema and try again.",
  NOT_FOUND: "The record was not found. Use a list_ or search_ tool to find the correct ID.",
  RATE_LIMITED: "Zoho's API limit was reached. Wait retry_after_ms before retrying, and avoid parallel calls.",
  REAUTH_REQUIRED: "The merchant must reconnect Zoho Inventory in the connector dashboard. Do not retry.",
  FORBIDDEN_SCOPE: "This connection lacks permission for this data. Tell the user; do not retry.",
  UPSTREAM_UNAVAILABLE: "Zoho is temporarily unavailable. Retry once later or tell the user.",
  UPSTREAM_ERROR: "Zoho returned an error. Tell the user the message; retrying is unlikely to help.",
};
