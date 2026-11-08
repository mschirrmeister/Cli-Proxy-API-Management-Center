import { describe, expect, test } from 'bun:test';
import { normalizeConnectionsSnapshot } from '../src/services/api/connections';
import {
  ALL_PROVIDERS,
  OTHER_PROVIDER,
  buildConnectionView,
  buildTimeline,
  closeTone,
  computeKpis,
  formatBytes,
  formatDuration,
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
      started_at: iso(-59_000),
      ended_at: iso(-58_000),
      reused: false,
    },
    {
      id: 2,
      conn_id: 4,
      provider: 'claude',
      started_at: iso(-30_000),
      ended_at: iso(-29_000),
      reused: true,
    },
    { id: 3, conn_id: 4, provider: 'claude', started_at: iso(-2000), reused: true },
    {
      id: 4,
      conn_id: 1,
      provider: 'codex',
      started_at: iso(-30_000),
      ended_at: iso(-29_000),
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

  test('formatting', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDuration(400)).toBe('400 ms');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });
});
