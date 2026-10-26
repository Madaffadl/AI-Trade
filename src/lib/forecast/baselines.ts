import { sma, stdDev } from '@/lib/indicators';
import type { Candle } from '@/lib/market/types';
import { forecastAccuracy, type ForecastAccuracy } from '@/lib/evaluation/metrics';

/**
 * Price forecasting - EXPERIMENTAL, and deliberately limited to baselines.
 *
 * The honest position: for liquid markets at these horizons, the naive forecast
 * ("tomorrow's price is today's price") is a genuinely hard benchmark to beat.
 * Nothing here is allowed to influence a trading signal. These models exist so
 * that any future model must first prove it beats a naive baseline on
 * out-of-sample data.
 *
 * Every model is evaluated with an expanding chronological window: a prediction
 * for bar t may use ONLY bars strictly before t. Observations are never
 * shuffled.
 */

export type ForecastModelId = 'naive' | 'drift' | 'sma_trend';

export interface ForecastModel {
  id: ForecastModelId;
  label: string;
  description: string;
  minHistory: number;
  /** Predict the close of the NEXT bar from the supplied history. */
  predict(history: readonly number[]): number | null;
}

export const NAIVE: ForecastModel = {
  id: 'naive',
  label: 'Naive (last close)',
  description:
    'Predicts the next close equals the last observed close. This is the benchmark every other model must beat.',
  minHistory: 1,
  predict: (h) => h.at(-1) ?? null,
};

export const DRIFT: ForecastModel = {
  id: 'drift',
  label: 'Random walk with drift',
  description:
    'Extends the average per-bar change observed over the whole history by one bar. Equivalent to a straight line through the first and last observation.',
  minHistory: 20,
  predict: (h) => {
    if (h.length < 2) return null;
    const first = h[0]!;
    const lastValue = h.at(-1)!;
    const drift = (lastValue - first) / (h.length - 1);
    return lastValue + drift;
  },
};

export const SMA_TREND: ForecastModel = {
  id: 'sma_trend',
  label: 'Short-term SMA slope',
  description:
    'Extends the slope of a 10-period simple moving average by one bar. A simple local-trend model.',
  minHistory: 25,
  predict: (h) => {
    const series = sma(h, 10);
    const now = series.at(-1);
    const prev = series.at(-2);
    if (now === null || now === undefined || prev === null || prev === undefined) return null;
    return (h.at(-1) ?? now) + (now - prev);
  },
};

export const FORECAST_MODELS: ForecastModel[] = [NAIVE, DRIFT, SMA_TREND];

export interface ForecastEvaluation {
  modelId: ForecastModelId;
  label: string;
  accuracy: ForecastAccuracy;
  /** RMSE relative to the naive baseline. < 1 means it beat the baseline. */
  rmseVsNaive: number | null;
  beatsNaive: boolean | null;
  verdict: string;
}

/**
 * Walk-forward evaluation over closed bars.
 * For each target bar t in the test window, the model sees closes[0..t-1] only.
 */
export function evaluateForecastModels(bars: readonly Candle[], testWindow = 60): ForecastEvaluation[] {
  const closes = bars.filter((b) => !b.isPartial).map((b) => b.close);
  const results: { model: ForecastModel; acc: ForecastAccuracy }[] = [];

  const start = Math.max(
    ...FORECAST_MODELS.map((m) => m.minHistory),
    closes.length - testWindow,
  );

  for (const model of FORECAST_MODELS) {
    const predictions: { predicted: number; actual: number; previous: number }[] = [];
    for (let t = start; t < closes.length; t++) {
      // Strictly past data only.
      const history = closes.slice(0, t);
      if (history.length < model.minHistory) continue;
      const predicted = model.predict(history);
      if (predicted === null || !Number.isFinite(predicted)) continue;
      predictions.push({ predicted, actual: closes[t]!, previous: history.at(-1)! });
    }
    results.push({ model, acc: forecastAccuracy(predictions) });
  }

  const naiveRmse = results.find((r) => r.model.id === 'naive')?.acc.rmse ?? null;

  return results.map(({ model, acc }) => {
    const rmseVsNaive = naiveRmse && acc.rmse !== null && naiveRmse > 0 ? acc.rmse / naiveRmse : null;
    const beatsNaive = rmseVsNaive === null ? null : rmseVsNaive < 1;
    return {
      modelId: model.id,
      label: model.label,
      accuracy: acc,
      rmseVsNaive,
      beatsNaive,
      verdict:
        acc.observations === 0
          ? 'Not enough history to evaluate this model.'
          : model.id === 'naive'
            ? 'Baseline. Other models are judged against this.'
            : beatsNaive
              ? `Lower RMSE than the naive baseline on ${acc.observations} out-of-sample observations. This is a weak signal, not evidence of predictive skill.`
              : `Did NOT beat the naive baseline (RMSE ratio ${rmseVsNaive?.toFixed(3) ?? 'n/a'}). It must not be used to influence signals.`,
    };
  });
}

export interface ForecastPoint {
  model: ForecastModelId;
  label: string;
  predictedClose: number | null;
  /** +/- one standard deviation of recent returns, as a crude uncertainty band. */
  lowerBand: number | null;
  upperBand: number | null;
  note: string;
}

/** Next-bar forecast with a crude volatility band. Display only. */
export function forecastNextBar(bars: readonly Candle[]): ForecastPoint[] {
  const closes = bars.filter((b) => !b.isPartial).map((b) => b.close);
  const sd = stdDev(closes, 20).at(-1) ?? null;

  return FORECAST_MODELS.map((m) => {
    const predicted = closes.length >= m.minHistory ? m.predict(closes) : null;
    return {
      model: m.id,
      label: m.label,
      predictedClose: predicted,
      lowerBand: predicted !== null && sd !== null ? predicted - sd : null,
      upperBand: predicted !== null && sd !== null ? predicted + sd : null,
      note:
        predicted === null
          ? `Needs at least ${m.minHistory} closed bars.`
          : 'Band is +/- one standard deviation of the last 20 closes. It is NOT a calibrated prediction interval.',
    };
  });
}
