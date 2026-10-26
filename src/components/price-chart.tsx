'use client';

import { createChart, ColorType, type IChartApi, type CandlestickData, type Time } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { formatPrice } from '@/lib/format';

/** Plain strings only — this is a Client Component. */
export interface ChartLabels {
  readoutLabel: string;
  open: string;
  high: string;
  low: string;
  close: string;
  change: string;
  rising: string;
  falling: string;
  unchanged: string;
  hollowLegend: string;
  tableToggle: string;
  tableCaption: string;
  tableDirection: string;
  tableTime: string;
  tableRowsNote: string;
  tableInProgress: string;
  noCandles: string;
}

const UP = '#13a383';
const DOWN = '#e5484d';

/** Rows rendered in the text fallback. The whole series would be unreadable. */
const FALLBACK_ROWS = 30;

/**
 * lightweight-charts wants seconds; our candles carry epoch milliseconds.
 *
 * The series data and the crosshair lookup map MUST derive their key from the
 * same expression. They used to differ by a `Math.floor`, which matched for
 * whole-second opens and would have silently stopped matching for any feed
 * that reports sub-second precision — the readout would just never populate.
 */
function timeKey(msSinceEpoch: number): number {
  return Math.floor(msSinceEpoch / 1000);
}

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  isPartial: boolean;
}

/**
 * Candlestick chart.
 *
 * The in-progress bar is kept in the series (traders expect to see it) but is
 * reported in the caption, because strategies deliberately exclude it.
 */
export interface ChartOverlay {
  label: string;
  color: string;
  /** Values aligned to `candles`; null where the indicator has no value yet. */
  values: (number | null)[];
}

/**
 * Axis tick formatter.
 *
 * An IDR price axis runs into the billions, where the default
 * `1800000000.00` is unreadable. Large values are compacted (1.8B / 43.1M /
 * 5.175K) and small ones keep the precision a sub-rupiah token needs.
 */
function formatAxisPrice(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(4);
}

export { timeKey };

