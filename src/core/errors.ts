import { BaseError } from "viem";

export function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join("; ");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
