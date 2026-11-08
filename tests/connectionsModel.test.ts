import { describe, expect, test } from 'bun:test';
import { normalizeConnectionsSnapshot } from '../src/services/api/connections';
import {
  ALL_PROVIDERS,
  OTHER_PROVIDER,
  buildConnectionView,
  buildRequestRows,
  buildTimeline,
  closeTone,
  computeKpis,
  endTone,
  buildTtfbChart,
  formatDelta,
  laneStats,
  median,
  niceCeil,
  percentile,
  tickStep,
  formatBytes,
  formatDuration,
  paginate,
} from '../src/features/connections/model';

const NOW = Date.parse('2026-11-08T03:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const raw = {
  enabled: true,
  now: iso(0),
  started_at: iso(-3 * 60 * 60 * 1000),
  totals: {
    conns_opened: 4,
    conns_closed: 3,
    requests: 5,
    reused_requests: 2,
    close_reasons: { server_idle: 1 },
  },
  open: [
    {
      id: 4,
      kind: 'claude_code_utls',
      provider: 'claude',
      auth_id: 'claude-x.json',
      addr: 'api.anthropic.com:443',
      dial_ms: 20,
      tls_ms: 30,
      opened_at: iso(-60_000),
      last_io: iso(-1000),
      bytes_in: 1000,
      bytes_out: 500,
      requests: 3,
      in_flight: 1,
    },
  ],
  closed: [
    {
      id: 1,
      kind: 'chrome_utls',
      provider: 'codex',
      dial_ms: 15,
      tls_ms: 25,
      opened_at: iso(-30_000),
      closed_at: iso(-29_000),
      bytes_in: 200,
      bytes_out: 100,
      requests: 1,
      close_reason: 'proxy_per_request',
    },
    {
      id: 2,
      kind: 'standard',
      provider: '',
      dial_ms: 10,
      opened_at: iso(-50_000),
      closed_at: iso(-40_000),
      bytes_in: 10,
      bytes_out: 10,
      close_reason: 'proxy_idle',
    },
    {
      id: 3,
      kind: 'claude_code_utls',
      provider: 'claude',
      opened_at: iso(-3 * 60 * 60 * 1000),
      closed_at: iso(-2 * 60 * 60 * 1000),
      close_reason: 'server_idle',
    },
  ],
  requests: [
    {
      id: 1,
      conn_id: 4,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      status: 200,
      started_at: iso(-59_000),
      ended_at: iso(-58_000),
      end: 'eof',
      reused: false,
    },
    {
      id: 2,
      conn_id: 4,
      provider: 'claude',
      status: 200,
      stream: true,
      started_at: iso(-30_000),
      ended_at: iso(-29_000),
      end: 'after_final_event',
      reused: true,
    },
    { id: 3, conn_id: 4, provider: 'claude', started_at: iso(-2000), reused: true },
    {
      id: 4,
      conn_id: 1,
      provider: 'codex',
      status: 429,
      started_at: iso(-30_000),
      ended_at: iso(-29_000),
      end: 'eof',
      reused: false,
    },
  ],
  events: [{ time: iso(-10_000), kind: 'config_reload' }],
};

