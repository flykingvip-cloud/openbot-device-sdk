export class ControlPlaneError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
  }
}

export class OtaDisabledError extends ControlPlaneError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OtaDisabledError";
  }
}
