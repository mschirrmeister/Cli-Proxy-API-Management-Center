/**
 * Pure view logic for the connections page: windowing, filtering, KPIs and the
 * timeline geometry. Kept free of React so it can be unit tested.
 */

import type {
  ConnectionsSnapshot,
  RequestEnd,
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

export const MAX_TIMELINE_ROWS = 200;

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

/**
 * How a request end reads: a finished exchange is "ok" (including a stream the
 * proxy stopped reading after its final event), a cut stream is "notice", a
 * failure is "bad", and a request still running is "open".
 */
export const endTone = (end: RequestEnd | string): CloseTone => {
  switch (end) {
    case '':
      return 'open';
    case 'eof':
    case 'after_final_event':
    case 'no_body':
    case 'sent':
      return 'ok';
    case 'read_error':
    case 'error':
      return 'bad';
    // closed_early, cancelled: cut short without an upstream failure.
    // closed_unchecked: a compressed stream closed early; completeness unknown.
    default:
      return 'notice';
  }
};

/** A request failed when upstream answered with an error status or the exchange broke. */
export const isFailedRequest = (req: Pick<UpstreamRequest, 'status' | 'end'>): boolean =>
  req.status >= 400 || req.end === 'error' || req.end === 'read_error';

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
  failed: number;
  /** Mean dial + TLS time of the connections opened in the window, null without any. */
  setupMs: number | null;
  /** Total dial + TLS time spent on those connections. */
  setupTotalMs: number;
  setupCount: number;
  closeReasons: Array<{ reason: string; count: number }>;
}

export const computeKpis = (view: ConnectionView): ConnectionKpis => {
  const reused = view.requests.filter((req) => req.reused).length;
  const reasons = new Map<string, number>();
  for (const conn of view.closed) {
    reasons.set(conn.closeReason, (reasons.get(conn.closeReason) ?? 0) + 1);
  }
  // Only connections opened inside the window whose dial was measured; TLS is
  // added when the transport reported it.
  const opened = view.connections.filter(
    (conn) => conn.openedAt >= view.windowStart && conn.dialMs > 0
  );
  const setupTotalMs = opened.reduce((sum, conn) => sum + conn.dialMs + conn.tlsMs, 0);
  return {
    open: view.open.length,
    active: view.open.filter((conn) => conn.inFlight > 0).length,
    requests: view.requests.length,
    reused,
    reuseRate: view.requests.length > 0 ? reused / view.requests.length : null,
    newConnections: view.connections.filter((conn) => conn.openedAt >= view.windowStart).length,
    bytesIn: view.connections.reduce((sum, conn) => sum + conn.bytesIn, 0),
    bytesOut: view.connections.reduce((sum, conn) => sum + conn.bytesOut, 0),
    failed: view.requests.filter(isFailedRequest).length,
    setupMs: opened.length > 0 ? setupTotalMs / opened.length : null,
    setupTotalMs,
    setupCount: opened.length,
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

/**
 * One bar per connection; request starts become ticks on the bar. Only the
 * newest maxRows connections get a bar; the page says when rows are left out.
 */
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

export const PAGE_SIZE = 100;

export interface Page<T> {
  rows: T[];
  /** Zero-based page, clamped to the available pages. */
  page: number;
  pages: number;
  /** One-based position of the first and last row shown; 0 when empty. */
  from: number;
  to: number;
  total: number;
}

/** One page of rows; a page beyond the end shows the last page. */
export const paginate = <T>(rows: T[], page: number, size = PAGE_SIZE): Page<T> => {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const start = current * size;
  const slice = rows.slice(start, start + size);
  return {
    rows: slice,
    page: current,
    pages,
    from: total > 0 ? start + 1 : 0,
    to: start + slice.length,
    total,
  };
};

export const MAX_REQUEST_ROWS = 100;

export interface RequestRow {
  req: UpstreamRequest;
  /** Request duration so far (in flight) or in total. */
  durationMs: number;
  tone: CloseTone;
  failed: boolean;
}

/** Newest first, optionally for one connection, capped at maxRows. */
export const buildRequestRows = (
  view: ConnectionView,
  connId: number | null = null,
  maxRows = MAX_REQUEST_ROWS
): RequestRow[] =>
  view.requests
    .filter((req) => connId === null || req.connId === connId)
    .sort((a, b) => b.startedAt - a.startedAt || b.id - a.id)
    .slice(0, maxRows)
    .map((req) => ({
      req,
      durationMs: (req.endedAt ?? view.now) - req.startedAt,
      tone: endTone(req.end),
      failed: isFailedRequest(req),
    }));

export const TTFB_MAX_ROWS = 8;
/** Both lanes need this many requests before a difference is shown. */
export const TTFB_MIN_SAMPLES = 3;

export interface TtfbPoint {
  req: UpstreamRequest;
  ms: number;
  /** Dial + TLS of the connection, for requests that opened it. */
  setupMs: number | null;
  /** Beyond the axis end; drawn at the edge. */
  clipped: boolean;
}

export interface TtfbRow {
  key: string;
  provider: string;
  model: string;
  fresh: TtfbPoint[];
  reused: TtfbPoint[];
  medianFresh: number | null;
  medianReused: number | null;
  /** Reused median minus new median, when both lanes have enough requests. */
  deltaMs: number | null;
}

export interface TtfbLaneStats {
  n: number;
  median: number;
  min: number;
  max: number;
  /** Median dial + TLS of the connections these requests opened; null when unknown. */
  setupMedian: number | null;
}

/** Count, median and range of one lane; null for an empty lane. */
export const laneStats = (points: TtfbPoint[]): TtfbLaneStats | null => {
  if (points.length === 0) return null;
  const values = points.map((p) => p.ms);
  const setups = points.map((p) => p.setupMs).filter((value): value is number => value !== null);
  return {
    n: points.length,
    median: median(values) ?? 0,
    min: Math.min(...values),
    max: Math.max(...values),
    setupMedian: median(setups),
  };
};

export interface TtfbChart {
  rows: TtfbRow[];
  axisMaxMs: number;
  clipped: number;
  hiddenRows: number;
}

export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Nearest-rank percentile; p in (0, 1]. */
export const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
};

/** Smallest 1/2/2.5/5 x 10^n at or above value. */
export const niceCeil = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * magnitude >= value) return m * magnitude;
  }
  return 10 * magnitude;
};

