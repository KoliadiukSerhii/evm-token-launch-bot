import { formatUnits } from "viem";

export function toNumber(value: bigint, decimals = 18): number {
  return Number(formatUnits(value, decimals));
}

export function formatAmount(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) < 1) {
    return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatToken(value: bigint, decimals = 18): string {
  return formatAmount(toNumber(value, decimals));
}

export function formatUsd(value: number | null): string {
  if (value === null) return "n/a";
  if (value !== 0 && Math.abs(value) < 0.01) {
    return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) {
    const hours = ms / 3_600_000;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  }
  const days = ms / 86_400_000;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
