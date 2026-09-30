export class BenchmarkProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 422,
    readonly retryable = false,
    readonly details?: Record<string, string | number | boolean | null>,
  ) {
    super(message)
    this.name = 'BenchmarkProtocolError'
  }
}