/** Axis tick step: a 1/2/2.5/5 x 10^n step that gives at most six intervals. */
export const tickStep = (axisMax: number): number => niceCeil(axisMax / 6);

/** Below this many values the 95th percentile is just the maximum. */
const AXIS_PERCENTILE_MIN = 20;

/**
 * Axis end for the time to first byte chart: at least twice the largest lane
 * median, and the 95th percentile once there are enough values, but never
 * beyond the largest value. Slower values are pinned at the edge, so one
 * outlier does not squeeze every other mark into a corner.
 */
const ttfbAxisEnd = (groups: UpstreamRequest[][]): number => {
  const all = groups.flat().map((req) => req.firstByteMs);
  if (all.length === 0) return 1;
  const laneMedians = groups.flatMap((reqs) =>
    [reqs.filter((req) => !req.reused), reqs.filter((req) => req.reused)]
      .map((lane) => median(lane.map((req) => req.firstByteMs)))
      .filter((value): value is number => value !== null)
  );
  let end = 2 * Math.max(...laneMedians);
  if (all.length >= AXIS_PERCENTILE_MIN) {
    end = Math.max(end, percentile(all, 0.95) ?? 0);
  }
  return niceCeil(Math.min(Math.max(...all), end));
};

/**
 * Time to first byte per provider and model, split by new and reused
 * connection. Only streaming requests count: without streaming the first byte
 * arrives with the finished answer, which measures generation, not the
 * connection. Failed requests and WebSocket turns are left out.
 */
export const buildTtfbChart = (view: ConnectionView, maxRows = TTFB_MAX_ROWS): TtfbChart => {
  const conns = new Map(view.connections.map((conn) => [conn.id, conn]));
  const groups = new Map<string, { provider: string; model: string; reqs: UpstreamRequest[] }>();
  for (const req of view.requests) {
    if (!req.stream || req.method === 'WS' || req.firstByteMs <= 0 || isFailedRequest(req)) {
      continue;
    }
    const provider = req.provider || OTHER_PROVIDER;
    const model = req.model || req.path || req.host;
    const key = `${provider}\u0000${model}`;
    const group = groups.get(key) ?? { provider, model, reqs: [] };
    group.reqs.push(req);
    groups.set(key, group);
  }
  // Models with both new and reused requests first: only they can show a
  // difference. Then the busiest.
  const bothLanes = (reqs: UpstreamRequest[]) =>
    reqs.some((req) => req.reused) && reqs.some((req) => !req.reused) ? 1 : 0;
  const ordered = Array.from(groups, ([key, group]) => ({ key, ...group })).sort(
    (a, b) =>
      bothLanes(b.reqs) - bothLanes(a.reqs) ||
      b.reqs.length - a.reqs.length ||
      a.key.localeCompare(b.key)
  );
  const shown = ordered.slice(0, maxRows);
  const axisMaxMs = ttfbAxisEnd(shown.map((group) => group.reqs));

  let clipped = 0;
  const point = (req: UpstreamRequest): TtfbPoint => {
    const conn = conns.get(req.connId);
    const isClipped = req.firstByteMs > axisMaxMs;
    if (isClipped) clipped += 1;
    return {
      req,
      ms: req.firstByteMs,
      setupMs: !req.reused && conn && conn.dialMs > 0 ? conn.dialMs + conn.tlsMs : null,
      clipped: isClipped,
    };
  };
  const rows = shown.map((group): TtfbRow => {
    const sorted = [...group.reqs].sort((a, b) => a.startedAt - b.startedAt);
    const fresh = sorted.filter((req) => !req.reused).map(point);
    const reused = sorted.filter((req) => req.reused).map(point);
    const medianFresh = median(fresh.map((p) => p.ms));
    const medianReused = median(reused.map((p) => p.ms));
    const enough = fresh.length >= TTFB_MIN_SAMPLES && reused.length >= TTFB_MIN_SAMPLES;
    return {
      key: group.key,
      provider: group.provider,
      model: group.model,
      fresh,
      reused,
      medianFresh,
      medianReused,
      deltaMs:
        enough && medianFresh !== null && medianReused !== null ? medianReused - medianFresh : null,
    };
  });
  return { rows, axisMaxMs, clipped, hiddenRows: Math.max(0, ordered.length - shown.length) };
};

/** Signed duration for differences, with a real minus sign: "−194 ms", "+1.2 s". */
export const formatDelta = (ms: number): string =>
  `${ms < 0 ? '\u2212' : '+'}${formatDuration(Math.abs(ms))}`;

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
  // One decimal below 10 s, so that request timings (1.4 s vs 1.9 s) stay apart.
  if (ms < 9950) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 59_500) return `${Math.round(ms / 1000)} s`;
  const seconds = Math.round(ms / 1000);
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
