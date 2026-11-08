/**
 * Upstream connections page: which connections the proxy holds to each
 * provider, how often requests reuse them, and why they were closed.
 *
 * Three tabs share the header filters: an overview (KPIs, timeline, time to
 * first byte), the request list and the connection tables. Long lists are
 * paged inside their card. The active tab is remembered in localStorage.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
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
  buildRequestRows,
  buildTimeline,
  buildTtfbChart,
  closeTone,
  computeKpis,
  formatBytes,
  formatClock,
  formatDuration,
  paginate,
  shortAuthLabel,
  type ConnectionRangeId,
  type Page,
  type RequestRow,
} from './model';
import { TtfbChart } from './TtfbChart';
import styles from './ConnectionsPage.module.scss';

const POLL_INTERVAL_MS = 2000;
const TAB_IDS = ['overview', 'requests', 'connections'] as const;
type TabId = (typeof TAB_IDS)[number];
const TAB_STORAGE_KEY = 'connections:tab';

type LoadState = 'loading' | 'ready' | 'unsupported' | 'error';

const isTabId = (value: string | null): value is TabId =>
  value !== null && (TAB_IDS as readonly string[]).includes(value);

/**
 * Pages a live list. While a later page is shown the list is frozen at the
 * moment the reader left page one, so rows do not shift under them as new
 * entries arrive; page one is always live. A change of resetKey (filters)
 * returns to page one.
 */
function usePagedList<T>(rows: T[], resetKey: string) {
  const [page, setPage] = useState(0);
  const [frozen, setFrozen] = useState<T[] | null>(null);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    setKey(resetKey);
    setPage(0);
    setFrozen(null);
  }
  const current: Page<T> = paginate(page > 0 && frozen ? frozen : rows, page);
  const go = (next: number) => {
    if (next <= 0) {
      setFrozen(null);
      setPage(0);
      return;
    }
    if (page === 0) setFrozen(rows);
    setPage(next);
  };
  return { ...current, frozen: current.page > 0, go };
}

