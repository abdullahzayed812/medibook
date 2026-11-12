/** Uniform JSON body returned for every error response. */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}