describe('connections model', () => {
  const snapshot = normalizeConnectionsSnapshot(raw);

  test('normalizes snake_case fields and times', () => {
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.now).toBe(NOW);
    expect(snapshot.open[0].authId).toBe('claude-x.json');
    expect(snapshot.open[0].inFlight).toBe(1);
    expect(snapshot.closed[0].closedAt).toBe(NOW - 29_000);
    expect(snapshot.requests[2].endedAt).toBeNull();
    expect(snapshot.totals.closeReasons.server_idle).toBe(1);
  });

  test('tolerates garbage', () => {
    const empty = normalizeConnectionsSnapshot({ open: 'x', closed: [null, 1], requests: {} });
    expect(empty.open).toEqual([]);
    expect(empty.closed).toEqual([]);
    expect(empty.requests).toEqual([]);
  });

  test('window drops connections closed before the range', () => {
    const view = buildConnectionView(snapshot, '1h', ALL_PROVIDERS);
    expect(view.connections.map((c) => c.id)).toEqual([4, 2, 1]);
    expect(view.providers).toEqual(['claude', 'codex', OTHER_PROVIDER]);
    const day = buildConnectionView(snapshot, '24h', ALL_PROVIDERS);
    expect(day.connections.map((c) => c.id)).toContain(3);
  });

  test('provider filter includes unlabeled connections as other', () => {
    expect(
      buildConnectionView(snapshot, '1h', OTHER_PROVIDER).connections.map((c) => c.id)
    ).toEqual([2]);
    expect(buildConnectionView(snapshot, '1h', 'claude').requests.length).toBe(3);
  });

  test('KPIs count reuse and handshakes in the window', () => {
    const kpis = computeKpis(buildConnectionView(snapshot, '1h', ALL_PROVIDERS));
    expect(kpis.open).toBe(1);
    expect(kpis.active).toBe(1);
    expect(kpis.requests).toBe(4);
    expect(kpis.reused).toBe(2);
    expect(kpis.reuseRate).toBe(0.5);
    expect(kpis.newConnections).toBe(3);
    expect(kpis.bytesIn).toBe(1210);
    expect(kpis.closeReasons.map((r) => r.reason).sort()).toEqual([
      'proxy_idle',
      'proxy_per_request',
    ]);
  });

  test('setup time and failures', () => {
    const kpis = computeKpis(buildConnectionView(snapshot, '1h', ALL_PROVIDERS));
    // Connections 4, 2 and 1 opened in the window: (20+30) + 10 + (15+25).
    expect(kpis.setupCount).toBe(3);
    expect(kpis.setupTotalMs).toBe(100);
    expect(kpis.setupMs).toBeCloseTo(100 / 3, 5);
    expect(kpis.failed).toBe(1);
    const none = computeKpis(
      buildConnectionView(normalizeConnectionsSnapshot({}), '1h', ALL_PROVIDERS)
    );
    expect(none.setupMs).toBeNull();
  });

  test('request rows: newest first, connection filter, tones', () => {
    const view = buildConnectionView(snapshot, '1h', ALL_PROVIDERS);
    const rows = buildRequestRows(view);
    expect(rows.map((r) => r.req.id)).toEqual([3, 4, 2, 1]);
    expect(rows[0].tone).toBe('open');
    expect(rows[0].durationMs).toBe(2000);
    expect(rows[1].failed).toBe(true);
    expect(rows[2].tone).toBe('ok');
    expect(rows[3].req.model).toBe('claude-sonnet-5-5');
    expect(buildRequestRows(view, 4).map((r) => r.req.id)).toEqual([3, 2, 1]);
    expect(buildRequestRows(view, null, 2)).toHaveLength(2);
  });

  test('end tones', () => {
    expect(endTone('eof')).toBe('ok');
    expect(endTone('after_final_event')).toBe('ok');
    expect(endTone('sent')).toBe('ok');
    expect(endTone('closed_early')).toBe('notice');
    expect(endTone('cancelled')).toBe('notice');
    expect(endTone('read_error')).toBe('bad');
    expect(endTone('error')).toBe('bad');
    expect(endTone('')).toBe('open');
  });

  test('timeline positions bars and ticks inside the window', () => {
    const rows = buildTimeline(buildConnectionView(snapshot, '15m', 'claude'));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.end).toBe(1);
    expect(row.start).toBeCloseTo(1 - 60_000 / (15 * 60 * 1000), 5);
    expect(row.ticks).toHaveLength(3);
    expect(row.tone).toBe('open');
  });

  test('close tones', () => {
    expect(closeTone('server_idle')).toBe('ok');
    expect(closeTone('proxy_per_request')).toBe('ok');
    expect(closeTone('proxy_closed')).toBe('ok');
    expect(closeTone('proxy_after_response')).toBe('notice');
    expect(closeTone('error')).toBe('bad');
    expect(closeTone('')).toBe('open');
  });

  test('pagination', () => {
    const rows = Array.from({ length: 250 }, (_, i) => i);
    expect(paginate(rows, 0)).toMatchObject({ page: 0, pages: 3, from: 1, to: 100, total: 250 });
    const last = paginate(rows, 2);
    expect(last).toMatchObject({ from: 201, to: 250 });
    expect(last.rows[0]).toBe(200);
    // Beyond the end and negative pages clamp.
    expect(paginate(rows, 9).page).toBe(2);
    expect(paginate(rows, -1).page).toBe(0);
    expect(paginate([], 0)).toMatchObject({ page: 0, pages: 1, from: 0, to: 0, total: 0 });
    expect(paginate(rows, 1, 50)).toMatchObject({ from: 51, to: 100, pages: 5 });
  });

  test('formatting', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDuration(400)).toBe('400 ms');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(1441)).toBe('1.4 s');
    expect(formatDuration(1856)).toBe('1.9 s');
    expect(formatDuration(9949)).toBe('9.9 s');
    expect(formatDuration(9960)).toBe('10 s');
    expect(formatDuration(59_400)).toBe('59 s');
    expect(formatDuration(59_700)).toBe('1m 0s');
  });
});

