const roles = ['medium', 'location', 'sensors', 'shielding'];
const sources = ['solar', 'atmospheric', 'astronomical'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const roundNumber = value => Number.isSafeInteger(value) && value > 0;

function requireValue(valid, code, field, context = {}) {
  if (!valid) throw Object.assign(new Error(`${code}: ${field}`), { code, field, ...context });
}

function number(value, code, field, context = {}, maximum = Infinity) {
  requireValue(Number.isFinite(value) && value >= 0 && value <= maximum, code, field, context);
  return value;
}

function finite(value, field) {
  requireValue(Number.isFinite(value), 'NUMERIC_OVERFLOW', field);
  return value;
}

export function toSimulationConfig(build, calibration, durationDays) {
  number(durationDays, 'INVALID_DURATION', 'durationDays', {}, 30);
  requireValue(object(build), 'INVALID_BUILD', 'build');
  requireValue(Array.isArray(build.choices), 'INVALID_BUILD', 'build.choices');
  const validCalibration = (valid, path) => requireValue(valid, 'INVALID_CALIBRATION', `calibration.${path}`);
  requireValue(object(calibration), 'INVALID_CALIBRATION', 'calibration');
  const sourceResponse = calibration.model === 'source-reference-response-v1';
  for (const [key, expected] of [['model', sourceResponse ? 'source-reference-response-v1' : 'flux-cross-section-efficiency-v2'], ['noiseModel', 'site-flux']]) {
    requireValue(calibration[key] === expected, 'UNSUPPORTED_MODEL', `calibration.${key}`);
  }
  for (const key of ['sources', sourceResponse ? 'referenceResponseAreas' : 'referenceEffectiveCrossSection', 'effectiveArea', 'optionMap']) {
    validCalibration(object(calibration[key]), key);
  }
  const area = key => {
    const quantity = key.split('.').reduce((owner, part) => owner?.[part], calibration);
    validCalibration(object(quantity), key);
    const { value, unit } = quantity;
    number(value, 'INVALID_CALIBRATION', `calibration.${key}.value`);
    validCalibration(unit === 'cm2' || unit === 'm2', `${key}.unit`);
    return value * (unit === 'm2' ? 10000 : 1);
  };
  const referenceAreas = sourceResponse
    ? Object.fromEntries(sources.map(source => [source, area(`referenceResponseAreas.${source}`)]))
    : Object.fromEntries(sources.map(source => [source, area('referenceEffectiveCrossSection')]));
  const backgroundArea = area('effectiveArea');
  const scale = number(calibration.noiseScale, 'INVALID_CALIBRATION', 'calibration.noiseScale');
  validCalibration(scale > 0, 'noiseScale');
  const fluxes = Object.fromEntries(sources.map(source => {
    validCalibration(object(calibration.sources[source]), `sources.${source}`);
    return [source, number(calibration.sources[source].fluxPerCm2Second,
      'INVALID_CALIBRATION', `calibration.sources.${source}.fluxPerCm2Second`)];
  }));
  for (const [id, mapping] of Object.entries(calibration.optionMap)) {
    validCalibration(identifier(id), 'optionMap');
    validCalibration(object(mapping), `optionMap.${id}`);
    validCalibration(roles.includes(mapping.role), `optionMap.${id}.role`);
    validCalibration(roundNumber(mapping.round), `optionMap.${id}.round`);
  }

  const selected = new Map();
  const ids = new Set();
  for (const choice of build.choices) {
    requireValue(object(choice), 'INVALID_BUILD', 'build.choices');
    requireValue(identifier(choice.id), 'INVALID_BUILD', 'id');
    const optionId = choice.id;
    requireValue(roundNumber(choice.round), 'INVALID_BUILD', 'round', { optionId });
    requireValue(Object.hasOwn(calibration.optionMap, optionId), 'UNKNOWN_OPTION', 'id', { optionId });
    const { role, round } = calibration.optionMap[optionId];
    const context = { optionId, role };
    requireValue(!ids.has(optionId), 'DUPLICATE_OPTION', 'id', context);
    requireValue(choice.round === round, 'ROUND_CONFLICT', 'round', context);
    requireValue(!selected.has(role), 'DUPLICATE_ROLE', 'build.choices', context);
    ids.add(optionId);
    selected.set(role, choice);
  }
  for (const role of roles) {
    requireValue(selected.has(role), 'MISSING_ROLE', 'build.choices', { role });
    const choice = selected.get(role);
    requireValue(object(choice.physics_specs), 'INVALID_PHYSICS', 'physics_specs', { optionId: choice.id, role });
  }
  const physics = (role, field) => {
    const choice = selected.get(role);
    return number(choice.physics_specs[field], 'INVALID_PHYSICS', `physics_specs.${field}`,
      { optionId: choice.id, role }, field === 'efficiency' ? 1 : Infinity);
  };
  const medium = physics('medium', 'relative_cross_section');
  const sensors = physics('sensors', 'relative_cross_section');
  const acceptance = physics('sensors', 'efficiency');
  const site = physics('location', 'noise_flux_scaled');
  const rejection = physics('shielding', 'efficiency');
  const signalRatesPerSecond = Object.fromEntries(sources.map(source => {
    const field = `signalRatesPerSecond.${source}`;
    const crossSection = finite(finite(finite(referenceAreas[source], field) * medium, field) * sensors, field);
    return [source, finite(finite(fluxes[source] * crossSection, field) * acceptance, field)];
  }));
  const noiseField = 'noiseRatePerSecond';
  const noiseRatePerSecond = finite(finite(finite(site / scale, noiseField)
    * finite(backgroundArea, noiseField), noiseField) * (1 - rejection), noiseField);
  return { durationDays, signalRatesPerSecond, noiseRatePerSecond };
}