export function PriceChart({
  candles,
  levels,
  overlays,
  labels,
}: {
  candles: ChartCandle[];
  levels?: { price: number; label: string; color: string }[];
  /** Moving averages drawn over the candles. */
  overlays?: ChartOverlay[];
  labels: ChartLabels;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Values under the crosshair, mirrored as text beside the canvas.
  const [readout, setReadout] = useState<ChartCandle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length === 0) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b97a8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e2633' },
        horzLines: { color: '#1e2633' },
      },
      rightPriceScale: { borderColor: '#2c3747' },
      timeScale: { borderColor: '#2c3747', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      height: 380,
      autoSize: true,
      localization: { priceFormatter: formatAxisPrice },
    });
    chartRef.current = chart;

    const series = chart.addCandlestickSeries({
      /*
       * Hollow up, filled down.
       *
       * The validated up/down pair still carries the colour, but direction must
       * not DEPEND on it: a viewer with deuteranopia, or anyone on a bad
       * monitor, reads body fill instead. This is the standard hollow-candle
       * convention, so it costs a trader nothing to learn, and it means the
       * chart survives being printed in greyscale.
       *
       * The crosshair readout and the fallback table below carry the same
       * information as text.
       */
      upColor: 'rgba(0,0,0,0)',
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });

    const data: CandlestickData<Time>[] = candles.map((c) => ({
      time: timeKey(c.time) as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    series.setData(data);

    for (const level of levels ?? []) {
      if (!Number.isFinite(level.price)) continue;
      series.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: level.label,
      });
    }

    // Moving-average overlays. Gaps stay gaps: a null warm-up value is simply
    // not plotted rather than being joined across the hole.
    for (const overlay of overlays ?? []) {
      const line = chart.addLineSeries({
        color: overlay.color,
        // 2px per the mark spec: 1px hairlines are for grid and axes only.
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: overlay.label,
      });
      line.setData(
        candles
          .map((c, i) => ({ time: timeKey(c.time) as Time, value: overlay.values[i] }))
          .filter((p): p is { time: Time; value: number } => p.value !== null && p.value !== undefined),
      );
    }

    const hasVolume = candles.some((c) => c.volume !== null);
    if (hasVolume) {
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      });
      // Volume is contextual: give it the bottom ~18% and no axis labels of its
      // own, so it never competes with the price scale for attention.
      volumeSeries.applyOptions({ lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volumeSeries.setData(
        candles
          .filter((c) => c.volume !== null)
          .map((c) => ({
            time: timeKey(c.time) as Time,
            value: c.volume as number,
                // Volume is contextual, so it stays a recessive wash rather than a
            // second loud series competing with the candles.
            color: c.close >= c.open ? 'rgba(19,163,131,0.28)' : 'rgba(229,72,77,0.28)',
          })),
      );
    }

    /*
     * Mirror the hovered bar as text. A tooltip that only exists inside a
     * <canvas> is invisible to assistive tech and to anyone not using a mouse;
     * this readout is real DOM, and it is a live region so it is announced.
     */
    const byTime = new Map(candles.map((c) => [timeKey(c.time), c]));
    chart.subscribeCrosshairMove((param) => {
      const t = param.time as number | undefined;
      setReadout(t === undefined ? null : (byTime.get(t) ?? null));
    });

    /*
     * Drop the readout whenever the visible time range moves.
     *
     * Found while verifying the Next 16 upgrade in a real browser: the canvas
     * crosshair said "26 Feb '26" while the readout showed the 2 March bar.
     * The pointer event had fired before `fitContent` / auto-resize finished
     * laying out the time scale; the chart then re-drew its crosshair at the
     * same pixel with the NEW date, but fires no crosshair event for a layout
     * change, so the text kept the OLD bar. A price that does not match its
     * own date label must not be shown on a trading screen, even briefly — so
     * any range change (resize, scroll, zoom, fitContent) clears it until the
     * next real pointer move re-populates it.
     */
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => setReadout(null));

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, levels, overlays]);

  if (candles.length === 0) {
    return (
      <div className="flex h-[380px] items-center justify-center rounded border border-dashed border-line-strong">
        <p className="text-2xs text-ink-faint">{labels.noCandles}</p>
      </div>
    );
  }

  return (
    <div>
      {/*
        A legend is mandatory once two or more series share a plot: identity must
        never depend on matching colours by eye. The swatch carries the colour and
        the text stays in a text token.
      */}
      {overlays && overlays.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {overlays.map((o) => (
            <span key={o.label} className="inline-flex items-center gap-1.5 text-2xs text-ink-muted">
              <span aria-hidden className="inline-block h-0.5 w-4 rounded-sm" style={{ backgroundColor: o.color }} />
              {o.label}
            </span>
          ))}
        </div>
      )}
      <div ref={containerRef} className="h-[380px] w-full" />

      {/*
        Crosshair readout. `aria-live="polite"` rather than "assertive": it
        updates on every pointer move, and an assertive region would interrupt
        the screen reader continuously.
      */}
      <div
        aria-live="polite"
        aria-label={labels.readoutLabel}
        className="mt-2 flex min-h-[1.75rem] flex-wrap items-center gap-x-4 gap-y-1 rounded border border-line bg-bg-inset px-2.5 py-1.5 text-2xs"
      >
        {readout ? (
          <>
            <Figure label={labels.open} value={readout.open} />
            <Figure label={labels.high} value={readout.high} />
            <Figure label={labels.low} value={readout.low} />
            <Figure label={labels.close} value={readout.close} />
            <span className={direction(readout) === 'up' ? 'text-up' : direction(readout) === 'down' ? 'text-down' : 'text-flat'}>
              {direction(readout) === 'up' ? '▲ ' : direction(readout) === 'down' ? '▼ ' : '◆ '}
              {directionLabel(readout, labels)}
            </span>
          </>
        ) : (
          <span className="text-ink-faint">{labels.readoutLabel}</span>
        )}
      </div>

      <p className="mt-1.5 text-2xs text-ink-faint">{labels.hollowLegend}</p>

      {/*
        Text fallback. The chart DB marks candlestick as a conditional
        accessibility risk and requires an OHLC table alongside it: a canvas
        cannot be read by a screen reader, zoomed by a low-vision user, or
        copied. Collapsed by default so it costs a sighted user nothing.
      */}
      <details className="mt-2 rounded border border-line bg-bg-inset">
        <summary className="cursor-pointer px-2.5 py-2 text-2xs text-ink-muted transition-colors hover:text-ink">
          {labels.tableToggle}
        </summary>
        <div className="max-h-72 overflow-auto px-2.5 pb-2.5" tabIndex={0} role="region" aria-label={labels.tableCaption}>
          <p className="py-1 text-2xs text-ink-faint">
            {labels.tableRowsNote} {Math.min(FALLBACK_ROWS, candles.length)}
          </p>
          <table className="w-full border-collapse text-2xs">
            <caption className="sr-only">{labels.tableCaption}</caption>
            <thead>
              <tr className="text-left text-ink-faint">
                <th scope="col" className="py-1 pr-3 font-medium">{labels.tableTime}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{labels.open}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{labels.high}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{labels.low}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{labels.close}</th>
                <th scope="col" className="py-1 font-medium">{labels.tableDirection}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {[...candles]
                .slice(-FALLBACK_ROWS)
                .reverse()
                .map((c) => (
                  <tr key={c.time}>
                    <td className="num whitespace-nowrap py-1 pr-3 text-ink-faint">
                      {new Date(c.time).toISOString().slice(0, 16).replace('T', ' ')}
                      {/*
                        The forming bar is plotted (traders expect it) and every
                        strategy ignores it, because its values are not final.
                        The table must say which row that is.
                      */}
                      {c.isPartial && <span className="ml-1.5 text-warn">({labels.tableInProgress})</span>}
                    </td>
                    <td className="num py-1 pr-3 text-ink-muted">{formatPrice(c.open)}</td>
                    <td className="num py-1 pr-3 text-ink-muted">{formatPrice(c.high)}</td>
                    <td className="num py-1 pr-3 text-ink-muted">{formatPrice(c.low)}</td>
                    <td className="num py-1 pr-3 text-ink">{formatPrice(c.close)}</td>
                    <td
                      className={`whitespace-nowrap py-1 ${
                        direction(c) === 'up' ? 'text-up' : direction(c) === 'down' ? 'text-down' : 'text-flat'
                      }`}
                    >
                      {direction(c) === 'up' ? '▲ ' : direction(c) === 'down' ? '▼ ' : '◆ '}
                      {directionLabel(c, labels)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export function direction(c: ChartCandle): 'up' | 'down' | 'flat' {
  if (c.close > c.open) return 'up';
  if (c.close < c.open) return 'down';
  return 'flat';
}

function directionLabel(c: ChartCandle, labels: ChartLabels): string {
  const d = direction(c);
  return d === 'up' ? labels.rising : d === 'down' ? labels.falling : labels.unchanged;
}

/**
 * One exact OHLC value in the readout.
 *
 * Uses `formatPrice`, NOT the axis formatter. The axis compacts to "1.46B" so
 * labels fit; reused here it made every value of an IDR intraday bar read
 * "1.46B" — Open, High, Low and Close identical — while the real bar
 * (BTCIDR 1m, 26 Oct 15:42) ran from 1,459,704,000 down to 1,458,403,000, a
 * 1.3 million IDR move. A readout that exists to give exact numbers cannot
 * round them away.
 */
function Figure({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-ink-faint">
      {label} <span className="num text-ink">{formatPrice(value)}</span>
    </span>
  );
}
