function nonnegative(value, maximum = Infinity) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new RangeError('Expected a finite nonnegative number within range');
  }
  return value;
}

export function expectedSignalRate({ fluxPerCm2Second, crossSectionCm2, targetCount, efficiency }) {
  return nonnegative(fluxPerCm2Second) * nonnegative(crossSectionCm2)
    * nonnegative(targetCount) * nonnegative(efficiency, 1);
}

export function expectedNoiseRate({ noiseFluxPerCm2Second, areaCm2, rejectionEfficiency }) {
  return nonnegative(noiseFluxPerCm2Second) * nonnegative(areaCm2)
    * (1 - nonnegative(rejectionEfficiency, 1));
}

export function attenuatedNoiseFlux({ surfaceFluxPerCm2Second, depthMeters, attenuationLengthMeters }) {
  nonnegative(attenuationLengthMeters);
  if (attenuationLengthMeters === 0) throw new RangeError('Attenuation length must be positive');
  return nonnegative(surfaceFluxPerCm2Second)
    * Math.exp(-nonnegative(depthMeters) / attenuationLengthMeters);
}

export function expectedCounts({ durationDays, signalRatesPerSecond, noiseRatePerSecond }) {
  const seconds = nonnegative(nonnegative(durationDays) * 86400);
  return Object.fromEntries(['solar', 'atmospheric', 'astronomical', 'noise'].map(channel => {
    const rate = channel === 'noise' ? noiseRatePerSecond : signalRatesPerSecond[channel];
    return [channel, nonnegative(nonnegative(rate) * seconds)];
  }));
}

function validatePoisson(k, mean) {
  nonnegative(mean);
  if (!Number.isSafeInteger(k)) throw new RangeError('Count must be a safe integer');
}

export function poissonPmf(k, mean) {
  validatePoisson(k, mean);
  if (k < 0) return 0;
  if (mean === 0) return k === 0 ? 1 : 0;
  if (k >= 32) {
    // Stirling's correction avoids a factorial loop and cancellation near the mean.
    const inverse = 1 / k;
    const correction = inverse * (1 / 12 - inverse ** 2
      * (1 / 360 - inverse ** 2 * (1 / 1260 - inverse ** 2 / 1680)));
    const delta = (mean - k) / k;
    const exponent = Math.abs(delta) < 0.5
      ? k * (Math.log1p(delta) - delta)
      : k * Math.log(mean / k) + k - mean;
    return Math.exp(exponent - Math.log(2 * Math.PI * k) / 2 - correction);
  }
  let logFactorial = 0;
  for (let i = 2; i <= k; i++) logFactorial += Math.log(i);
  return Math.exp(k * Math.log(mean) - mean - logFactorial);
}

// Sum away from the mode, stopping when further terms cannot affect the result.
function poissonTail(k, mean, upper) {
  let i = upper ? k + 1 : k;
  const mass = poissonPmf(i, mean);
  if (mass === 0) return 0;
  let term = 1;
  let sum = 1;
  while (upper || i > 0) {
    term *= upper ? mean / ++i : i-- / mean;
    const next = sum + term;
    if (next === sum) break;
    sum = next;
  }
  return mass * sum;
}

export function poissonCdf(k, mean) {
  validatePoisson(k, mean);
  if (k < 0) return 0;
  if (mean === 0) return 1;
  return Math.min(1, k < mean ? poissonTail(k, mean, false) : 1 - poissonTail(k, mean, true));
}

export function samplePoisson(mean, rng = Math.random) {
  nonnegative(mean);
  if (mean === 0) return 0;
  const uniform = nonnegative(rng());
  if (uniform >= 1) throw new RangeError('Random value must be less than one');
  if (uniform === 0) return 0;
  // Compare upper tails directly: subtracting a tiny tail from one loses precision.
  const reached = k => k < mean
    ? poissonTail(k, mean, false) >= uniform
    : poissonTail(k, mean, true) <= 1 - uniform;
  let low = 0;
  let high = Math.ceil(mean);
  while (!reached(high)) {
    high += Math.ceil(Math.sqrt(mean));
    if (!Number.isSafeInteger(high)) throw new RangeError('Sample exceeds safe integer range');
  }
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (reached(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function simulateDetection(config, rng = Math.random) {
  return Object.fromEntries(Object.entries(expectedCounts(config))
    .map(([channel, mean]) => [channel, samplePoisson(mean, rng)]));
}
