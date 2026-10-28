const CHOICES = 'Narrative & Choice Matrix';
const BENCHMARKS = 'Real-World Benchmarks';
const blank = value => value == null || (typeof value === 'string' && value.trim() === '');
const missing = value => blank(value) || (typeof value === 'string' && value.trim() === 'N/A');
const emptyRow = row => row.every(blank);

function failure(stage, details) {
  return Object.assign(new Error([stage, ...Object.values(details)].join(': ')), { stage, ...details });
}

function parseTable(table, tab) {
  const benchmark = tab === BENCHMARKS;
  // Each column specifies its destination, value type, and whether it is required.
  const fields = {
    [benchmark ? 'detector_id' : 'option_id']: ['id', 'trim', true],
    [benchmark ? 'detector_name' : 'option_name']: ['name', 'trim', true],
    cost_usd: ['cost', 'number', true],
    medium: ['medium', 'trim', benchmark],
    noise_flux_scaled: ['noise_flux_scaled', 'number', benchmark],
    efficiency: ['efficiency', 'number', benchmark],
  };
  if (benchmark) {
    for (const field of ['metric_tons', 'relative_cross_area']) fields[field] = [field, 'number', true];
  } else {
    fields.round = ['round', 'number', true];
    fields.relative_cross_section = ['relative_cross_section', 'number', false];
    for (const field of ['history_start_year', 'history_end_year']) fields[field] = [field, 'number', false];
    for (const field of ['description', 'history_headline', 'history_context']) fields[field] = [field, 'text', false];
  }
  const columns = new Map();
  table[0].forEach((header, index) => {
    const actual = typeof header === 'string' ? header.trim() : '';
    const field = actual === 'd' && !benchmark ? 'round' : actual;
    if (!Object.hasOwn(fields, field)) return;
    if (columns.has(field)) throw failure('parse', { tab, row: 1, field });
    columns.set(field, { index, actual });
  });
  for (const [field, [, , required]] of Object.entries(fields)) {
    if (required && !columns.has(field)) throw failure('parse', { tab, row: 1, field });
  }
  const ids = new Set();
  return table.slice(1).flatMap((cells, index) => {
    if (emptyRow(cells)) return [];
    const record = { physics_specs: {} };
    for (const [field, [destination, type, required]] of Object.entries(fields)) {
      const column = columns.get(field);
      let value = cells[column?.index];
      const invalid = () => { throw failure('parse', { tab, row: index + 2, field: column?.actual ?? field }); };
      if (missing(value)) {
        if (required) invalid();
        continue;
      }
      if (type === 'number') {
        if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
          value = Number(value);
        }
        if (!Number.isFinite(value)) invalid();
        if (field === 'cost_usd' && value < 0) invalid();
        if (field === 'efficiency' && (value < 0 || value > 1)) invalid();
        if (field === 'round' && (!Number.isSafeInteger(value) || value <= 0)) invalid();
      } else {
        if (typeof value !== 'string') invalid();
        if (type === 'trim') value = value.trim();
      }
      const physics = ['medium', 'metric_tons', 'relative_cross_area', 'relative_cross_section', 'noise_flux_scaled', 'efficiency'];
      (physics.includes(destination) ? record.physics_specs : record)[destination] = value;
    }
    if (ids.has(record.id)) throw failure('parse', { tab, row: index + 2, field: benchmark ? 'detector_id' : 'option_id' });
    ids.add(record.id);
    return [record];
  });
}

export default class GameData {
  #active = { choices: [], benchmarks: [] };

  constructor({ source }) {
    this.source = source;
    this.imported = null;
    this.parsed = null;
    this.catalog = {
      getChoices: round => this.#active.choices.filter(choice => round === undefined || choice.round === round),
      getChoice: id => this.#active.choices.find(choice => choice.id === id),
    };
  }

  get benchmarks() {
    return this.#active.benchmarks;
  }

  async import() {
    const entries = await Promise.all([CHOICES, BENCHMARKS].map(async tab => {
      let table;
      try {
        table = await this.source.readTab(tab);
      } catch {
        throw failure('import', { tab, code: 'SOURCE_FAILURE' });
      }
      if (table == null) throw failure('import', { tab, code: 'MISSING_TAB' });
      if (!Array.isArray(table)) throw failure('import', { tab, code: 'INVALID_RESPONSE' });
      table.forEach((row, index) => {
        if (!Array.isArray(row)) throw failure('import', { tab, code: 'INVALID_RESPONSE', row: index + 1, field: '$row' });
      });
      if (table.length < 2 || table.slice(1).every(emptyRow)) throw failure('import', { tab, code: 'EMPTY_TAB' });
      return [tab, structuredClone(table)];
    }));
    this.imported = Object.fromEntries(entries);
    this.parsed = null;
  }

  parse() {
    this.parsed = null;
    if (!this.imported) throw failure('parse', { code: 'NOT_IMPORTED' });
    this.parsed = {
      choices: parseTable(this.imported[CHOICES], CHOICES),
      benchmarks: parseTable(this.imported[BENCHMARKS], BENCHMARKS),
    };
    return this.parsed;
  }

  load() {
    if (!this.parsed) throw failure('load', { code: 'NOT_PARSED' });
    this.#active = structuredClone(this.parsed);
  }
}
