/**
 * Upstream connections page: which connections the proxy holds to each
 * provider, how often requests reuse them, and why they were closed.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { IconRefreshCw } from '@/components/ui/icons';
import {
  connectionsApi,
  type ConnectionsSnapshot,
  type UpstreamConnection,
} from '@/services/api/connections';
import { useAuthStore } from '@/stores';
import type { ApiError } from '@/types';
import {
  ALL_PROVIDERS,
  CONNECTION_RANGES,
  OTHER_PROVIDER,
  buildConnectionView,
  buildTimeline,
  closeTone,
  computeKpis,
  formatBytes,
  formatClock,
  formatDuration,
  shortAuthLabel,
  type ConnectionRangeId,
} from './model';
import styles from './ConnectionsPage.module.scss';

const POLL_INTERVAL_MS = 2000;
const CLOSED_TABLE_LIMIT = 50;

type LoadState = 'loading' | 'ready' | 'unsupported' | 'error';

export function ConnectionsPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [snapshot, setSnapshot] = useState<ConnectionsSnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [range, setRange] = useState<ConnectionRangeId>('15m');
  const [provider, setProvider] = useState(ALL_PROVIDERS);
  const [paused, setPaused] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const next = await connectionsApi.getSnapshot();
      if (seq !== requestSeq.current) return;
      setSnapshot(next);
      setLoadState('ready');
      setError('');
    } catch (err) {
      if (seq !== requestSeq.current) return;
      const apiError = err as ApiError;
      if (apiError?.status === 404) {
        setLoadState('unsupported');
        return;
      }
      setError(apiError?.message || String(err));
      setLoadState((prev) => (prev === 'ready' ? prev : 'error'));
    }
  }, []);

  useEffect(() => {
    if (connectionStatus !== 'connected') return undefined;
    void load();
    if (paused) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connectionStatus, load, paused]);

  const view = useMemo(
    () => (snapshot ? buildConnectionView(snapshot, range, provider) : null),
    [snapshot, range, provider]
  );
  const kpis = useMemo(() => (view ? computeKpis(view) : null), [view]);
  const timeline = useMemo(() => (view ? buildTimeline(view) : []), [view]);

  const providerOptions = useMemo(
    () => [
      { value: ALL_PROVIDERS, label: t('connections.all_providers') },
      ...(view?.providers ?? []).map((p) => ({
        value: p,
        label: p === OTHER_PROVIDER ? t('connections.provider_other') : p,
      })),
    ],
    [t, view?.providers]
  );

  const kindLabel = (kind: string) => t(`connections.kind.${kind}`, { defaultValue: kind });
  const reasonLabel = (reason: string) =>
    reason
      ? t(`connections.reason.${reason}`, { defaultValue: reason })
      : t('connections.state_open');
  const providerLabel = (conn: UpstreamConnection) =>
    conn.provider || t('connections.provider_other');

  if (loadState === 'unsupported') {
    return (
      <div className={styles.page}>
        <Header title={t('connections.title')} meta={null} />
        <EmptyState
          title={t('connections.unsupported_title')}
          description={t('connections.unsupported_desc')}
        />
      </div>
    );
  }

  if (!snapshot || !view || !kpis) {
    return (
      <div className={styles.page}>
        <Header title={t('connections.title')} meta={null} />
        {loadState === 'error' ? (
          <EmptyState title={t('connections.load_error')} description={error} />
        ) : (
          <div className={styles.muted}>{t('connections.loading')}</div>
        )}
      </div>
    );
  }

  const span = Math.max(1, view.now - view.windowStart);
  const events = snapshot.events.filter((ev) => ev.time >= view.windowStart);

  return (
    <div className={styles.page}>
      <Header
        title={t('connections.title')}
        meta={
          <>
            <span className={snapshot.enabled ? styles.metaLive : styles.metaOff}>
              {snapshot.enabled ? t('connections.recording') : t('connections.not_recording')}
            </span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span>{t('connections.updated_at', { time: formatClock(snapshot.now) })}</span>
            {error && (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span className={styles.metaOff}>{error}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <div className={styles.segmented} role="group" aria-label={t('connections.range')}>
              {CONNECTION_RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={r.id === range ? styles.segmentActive : styles.segment}
                  aria-pressed={r.id === range}
                  onClick={() => setRange(r.id)}
                >
                  {r.id}
                </button>
              ))}
            </div>
            <Select
              value={provider}
              options={providerOptions}
              onChange={setProvider}
              ariaLabel={t('connections.provider')}
              size="sm"
              fullWidth={false}
              className={styles.providerSelect}
            />
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
            >
              {paused ? t('connections.resume') : t('connections.pause')}
            </button>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => void load()}
              aria-label={t('connections.refresh')}
              title={t('connections.refresh')}
            >
              <IconRefreshCw size={14} />
            </button>
          </>
        }
      />

      {!snapshot.enabled && <div className={styles.notice}>{t('connections.disabled_hint')}</div>}

      <section className={styles.kpis} aria-label={t('connections.summary')}>
        <Kpi
          label={t('connections.kpi_open')}
          value={String(kpis.open)}
          hint={t('connections.kpi_active', { count: kpis.active })}
        />
        <Kpi
          label={t('connections.kpi_reuse')}
          value={kpis.reuseRate === null ? '–' : `${Math.round(kpis.reuseRate * 100)}%`}
          hint={t('connections.kpi_reuse_hint', { reused: kpis.reused, total: kpis.requests })}
        />
        <Kpi
          label={t('connections.kpi_new')}
          value={String(kpis.newConnections)}
          hint={t('connections.kpi_new_hint')}
        />
        <Kpi
          label={t('connections.kpi_bytes')}
          value={formatBytes(kpis.bytesIn)}
          hint={t('connections.kpi_bytes_hint', { out: formatBytes(kpis.bytesOut) })}
        />
      </section>

      {kpis.closeReasons.length > 0 && (
        <div className={styles.reasons} aria-label={t('connections.close_reasons')}>
          {kpis.closeReasons.map((r) => (
            <span
              key={r.reason}
              className={`${styles.chip} ${styles[`tone_${closeTone(r.reason)}`]}`}
            >
              {reasonLabel(r.reason)} <strong>{r.count}</strong>
            </span>
          ))}
        </div>
      )}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>{t('connections.timeline')}</h2>
          <span className={styles.muted}>
            {formatClock(view.windowStart)} – {formatClock(view.now)}
          </span>
        </div>
        {timeline.length === 0 ? (
          <div className={styles.muted}>{t('connections.empty')}</div>
        ) : (
          <div className={styles.timeline}>
            {timeline.map((row) => (
              <div key={row.conn.id} className={styles.timelineRow}>
                <div className={styles.timelineLabel} title={row.conn.authId || undefined}>
                  <span className={styles.provider}>{providerLabel(row.conn)}</span>
                  <span className={styles.muted}>#{row.conn.id}</span>
                </div>
                <div className={styles.track}>
                  {events.map((ev) => (
                    <span
                      key={`${ev.kind}-${ev.time}`}
                      className={styles.eventLine}
                      style={{ left: `${((ev.time - view.windowStart) / span) * 100}%` }}
                      title={`${t(`connections.event.${ev.kind}`, { defaultValue: ev.kind })} ${formatClock(ev.time)}`}
                    />
                  ))}
                  <span
                    className={`${styles.bar} ${styles[`bar_${row.tone}`]}`}
                    style={{
                      left: `${row.start * 100}%`,
                      width: `${Math.max(0.4, (row.end - row.start) * 100)}%`,
                    }}
                    title={[
                      `#${row.conn.id} ${kindLabel(row.conn.kind)} → ${row.conn.addr}`,
                      `${formatClock(row.conn.openedAt)} – ${
                        row.conn.closedAt
                          ? formatClock(row.conn.closedAt)
                          : t('connections.state_open')
                      }`,
                      t('connections.tooltip_requests', { count: row.conn.requests }),
                      `${formatBytes(row.conn.bytesIn)} ↓ / ${formatBytes(row.conn.bytesOut)} ↑`,
                      reasonLabel(row.conn.closeReason),
                    ].join('\n')}
                  />
                  {row.ticks.map((x, i) => (
                    <span key={i} className={styles.tick} style={{ left: `${x * 100}%` }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>{t('connections.open_connections')}</h2>
          <span className={styles.muted}>{view.open.length}</span>
        </div>
        <ConnTable
          rows={view.open}
          now={view.now}
          kindLabel={kindLabel}
          reasonLabel={reasonLabel}
          showReason={false}
        />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>{t('connections.closed_connections')}</h2>
          <span className={styles.muted}>{view.closed.length}</span>
        </div>
        <ConnTable
          rows={view.closed.slice(0, CLOSED_TABLE_LIMIT)}
          now={view.now}
          kindLabel={kindLabel}
          reasonLabel={reasonLabel}
          showReason
        />
      </section>
    </div>
  );
}

function Header({ title, meta, actions }: { title: string; meta: ReactNode; actions?: ReactNode }) {
  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <h1 className={styles.title}>{title}</h1>
        {meta && <p className={styles.meta}>{meta}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
      <div className={styles.kpiHint}>{hint}</div>
    </div>
  );
}

function ConnTable({
  rows,
  now,
  kindLabel,
  reasonLabel,
  showReason,
}: {
  rows: UpstreamConnection[];
  now: number;
  kindLabel: (kind: string) => string;
  reasonLabel: (reason: string) => string;
  showReason: boolean;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <div className={styles.muted}>{t('connections.empty')}</div>;
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>{t('connections.col_provider')}</th>
            <th>{t('connections.col_kind')}</th>
            <th>{t('connections.col_target')}</th>
            <th>{t('connections.col_tls')}</th>
            <th className={styles.num}>{t('connections.col_requests')}</th>
            <th className={styles.num}>{t('connections.col_bytes')}</th>
            <th className={styles.num}>{t('connections.col_age')}</th>
            <th className={styles.num}>
              {showReason ? t('connections.col_closed') : t('connections.col_idle')}
            </th>
            {showReason && <th>{t('connections.col_reason')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const end = c.closedAt ?? now;
            const idleSince = c.lastRequestEnd ?? c.lastIo;
            return (
              <tr key={c.id}>
                <td className={styles.mono}>{c.id}</td>
                <td>
                  <div>{c.provider || t('connections.provider_other')}</div>
                  {c.authId && <div className={styles.sub}>{shortAuthLabel(c.authId)}</div>}
                </td>
                <td>{kindLabel(c.kind)}</td>
                <td className={styles.mono}>
                  <div>{c.addr}</div>
                  <div className={styles.sub}>{c.local}</div>
                </td>
                <td className={styles.mono}>
                  <div>{[c.proto, c.tlsVersion].filter(Boolean).join(' · ') || '–'}</div>
                  <div className={styles.sub}>
                    {t('connections.handshake', {
                      dial: formatDuration(c.dialMs),
                      tls: c.tlsMs ? formatDuration(c.tlsMs) : '–',
                    })}
                    {c.tlsResumed ? ` · ${t('connections.resumed')}` : ''}
                  </div>
                </td>
                <td className={styles.num}>
                  {c.requests}
                  {c.inFlight > 0 && <span className={styles.live}> ●</span>}
                </td>
                <td className={styles.num}>
                  <div>{formatBytes(c.bytesIn)} ↓</div>
                  <div className={styles.sub}>{formatBytes(c.bytesOut)} ↑</div>
                </td>
                <td className={styles.num}>{formatDuration(end - c.openedAt)}</td>
                <td className={styles.num}>
                  {showReason
                    ? formatClock(c.closedAt ?? 0)
                    : c.inFlight > 0
                      ? t('connections.state_active')
                      : formatDuration(now - idleSince)}
                </td>
                {showReason && (
                  <td>
                    <span
                      className={`${styles.chip} ${styles[`tone_${closeTone(c.closeReason)}`]}`}
                      title={c.closeError || undefined}
                    >
                      {reasonLabel(c.closeReason)}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
