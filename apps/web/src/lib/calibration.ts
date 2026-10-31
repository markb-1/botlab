/** Calibration of scored forecasts: predicted probability vs observed frequency, in 10 buckets */

export interface CalibrationBucket {
  from: number;
  to: number;
  n: number;
  meanForecast: number | null;
  observed: number | null;
}

export interface CalibrationSummary {
  buckets: CalibrationBucket[];
  n: number;
  brierAgent: number | null;
  brierMarket: number | null;
  meanSkill: number | null;
}

interface Scored {
  probability: number;
  outcome: number | null;
  brierAgent: number | null;
  brierMarket: number | null;
  skill: number | null;
  status: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function calibration(forecasts: readonly Scored[], bins = 10): CalibrationSummary {
  const scored = forecasts.filter((f) => f.outcome !== null && f.status !== 'void' && Number.isFinite(f.probability));
  const buckets: CalibrationBucket[] = Array.from({ length: bins }, (_, i) => ({
    from: i / bins,
    to: (i + 1) / bins,
    n: 0,
    meanForecast: null,
    observed: null,
  }));
  const groups: Array<{ p: number[]; o: number[] }> = buckets.map(() => ({ p: [], o: [] }));
  for (const f of scored) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(f.probability * bins)));
    groups[idx].p.push(f.probability);
    groups[idx].o.push(f.outcome as number);
  }
  groups.forEach((g, i) => {
    buckets[i].n = g.p.length;
    buckets[i].meanForecast = mean(g.p);
    buckets[i].observed = mean(g.o);
  });
  const num = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return {
    buckets,
    n: scored.length,
    brierAgent: mean(num(scored.map((f) => f.brierAgent))),
    brierMarket: mean(num(scored.map((f) => f.brierMarket))),
    meanSkill: mean(num(scored.map((f) => f.skill))),
  };
}