describe('time to first byte chart', () => {
  const stream = (
    id: number,
    connId: number,
    reused: boolean,
    ttfb: number,
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    conn_id: connId,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    method: 'POST',
    status: 200,
    stream: true,
    reused,
    first_byte_ms: ttfb,
    started_at: iso(-60_000 + id * 1000),
    ended_at: iso(-59_000 + id * 1000),
    end: 'eof',
    ...extra,
  });
  const snap = normalizeConnectionsSnapshot({
    enabled: true,
    now: iso(0),
    open: [
      { id: 1, provider: 'claude', dial_ms: 20, tls_ms: 25, opened_at: iso(-60_000) },
      { id: 2, provider: 'claude', dial_ms: 30, tls_ms: 30, opened_at: iso(-50_000) },
      { id: 3, provider: 'claude', dial_ms: 25, tls_ms: 20, opened_at: iso(-40_000) },
    ],
    closed: [],
    requests: [
      stream(1, 1, false, 1800),
      stream(2, 1, true, 1400),
      stream(3, 1, true, 1450),
      stream(4, 2, false, 1900),
      stream(5, 1, true, 1500),
      stream(6, 3, false, 1850),
      stream(7, 1, true, 12_000),
      // Not counted: no stream, failed, WebSocket turn, no first byte.
      stream(8, 1, true, 900, { stream: false }),
      stream(9, 1, true, 300, { status: 529 }),
      stream(10, 1, true, 0, { method: 'WS' }),
      stream(11, 1, true, 0),
      { ...stream(12, 1, true, 600), provider: 'openai-compatible-openrouter', model: 'qwen' },
    ],
  });
  const view = buildConnectionView(snap, '15m', ALL_PROVIDERS);

  test('groups streaming requests by provider and model, both lanes first', () => {
    const chart = buildTtfbChart(view);
    expect(chart.rows.map((r) => r.model)).toEqual(['claude-haiku-5-5', 'qwen']);
    const [row] = chart.rows;
    expect(row.fresh.map((p) => p.req.id)).toEqual([1, 4, 6]);
    expect(row.reused.map((p) => p.req.id)).toEqual([2, 3, 5, 7]);
    expect(row.medianFresh).toBe(1850);
    expect(row.medianReused).toBe(1475);
    expect(row.deltaMs).toBe(-375);
    expect(row.fresh[0].setupMs).toBe(45);
    expect(row.reused[0].setupMs).toBeNull();
  });

  test('needs enough samples in both lanes for a difference', () => {
    const chart = buildTtfbChart(view);
    expect(chart.rows[1].deltaMs).toBeNull();
    expect(chart.rows[1].fresh).toHaveLength(0);
  });

  test('axis covers the medians, ignores lone outliers and pins them', () => {
    const chart = buildTtfbChart(view);
    // 8 values: too few for a percentile; twice the largest median (1850 ms)
    // rounds up to 5 s, and the 12 s outlier is pinned.
    expect(chart.axisMaxMs).toBe(5000);
    expect(chart.clipped).toBe(1);
    const many = normalizeConnectionsSnapshot({
      now: iso(0),
      requests: [
        ...Array.from({ length: 30 }, (_, i) => stream(i + 1, 1, i > 0, 1000 + i * 10)),
        stream(99, 1, true, 30_000),
      ],
    });
    const pinned = buildTtfbChart(buildConnectionView(many, '15m', ALL_PROVIDERS));
    // p95 is 1290 ms, twice the reused median (1155 ms) is 2310 ms -> 2.5 s.
    expect(pinned.axisMaxMs).toBe(2500);
    expect(pinned.clipped).toBe(1);
    expect(pinned.rows[0].reused.find((p) => p.req.id === 99)?.clipped).toBe(true);
  });

  test('row limit reports hidden rows', () => {
    const chart = buildTtfbChart(view, 1);
    expect(chart.rows).toHaveLength(1);
    expect(chart.hiddenRows).toBe(1);
  });

  test('rows with both lanes come before busier rows with one lane', () => {
    const extra = normalizeConnectionsSnapshot({
      now: iso(0),
      requests: [
        stream(1, 1, false, 900, { model: 'a' }),
        stream(2, 1, true, 800, { model: 'a' }),
        ...Array.from({ length: 5 }, (_, i) => stream(10 + i, 1, true, 500, { model: 'b' })),
      ],
    });
    const chart = buildTtfbChart(buildConnectionView(extra, '15m', ALL_PROVIDERS));
    expect(chart.rows.map((r) => r.model)).toEqual(['a', 'b']);
  });

  test('lane stats', () => {
    const [row] = buildTtfbChart(view).rows;
    expect(laneStats(row.fresh)).toEqual({
      n: 3,
      median: 1850,
      min: 1800,
      max: 1900,
      setupMedian: 45,
    });
    expect(laneStats(row.reused)?.max).toBe(12_000);
    expect(laneStats([])).toBeNull();
  });

  test('helpers', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(
      percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100], 0.95)
    ).toBe(19);
    expect(niceCeil(1290)).toBe(2000);
    expect(niceCeil(2100)).toBe(2500);
    expect(niceCeil(480)).toBe(500);
    expect(tickStep(2000)).toBe(500);
    expect(tickStep(2500)).toBe(500);
    expect(formatDelta(-194)).toBe('\u2212194 ms');
    expect(formatDelta(1200)).toBe('+1.2 s');
  });
});
