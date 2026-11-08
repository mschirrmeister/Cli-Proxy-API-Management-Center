/**
 * Time to first byte per provider and model, new versus reused connection.
 * Each lane shows a gray line from the fastest to the slowest request and a
 * dot at the median: amber for requests that opened their connection, blue for
 * requests on a reused one. Lanes are labelled as well, so the split never
 * depends on color alone. Single requests are listed in the request table.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  OTHER_PROVIDER,
  TTFB_MIN_SAMPLES,
  formatDelta,
  formatDuration,
  laneStats,
  tickStep,
  type TtfbChart as TtfbChartData,
  type TtfbLaneStats,
} from './model';
import styles from './ConnectionsPage.module.scss';

const LABEL_W = 190;
const LANE_LABEL_W = 58;
const VALUE_W = 104;
const LANE_H = 22;
const ROW_GAP = 18;
const AXIS_H = 24;
const DOT_R = 5.5;
const MIN_PLOT_W = 160;

type Lane = 'fresh' | 'reused';

/** Shortens a label to max characters; the full text stays in its <title>. */
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

interface Hover {
  lane: Lane;
  stats: TtfbLaneStats;
  x: number;
  y: number;
}

export function TtfbChart({ chart }: { chart: TtfbChartData }) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return undefined;
    const measure = () =>
      setWidth(Math.max(LABEL_W + LANE_LABEL_W + VALUE_W + MIN_PLOT_W, node.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const plotX0 = LABEL_W + LANE_LABEL_W;
  const plotW = width - plotX0 - VALUE_W;
  const rowH = LANE_H * 2 + ROW_GAP;
  const height = chart.rows.length * rowH + AXIS_H;
  const x = (ms: number) => plotX0 + (Math.min(ms, chart.axisMaxMs) / chart.axisMaxMs) * plotW;

  const ticks = useMemo(() => {
    const step = tickStep(chart.axisMaxMs);
    const out: number[] = [];
    for (let v = 0; v <= chart.axisMaxMs + step / 1000; v += step) out.push(v);
    return out;
  }, [chart.axisMaxMs]);

  const providerName = (provider: string) =>
    provider === OTHER_PROVIDER ? t('connections.provider_other') : provider;
  const laneLabel = (lane: Lane) =>
    lane === 'fresh' ? t('connections.ttfb.lane_new') : t('connections.ttfb.lane_reused');

  // The wrapper is always rendered, also while the chart is empty, so the
  // size observer attached on mount keeps measuring once rows appear.
  return (
    <div ref={wrapRef} className={styles.ttfbWrap} onMouseLeave={() => setHover(null)}>
      {chart.rows.length === 0 ? (
        <div className={styles.muted}>{t('connections.ttfb.empty')}</div>
      ) : (
        <svg
          className={styles.ttfbSvg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('connections.ttfb.aria')}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className={styles.ttfbGrid} x1={x(v)} x2={x(v)} y1={0} y2={height - AXIS_H} />
              <text className={styles.ttfbAxis} x={x(v)} y={height - 6} textAnchor="middle">
                {v === 0 ? '0' : formatDuration(v)}
              </text>
            </g>
          ))}
          {chart.rows.map((row, i) => {
            const y0 = i * rowH + ROW_GAP / 2;
            return (
              <g key={row.key}>
                <text className={styles.ttfbProvider} x={0} y={y0 + 12}>
                  <title>{providerName(row.provider)}</title>
                  {clip(providerName(row.provider), 24)}
                </text>
                <text className={styles.ttfbModel} x={0} y={y0 + 27}>
                  <title>{row.model}</title>
                  {clip(row.model, 26)}
                </text>
                <text className={styles.ttfbDelta} x={0} y={y0 + 41}>
                  {row.deltaMs !== null
                    ? t('connections.ttfb.delta', { delta: formatDelta(row.deltaMs) })
                    : t('connections.ttfb.too_few', { min: TTFB_MIN_SAMPLES })}
                </text>
                {(['fresh', 'reused'] as const).map((lane, li) => {
                  const stats = laneStats(lane === 'fresh' ? row.fresh : row.reused);
                  const y = y0 + li * LANE_H + LANE_H / 2;
                  const markerClass = lane === 'fresh' ? styles.ttfbNew : styles.ttfbReused;
                  return (
                    <g key={lane}>
                      <text className={styles.ttfbLane} x={plotX0 - 10} y={y + 4} textAnchor="end">
                        {laneLabel(lane)}
                      </text>
                      {stats === null ? (
                        <text className={styles.ttfbNone} x={plotX0 + 4} y={y + 4}>
                          {t('connections.ttfb.none')}
                        </text>
                      ) : (
                        <>
                          <line
                            className={styles.ttfbRange}
                            x1={x(stats.min)}
                            x2={x(stats.max)}
                            y1={y}
                            y2={y}
                          />
                          {stats.max > chart.axisMaxMs && (
                            <path
                              className={styles.ttfbPin}
                              d={`M${x(chart.axisMaxMs) - 4} ${y - 5} L${x(chart.axisMaxMs) + 3} ${y} L${x(chart.axisMaxMs) - 4} ${y + 5} Z`}
                            />
                          )}
                          <circle className={markerClass} cx={x(stats.median)} cy={y} r={DOT_R} />
                          <rect
                            className={styles.ttfbHit}
                            x={plotX0}
                            y={y - LANE_H / 2}
                            width={plotW}
                            height={LANE_H}
                            onMouseEnter={() => setHover({ lane, stats, x: x(stats.median), y })}
                          />
                          <text className={styles.ttfbValue} x={width - VALUE_W + 10} y={y + 4}>
                            {formatDuration(stats.median)}
                            <tspan className={styles.ttfbCount}> n={stats.n}</tspan>
                          </text>
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      {hover && chart.rows.length > 0 && (
        <div
          className={styles.ttfbTip}
          style={{ left: Math.min(hover.x + 12, width - 240), top: hover.y + 12 }}
        >
          <div>
            <strong>{laneLabel(hover.lane)}</strong> ·{' '}
            {t('connections.ttfb.tip_count', { count: hover.stats.n })}
          </div>
          <div>
            {t('connections.ttfb.tip_median', { value: formatDuration(hover.stats.median) })}
          </div>
          <div>
            {t('connections.ttfb.tip_range', {
              min: formatDuration(hover.stats.min),
              max: formatDuration(hover.stats.max),
            })}
          </div>
          {hover.stats.setupMedian !== null && (
            <div>
              {t('connections.ttfb.tip_setup', { value: formatDuration(hover.stats.setupMedian) })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