export function ConnectionsPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [searchParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<ConnectionsSnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [range, setRange] = useState<ConnectionRangeId>('15m');
  const [provider, setProvider] = useState(ALL_PROVIDERS);
  const [paused, setPaused] = useState(false);
  const [connFilter, setConnFilter] = useState<number | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const requestSeq = useRef(0);

  // The active tab lives in component state and is remembered across visits,
  // like the config page does. The page is rendered with the location it was
  // entered with (PageTransition), so later ?tab= changes would not reach it;
  // ?tab= only works as an entry link.
  const [tab, setTabState] = useState<TabId>(() => {
    const fromUrl = searchParams.get('tab');
    if (isTabId(fromUrl)) return fromUrl;
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    return isTabId(stored) ? stored : 'overview';
  });
  const setTab = useCallback((next: TabId) => {
    setTabState(next);
    localStorage.setItem(TAB_STORAGE_KEY, next);
  }, []);
  // Picking a connection anywhere on the page shows its requests.
  const selectConn = useCallback(
    (id: number) => {
      setConnFilter(id);
      setTab('requests');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [setTab]
  );

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
  const ttfbChart = useMemo(() => (view ? buildTtfbChart(view) : null), [view]);
  const allRequestRows = useMemo(
    () => (view ? buildRequestRows(view, connFilter, Number.POSITIVE_INFINITY) : []),
    [view, connFilter]
  );
  const failedCount = useMemo(
    () => allRequestRows.filter((row) => row.failed).length,
    [allRequestRows]
  );
  const requestRows = useMemo(
    () => (failedOnly ? allRequestRows.filter((row) => row.failed) : allRequestRows),
    [allRequestRows, failedOnly]
  );
  const filterKey = `${range}|${provider}|${connFilter ?? ''}|${failedOnly}`;
  const requestPage = usePagedList(requestRows, filterKey);
  const closedPage = usePagedList(view?.closed ?? [], `${range}|${provider}`);

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
  const tabCounts: Record<TabId, string | null> = {
    overview: null,
    requests: String(view.requests.length),
    connections: `${view.open.length} / ${view.closed.length}`,
  };

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

      <Tabs active={tab} counts={tabCounts} onChange={setTab} />

      {tab === 'overview' && (
        <div
          className={styles.tabPanel}
          role="tabpanel"
          id="connections-panel-overview"
          aria-labelledby="connections-tab-overview"
        >
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
              label={t('connections.kpi_setup')}
              value={kpis.setupMs === null ? '–' : formatDuration(kpis.setupMs)}
              hint={t('connections.kpi_setup_hint', {
                count: kpis.setupCount,
                total: formatDuration(kpis.setupTotalMs),
              })}
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
                      <ConnLink id={row.conn.id} onSelect={selectConn} />
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
                          row.conn.proxy
                            ? t('connections.proxy_via', { proxy: row.conn.proxy })
                            : null,
                          `${formatClock(row.conn.openedAt)} – ${
                            row.conn.closedAt
                              ? formatClock(row.conn.closedAt)
                              : t('connections.state_open')
                          }`,
                          t('connections.tooltip_requests', { count: row.conn.requests }),
                          `${formatBytes(row.conn.bytesIn)} ↓ / ${formatBytes(row.conn.bytesOut)} ↑`,
                          // The time range already says "open" for open connections.
                          row.conn.closedAt ? reasonLabel(row.conn.closeReason) : null,
                        ]
                          .filter(Boolean)
                          .join('\n')}
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

          {ttfbChart && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <h2>{t('connections.ttfb.title')}</h2>
                <span className={styles.ttfbLegend}>
                  <span>
                    <i className={styles.legendNew} aria-hidden="true" />
                    {t('connections.ttfb.legend_new')}
                  </span>
                  <span>
                    <i className={styles.legendReused} aria-hidden="true" />
                    {t('connections.ttfb.legend_reused')}
                  </span>
                  <span>
                    <i className={styles.legendRange} aria-hidden="true" />
                    {t('connections.ttfb.legend_range')}
                  </span>
                </span>
              </div>
              <p className={styles.ttfbHint}>
                {t('connections.ttfb.hint')}
                {ttfbChart.clipped > 0 &&
                  ` · ${t('connections.ttfb.clipped', { count: ttfbChart.clipped })}`}
                {ttfbChart.hiddenRows > 0 &&
                  ` · ${t('connections.ttfb.hidden_rows', { count: ttfbChart.hiddenRows })}`}
              </p>
              <TtfbChart chart={ttfbChart} />
            </section>
          )}
        </div>
      )}

      {tab === 'requests' && (
        <div
          className={styles.tabPanel}
          role="tabpanel"
          id="connections-panel-requests"
          aria-labelledby="connections-tab-requests"
        >
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2>{t('connections.requests')}</h2>
              <span className={styles.cardMeta}>
                {connFilter !== null && (
                  <button
                    type="button"
                    className={styles.filterChip}
                    onClick={() => setConnFilter(null)}
                    title={t('connections.clear_filter')}
                  >
                    {t('connections.filter_conn', { id: connFilter })} ×
                  </button>
                )}
                <button
                  type="button"
                  className={failedOnly ? styles.filterChipActive : styles.filterChip}
                  aria-pressed={failedOnly}
                  onClick={() => setFailedOnly((v) => !v)}
                >
                  {t('connections.failed_only', { count: failedCount })}
                </button>
                <Pager page={requestPage} />
              </span>
            </div>
            <RequestTable rows={requestPage.rows} onSelectConn={selectConn} />
          </section>
        </div>
      )}

      {tab === 'connections' && (
        <div
          className={styles.tabPanel}
          role="tabpanel"
          id="connections-panel-connections"
          aria-labelledby="connections-tab-connections"
        >
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
              onSelectConn={selectConn}
            />
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2>{t('connections.closed_connections')}</h2>
              <span className={styles.cardMeta}>
                <Pager page={closedPage} />
              </span>
            </div>
            <ConnTable
              rows={closedPage.rows}
              now={view.now}
              kindLabel={kindLabel}
              reasonLabel={reasonLabel}
              showReason
              onSelectConn={selectConn}
            />
          </section>
        </div>
      )}
    </div>
  );
}

