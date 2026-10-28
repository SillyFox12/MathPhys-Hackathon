import { toSimulationConfig } from './detector_model.js';
import { expectedCounts, simulateDetection } from './simulation.js';

const sources = ['solar', 'atmospheric', 'astronomical'];
const benchmarkIds = ['ice_cube', 'super_k'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value === value.trim();

function check(valid, code, detectorId, field) {
  if (!valid) throw Object.assign(new Error(`${detectorId}: ${field}: ${code}`), { code, detectorId, field });
}

function number(value, code, id, field, maximum = Infinity) {
  check(Number.isFinite(value) && value >= 0 && value <= maximum, code, id, field);
  return value;
}

function finite(value, id, field) {
  check(Number.isFinite(value), 'NUMERIC_OVERFLOW', id, field);
  return value;
}

function benchmarkConfig(record, calibration, fluxes, durationDays) {
  const { id } = record;
  const valid = (condition, field) => check(condition, 'INVALID_CALIBRATION', id, `calibration.${field}`);
  const numeric = (value, field, max) => number(value, 'INVALID_CALIBRATION', id, `calibration.${field}`, max);
  const sourceResponse = calibration.model === 'source-effective-response-v1';
  check(sourceResponse || calibration.model === 'reference-times-relative-area-v1', 'UNSUPPORTED_MODEL', id, 'calibration.model');
  const physics = record.physics_specs;
  let acceptance = 1;
  let rejection;
  if (sourceResponse) {
    valid(object(calibration.effectiveResponseAreas), 'effectiveResponseAreas');
    rejection = numeric(calibration.rejectionEfficiency, 'rejectionEfficiency', 1);
  } else {
    const meaning = calibration.efficiencyMeaning;
    valid(['signalAcceptance', 'backgroundRejection'].includes(meaning), 'efficiencyMeaning');
    const companion = meaning === 'signalAcceptance' ? 'rejectionEfficiency' : 'signalEfficiency';
    const competing = meaning === 'signalAcceptance' ? 'signalEfficiency' : 'rejectionEfficiency';
    valid(!Object.hasOwn(calibration, competing), competing);
    const efficiency = numeric(calibration[companion], companion, 1);
    acceptance = meaning === 'signalAcceptance' ? physics.efficiency : efficiency;
    rejection = meaning === 'backgroundRejection' ? physics.efficiency : efficiency;
  }
  const area = (key, outputField) => {
    const quantity = key.split('.').reduce((owner, part) => owner?.[part], calibration);
    valid(object(quantity), key);
    const value = numeric(quantity.value, `${key}.value`);
    valid(['cm2', 'm2'].includes(quantity.unit), `${key}.unit`);
    return finite(value * (quantity.unit === 'm2' ? 10000 : 1), id, outputField);
  };
  const crossSection = sourceResponse ? null : finite(area('referenceEffectiveCrossSection', 'signalRatesPerSecond.solar')
    * physics.relative_cross_area, id, 'signalRatesPerSecond.solar');
  const backgroundArea = area('effectiveArea', 'noiseRatePerSecond');
  const scale = numeric(calibration.noiseScale, 'noiseScale');
  valid(scale > 0, 'noiseScale');
  const signalRatesPerSecond = Object.fromEntries(sources.map(source => {
    const field = `signalRatesPerSecond.${source}`;
    const response = sourceResponse ? area(`effectiveResponseAreas.${source}`, field) : crossSection;
    return [source, finite(finite(fluxes[source].fluxPerCm2Second * response, id, field) * acceptance, id, field)];
  }));
  const noiseField = 'noiseRatePerSecond';
  const noiseRatePerSecond = finite(finite(finite(physics.noise_flux_scaled / scale, id, noiseField)
    * backgroundArea, id, noiseField) * (1 - rejection), id, noiseField);
  return { durationDays, signalRatesPerSecond, noiseRatePerSecond };
}

function result(id, name, costUsd, config) {
  // Check individual exposure products before expectedCounts throws a generic error.
  const seconds = config.durationDays * 86400;
  for (const [channel, rate] of Object.entries({ ...config.signalRatesPerSecond, noise: config.noiseRatePerSecond })) {
    finite(rate * seconds, id, `expectedCounts.${channel}`);
  }
  const counts = expectedCounts(config);
  const totalExpectedSignal = finite(sources.reduce((sum, source) => sum + counts[source], 0), id, 'totalExpectedSignal');
  const totalExpectedObserved = finite(totalExpectedSignal + counts.noise, id, 'totalExpectedObserved');
  return { id, name, costUsd, ...config, expectedCounts: counts, totalExpectedSignal, totalExpectedObserved };
}

export function calculateExpectedResults(input) {
  check(object(input), 'INVALID_INPUT', 'comparison', 'input');
  const { build, benchmarks, calibration, durationDays } = input;
  number(durationDays, 'INVALID_DURATION', 'comparison', 'durationDays', 30);
  check(object(calibration), 'INVALID_CALIBRATION', 'comparison', 'calibration');
  for (const key of ['sources', 'benchmarks', 'player']) {
    check(object(calibration[key]), 'INVALID_CALIBRATION', key === 'player' ? 'player' : 'comparison', `calibration.${key}`);
  }
  for (const source of sources) {
    const path = `calibration.sources.${source}`;
    check(object(calibration.sources[source]), 'INVALID_CALIBRATION', 'comparison', path);
    number(calibration.sources[source].fluxPerCm2Second, 'INVALID_CALIBRATION', 'comparison', `${path}.fluxPerCm2Second`);
  }
  for (const id of ['player', ...benchmarkIds]) {
    const local = id === 'player' ? calibration.player : calibration.benchmarks[id];
    check(object(local), 'INVALID_CALIBRATION', id, `calibration.benchmarks.${id}`);
    check(!Object.hasOwn(local, 'sources'), 'INVALID_CALIBRATION', id, 'calibration.sources');
  }
  check(text(calibration.playerName), 'INVALID_CALIBRATION', 'player', 'calibration.playerName');
  check(Array.isArray(benchmarks), 'INVALID_BENCHMARKS', 'comparison', 'benchmarks');
  const records = new Map();
  for (const record of benchmarks) {
    check(object(record), 'INVALID_BENCHMARKS', 'comparison', 'benchmarks');
    check(text(record.id), 'INVALID_BENCHMARK', 'comparison', 'id');
    const { id } = record;
    check(benchmarkIds.includes(id), 'UNKNOWN_BENCHMARK', id, 'id');
    check(!records.has(id), 'DUPLICATE_BENCHMARK', id, 'id');
    check(text(record.name), 'INVALID_BENCHMARK', id, 'name');
    number(record.cost, 'INVALID_BENCHMARK', id, 'cost');
    check(object(record.physics_specs), 'INVALID_BENCHMARK', id, 'physics_specs');
    check(text(record.physics_specs.medium), 'INVALID_BENCHMARK', id, 'physics_specs.medium');
    for (const field of ['metric_tons', 'relative_cross_area', 'noise_flux_scaled', 'efficiency']) {
      number(record.physics_specs[field], 'INVALID_BENCHMARK', id, `physics_specs.${field}`, field === 'efficiency' ? 1 : Infinity);
    }
    records.set(id, record);
  }
  for (const id of benchmarkIds) check(records.has(id), 'MISSING_BENCHMARK', id, 'benchmarks');
  let playerConfig;
  try {
    playerConfig = toSimulationConfig(build, { ...calibration.player, sources: calibration.sources }, durationDays);
  } catch (error) {
    error.detectorId = 'player';
    throw error;
  }
  number(build.totalSpent, 'INVALID_BUILD', 'player', 'totalSpent');
  const detectors = [result('player', calibration.playerName, build.totalSpent, playerConfig)];
  for (const id of benchmarkIds) {
    const record = records.get(id);
    const config = benchmarkConfig(record, calibration.benchmarks[id], calibration.sources, durationDays);
    detectors.push(result(id, record.name, record.cost, config));
  }
  return { durationDays, detectors };
}

export function compareResults(input, rng = Math.random) {
  const results = calculateExpectedResults(input);
  check(results.durationDays === 30, 'INVALID_DURATION', 'comparison', 'durationDays');
  for (const detector of results.detectors) {
    const config = { durationDays: 30, signalRatesPerSecond: detector.signalRatesPerSecond,
      noiseRatePerSecond: detector.noiseRatePerSecond };
    const rates = { ...config.signalRatesPerSecond, noise: config.noiseRatePerSecond };
    for (const [channel, rate] of Object.entries(rates)) {
      check(rate * 30 * 86400 <= Number.MAX_SAFE_INTEGER, 'NUMERIC_OVERFLOW', detector.id, `simulatedCounts.${channel}`);
    }
    const counts = simulateDetection(config, rng);
    for (const [channel, count] of Object.entries(counts)) {
      check(Number.isSafeInteger(count) && count >= 0, 'NUMERIC_OVERFLOW', detector.id, `simulatedCounts.${channel}`);
    }
    detector.simulatedCounts = { noise: counts.noise, solar: counts.solar,
      atmospheric: counts.atmospheric, astronomical: counts.astronomical };
  }
  return results;
}
