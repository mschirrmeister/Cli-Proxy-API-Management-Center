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
  /** Upstream target (host:port), also for proxied connections. */
  addr: string;
  /** Proxy (host:port) the connection is tunneled through; empty when direct. */
  proxy: string;
  local: string;
  remote: string;
  proto: string;
  tlsVersion: string;
  alpn: string;
  tlsResumed: boolean;
  /** Time until the target was reached, including the proxy tunnel. */
  dialMs: number;
  /** Part of dialMs spent on the proxy tunnel, when measured separately (0 otherwise). */
  proxyMs: number;
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
  /** Model the client asked for; empty when the caller did not provide it. */
  model: string;
  method: string;
  host: string;
  path: string;
  status: number;
  contentType: string;
  stream: boolean;
  reused: boolean;
  wasIdle: boolean;
  idleMs: number;
  startedAt: number;
  firstByteMs: number;
  endedAt: number | null;
  /** How the response ended (see RequestEnd); empty while in flight. */
  end: string;
  error: string;
}

/**
 * How an upstream response ended, as recorded by the proxy.
 * after_final_event is normal for streams: the proxy stops reading once the
 * final event ([DONE], message_stop, response.completed) has arrived.
 */
export type RequestEnd =
  | 'eof'
  | 'after_final_event'
  | 'closed_early'
  | 'cancelled'
  | 'read_error'
  | 'error'
  | 'no_body'
  | 'sent';

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
    proxy: str(raw.proxy),
    local: str(raw.local),
    remote: str(raw.remote),
    proto: str(raw.proto),
    tlsVersion: str(raw.tls_version),
    alpn: str(raw.alpn),
    tlsResumed: bool(raw.tls_resumed),
    dialMs: num(raw.dial_ms),
    proxyMs: num(raw.proxy_ms),
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
    model: str(raw.model),
    method: str(raw.method),
    host: str(raw.host),
    path: str(raw.path),
    status: num(raw.status),
    contentType: str(raw.content_type),
    stream: bool(raw.stream),
    reused: bool(raw.reused),
    wasIdle: bool(raw.was_idle),
    idleMs: num(raw.idle_ms),
    startedAt: time(raw.started_at),
    firstByteMs: num(raw.first_byte_ms),
    endedAt: optionalTime(raw.ended_at),
    end: str(raw.end),
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
