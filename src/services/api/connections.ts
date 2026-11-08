/**
 * Upstream connection observability (GET /observability/connections).
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

const CONNECTIONS_TIMEOUT_MS = 10 * 1000;

export interface UpstreamConnection {
  id: number;
  kind: string;
  provider: string;
  authId: string;
  addr: string;
  local: string;
  remote: string;
  proto: string;
  tlsVersion: string;
  alpn: string;
  tlsResumed: boolean;
  dialMs: number;
  tlsMs: number;
  openedAt: number;
  closedAt: number | null;
  lastIo: number;
  lastRequestEnd: number | null;
  bytesIn: number;
  bytesOut: number;
  requests: number;
  inFlight: number;
  closeReason: string;
  closeError: string;
  requestIds: number[];
}

export interface UpstreamRequest {
  id: number;
  connId: number;
  provider: string;
  authId: string;
  method: string;
  host: string;
  path: string;
  status: number;
  stream: boolean;
  reused: boolean;
  wasIdle: boolean;
  idleMs: number;
  startedAt: number;
  firstByteMs: number;
  endedAt: number | null;
  complete: boolean;
  error: string;
}

export interface ConnectionEvent {
  time: number;
  kind: string;
  detail: string;
}

export interface ConnectionTotals {
  connsOpened: number;
  connsClosed: number;
  requests: number;
  reusedRequests: number;
  bytesIn: number;
  bytesOut: number;
  closeReasons: Record<string, number>;
}

export interface ConnectionsSnapshot {
  enabled: boolean;
  now: number;
  startedAt: number;
  totals: ConnectionTotals;
  open: UpstreamConnection[];
  closed: UpstreamConnection[];
  requests: UpstreamRequest[];
  events: ConnectionEvent[];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const bool = (value: unknown): boolean => value === true;
const time = (value: unknown): number => {
  if (typeof value !== 'string' || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const optionalTime = (value: unknown): number | null => {
  const parsed = time(value);
  return parsed > 0 ? parsed : null;
};

const normalizeConnection = (raw: unknown): UpstreamConnection | null => {
  if (!isRecord(raw)) return null;
  return {
    id: num(raw.id),
    kind: str(raw.kind),
    provider: str(raw.provider),
    authId: str(raw.auth_id),
    addr: str(raw.addr),
    local: str(raw.local),
    remote: str(raw.remote),
    proto: str(raw.proto),
    tlsVersion: str(raw.tls_version),
    alpn: str(raw.alpn),
    tlsResumed: bool(raw.tls_resumed),
    dialMs: num(raw.dial_ms),
    tlsMs: num(raw.tls_ms),
    openedAt: time(raw.opened_at),
    closedAt: optionalTime(raw.closed_at),
    lastIo: time(raw.last_io),
    lastRequestEnd: optionalTime(raw.last_request_end),
    bytesIn: num(raw.bytes_in),
    bytesOut: num(raw.bytes_out),
    requests: num(raw.requests),
    inFlight: num(raw.in_flight),
    closeReason: str(raw.close_reason),
    closeError: str(raw.close_error),
    requestIds: Array.isArray(raw.request_ids)
      ? raw.request_ids.filter((id): id is number => typeof id === 'number')
      : [],
  };
};

const normalizeRequest = (raw: unknown): UpstreamRequest | null => {
  if (!isRecord(raw)) return null;
  return {
    id: num(raw.id),
    connId: num(raw.conn_id),
    provider: str(raw.provider),
    authId: str(raw.auth_id),
    method: str(raw.method),
    host: str(raw.host),
    path: str(raw.path),
    status: num(raw.status),
    stream: bool(raw.stream),
    reused: bool(raw.reused),
    wasIdle: bool(raw.was_idle),
    idleMs: num(raw.idle_ms),
    startedAt: time(raw.started_at),
    firstByteMs: num(raw.first_byte_ms),
    endedAt: optionalTime(raw.ended_at),
    complete: bool(raw.complete),
    error: str(raw.error),
  };
};

const list = <T>(value: unknown, normalize: (raw: unknown) => T | null): T[] =>
  Array.isArray(value) ? value.map(normalize).filter((item): item is T => item !== null) : [];

export const normalizeConnectionsSnapshot = (data: unknown): ConnectionsSnapshot => {
  const root = isRecord(data) ? data : {};
  const totals = isRecord(root.totals) ? root.totals : {};
  const reasons: Record<string, number> = {};
  if (isRecord(totals.close_reasons)) {
    for (const [key, value] of Object.entries(totals.close_reasons)) {
      reasons[key] = num(value);
    }
  }
  return {
    enabled: bool(root.enabled),
    now: time(root.now) || Date.now(),
    startedAt: time(root.started_at),
    totals: {
      connsOpened: num(totals.conns_opened),
      connsClosed: num(totals.conns_closed),
      requests: num(totals.requests),
      reusedRequests: num(totals.reused_requests),
      bytesIn: num(totals.bytes_in),
      bytesOut: num(totals.bytes_out),
      closeReasons: reasons,
    },
    open: list(root.open, normalizeConnection),
    closed: list(root.closed, normalizeConnection),
    requests: list(root.requests, normalizeRequest),
    events: list(root.events, (raw) =>
      isRecord(raw) ? { time: time(raw.time), kind: str(raw.kind), detail: str(raw.detail) } : null
    ),
  };
};

export const connectionsApi = {
  getSnapshot: async (sinceMs?: number): Promise<ConnectionsSnapshot> => {
    const data = await apiClient.get<unknown>('/observability/connections', {
      timeout: CONNECTIONS_TIMEOUT_MS,
      params: sinceMs ? { since: Math.floor(sinceMs) } : undefined,
    });
    return normalizeConnectionsSnapshot(data);
  },
};
