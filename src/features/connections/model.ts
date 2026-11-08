/**
 * Pure view logic for the connections page: windowing, filtering, KPIs and the
 * timeline geometry. Kept free of React so it can be unit tested.
 */

import type {
  ConnectionsSnapshot,
  UpstreamConnection,
  UpstreamRequest,
} from '@/services/api/connections';

export const CONNECTION_RANGES = [
  { id: '15m', ms: 15 * 60 * 1000 },
  { id: '1h', ms: 60 * 60 * 1000 },
  { id: '6h', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

export type ConnectionRangeId = (typeof CONNECTION_RANGES)[number]['id'];

export const ALL_PROVIDERS = 'all';
/** Connections without a credential label (panel download, version checks, ...). */
export const OTHER_PROVIDER = 'other';

export const MAX_TIMELINE_ROWS = 60;

export type CloseTone = 'ok' | 'notice' | 'bad' | 'open';

/**
 * How a close reason reads to an operator: expected lifecycle ends are "ok",
 * closes that cost a reconnect without a server reason are "notice", errors are "bad".
 */
export const closeTone = (reason: string): CloseTone => {
  switch (reason) {
    case '':
      return 'open';
    case 'server_idle':
    case 'proxy_idle':
    case 'proxy_per_request':
    case 'proxy_closed':
    case 'ws_closed_local':
    case 'ws_closed_remote':
      return 'ok';
    case 'error':
    case 'server_during_request':
      return 'bad';
    default:
      return 'notice';
  }
};

export const providerOf = (conn: Pick<UpstreamConnection, 'provider'>): string =>
  conn.provider || OTHER_PROVIDER;

export const rangeMs = (id: ConnectionRangeId): number =>
  CONNECTION_RANGES.find((range) => range.id === id)?.ms ?? CONNECTION_RANGES[1].ms;

export interface ConnectionView {
  windowStart: number;
  now: number;
  connections: UpstreamConnection[];
  open: UpstreamConnection[];
  closed: UpstreamConnection[];
  requests: UpstreamRequest[];
  providers: string[];
}

/** Connections and requests that overlap the window, optionally for one provider. */
export const buildConnectionView = (
  snapshot: ConnectionsSnapshot,
  range: ConnectionRangeId,
  provider: string
): ConnectionView => {
  const now = snapshot.now;
  const windowStart = now - rangeMs(range);
  const all = [...snapshot.open, ...snapshot.closed];
  const providers = Array.from(new Set(all.map(providerOf))).sort();
  const matches = (conn: UpstreamConnection) =>
    provider === ALL_PROVIDERS || providerOf(conn) === provider;
  const inWindow = (conn: UpstreamConnection) =>
    conn.closedAt === null || conn.closedAt >= windowStart;

  const open = snapshot.open.filter(matches).sort((a, b) => b.openedAt - a.openedAt);
  const closed = snapshot.closed
    .filter((conn) => matches(conn) && inWindow(conn))
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const connections = [...open, ...closed].sort((a, b) => a.openedAt - b.openedAt);
  const requests = snapshot.requests.filter(
    (req) =>
      (provider === ALL_PROVIDERS || (req.provider || OTHER_PROVIDER) === provider) &&
      (req.endedAt === null || req.endedAt >= windowStart)
  );
  return { windowStart, now, connections, open, closed, requests, providers };
};

export interface ConnectionKpis {
  open: number;
  active: number;
  requests: number;
  reused: number;
  reuseRate: number | null;
  newConnections: number;
  bytesIn: number;
  bytesOut: number;
  closeReasons: Array<{ reason: string; count: number }>;
}

export const computeKpis = (view: ConnectionView): ConnectionKpis => {
  const reused = view.requests.filter((req) => req.reused).length;
  const reasons = new Map<string, number>();
  for (const conn of view.closed) {
    reasons.set(conn.closeReason, (reasons.get(conn.closeReason) ?? 0) + 1);
  }
  return {
    open: view.open.length,
    active: view.open.filter((conn) => conn.inFlight > 0).length,
    requests: view.requests.length,
    reused,
    reuseRate: view.requests.length > 0 ? reused / view.requests.length : null,
    newConnections: view.connections.filter((conn) => conn.openedAt >= view.windowStart).length,
    bytesIn: view.connections.reduce((sum, conn) => sum + conn.bytesIn, 0),
    bytesOut: view.connections.reduce((sum, conn) => sum + conn.bytesOut, 0),
    closeReasons: Array.from(reasons, ([reason, count]) => ({ reason, count })).sort(
      (a, b) => b.count - a.count
    ),
  };
};

export interface TimelineRow {
  conn: UpstreamConnection;
  /** Bar start and end as fractions of the window, clamped to [0, 1]. */
  start: number;
  end: number;
  ticks: number[];
  tone: CloseTone;
}

/** One bar per connection; request starts become ticks on the bar. */
export const buildTimeline = (view: ConnectionView, maxRows = MAX_TIMELINE_ROWS): TimelineRow[] => {
  const span = Math.max(1, view.now - view.windowStart);
  const position = (t: number) => Math.min(1, Math.max(0, (t - view.windowStart) / span));
  const requestsByConn = new Map<number, number[]>();
  for (const req of view.requests) {
    if (!req.connId) continue;
    const list = requestsByConn.get(req.connId) ?? [];
    list.push(req.startedAt);
    requestsByConn.set(req.connId, list);
  }
  return view.connections.slice(-maxRows).map((conn) => ({
    conn,
    start: position(conn.openedAt),
    end: position(conn.closedAt ?? view.now),
    ticks: (requestsByConn.get(conn.id) ?? []).filter((t) => t >= view.windowStart).map(position),
    tone: closeTone(conn.closeReason),
  }));
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

export const formatClock = (t: number): string => {
  if (!t) return '–';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** Short label for a credential id such as "claude-1a2b3c4d-user@example.com.json". */
export const shortAuthLabel = (authId: string): string => authId.replace(/\.json$/i, '');