function Tabs({
  active,
  counts,
  onChange,
}: {
  active: TabId;
  counts: Record<TabId, string | null>;
  onChange: (id: TabId) => void;
}) {
  const { t } = useTranslation();
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TAB_IDS.indexOf(active);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % TAB_IDS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TAB_IDS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(TAB_IDS[next]);
    refs.current[TAB_IDS[next]]?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('connections.tabs_label')}>
      {TAB_IDS.map((id) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            ref={(node) => {
              refs.current[id] = node;
            }}
            type="button"
            role="tab"
            id={`connections-tab-${id}`}
            aria-selected={isActive}
            aria-controls={`connections-panel-${id}`}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            onClick={() => onChange(id)}
            onKeyDown={onKeyDown}
          >
            {t(`connections.tab_${id}`)}
            {counts[id] !== null && <span className={styles.tabCount}>{counts[id]}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** "101–200 of 734" with previous and next; hidden for a single page. */
function Pager({
  page,
}: {
  page: Page<unknown> & { frozen: boolean; go: (next: number) => void };
}) {
  const { t } = useTranslation();
  return (
    <span className={styles.pager}>
      {page.frozen && <span className={styles.pagerFrozen}>{t('connections.pager_frozen')}</span>}
      <span className={styles.muted}>
        {t('connections.pager_range', { from: page.from, to: page.to, total: page.total })}
      </span>
      {page.pages > 1 && (
        <>
          <button
            type="button"
            className={styles.pagerButton}
            onClick={() => page.go(page.page - 1)}
            disabled={page.page === 0}
            aria-label={t('connections.pager_prev')}
            title={t('connections.pager_prev')}
          >
            ‹
          </button>
          <span className={styles.pagerPos}>
            {page.page + 1} / {page.pages}
          </span>
          <button
            type="button"
            className={styles.pagerButton}
            onClick={() => page.go(page.page + 1)}
            disabled={page.page >= page.pages - 1}
            aria-label={t('connections.pager_next')}
            title={t('connections.pager_next')}
          >
            ›
          </button>
        </>
      )}
    </span>
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

/** Connection number that filters the request list to that connection. */
function ConnLink({ id, onSelect }: { id: number; onSelect: (id: number) => void }) {
  const { t } = useTranslation();
  if (!id) return <span className={styles.muted}>–</span>;
  return (
    <button
      type="button"
      className={styles.connLink}
      onClick={() => onSelect(id)}
      title={t('connections.filter_conn_title')}
    >
      #{id}
    </button>
  );
}

function RequestTable({
  rows,
  onSelectConn,
}: {
  rows: RequestRow[];
  onSelectConn: (id: number) => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <div className={styles.muted}>{t('connections.requests_empty')}</div>;
  }
  return (
    <div className={`${styles.tableWrap} ${styles.scrollWrap}`}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('connections.col_time')}</th>
            <th>{t('connections.col_provider')}</th>
            <th>{t('connections.col_model')}</th>
            <th className={styles.num}>{t('connections.col_status')}</th>
            <th>{t('connections.col_stream')}</th>
            <th>{t('connections.col_connection')}</th>
            <th className={styles.num}>{t('connections.col_first_byte')}</th>
            <th className={styles.num}>{t('connections.col_duration')}</th>
            <th>{t('connections.col_end')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ req, durationMs, tone, failed }) => (
            <tr key={req.id}>
              <td className={styles.mono}>{formatClock(req.startedAt)}</td>
              <td>
                <div>{req.provider || t('connections.provider_other')}</div>
                {req.authId && <div className={styles.sub}>{shortAuthLabel(req.authId)}</div>}
              </td>
              <td className={styles.mono}>
                <div>{req.model || '–'}</div>
                <div className={styles.sub}>
                  {req.method} {req.path || req.host}
                </div>
              </td>
              <td className={`${styles.num} ${failed ? styles.failed : ''}`}>
                {req.status || '–'}
              </td>
              <td className={styles.mono}>
                {req.method === 'WS'
                  ? t('connections.stream_ws')
                  : req.stream
                    ? t('connections.stream_sse')
                    : '–'}
                {req.encoding && <div className={styles.sub}>{req.encoding}</div>}
              </td>
              <td>
                <ConnLink id={req.connId} onSelect={onSelectConn} />
                <div className={styles.sub}>
                  {req.reused
                    ? req.wasIdle && req.idleMs > 0
                      ? t('connections.conn_idle', { idle: formatDuration(req.idleMs) })
                      : t('connections.conn_reused')
                    : t('connections.conn_new')}
                </div>
              </td>
              <td className={styles.num}>
                {req.firstByteMs ? formatDuration(req.firstByteMs) : '–'}
              </td>
              <td className={styles.num}>{formatDuration(durationMs)}</td>
              <td>
                <span
                  className={`${styles.chip} ${styles[`tone_${tone}`]}`}
                  title={
                    req.error ||
                    t(`connections.end_hint.${req.end || 'in_flight'}`, { defaultValue: '' }) ||
                    undefined
                  }
                >
                  {t(`connections.end.${req.end || 'in_flight'}`, {
                    defaultValue: req.end || t('connections.end.in_flight'),
                  })}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConnTable({
  rows,
  now,
  kindLabel,
  reasonLabel,
  showReason,
  onSelectConn,
}: {
  rows: UpstreamConnection[];
  now: number;
  kindLabel: (kind: string) => string;
  reasonLabel: (reason: string) => string;
  showReason: boolean;
  onSelectConn: (id: number) => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <div className={styles.muted}>{t('connections.empty')}</div>;
  }
  return (
    <div className={`${styles.tableWrap} ${styles.scrollWrap}`}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th>{t('connections.col_provider')}</th>
            <th>{t('connections.col_kind')}</th>
            <th>{t('connections.col_target')}</th>
            <th>{t('connections.col_proxy')}</th>
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
                <td className={styles.mono}>
                  <ConnLink id={c.id} onSelect={onSelectConn} />
                </td>
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
                  {c.proxy ? (
                    <>
                      <div>{c.proxy}</div>
                      {c.proxyMs > 0 && (
                        <div className={styles.sub} title={t('connections.proxy_tunnel_hint')}>
                          {t('connections.proxy_tunnel', { value: formatDuration(c.proxyMs) })}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className={styles.sub}>{t('connections.proxy_direct')}</span>
                  )}
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
