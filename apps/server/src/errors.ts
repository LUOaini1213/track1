export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class PolicyDeniedError extends Error {
  constructor(
    public readonly ruleId: string,
    message = "Policy denied: secret-exfiltration",
  ) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}
