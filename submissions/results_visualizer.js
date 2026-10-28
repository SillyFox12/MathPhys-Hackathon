const media = ['ultra_purified_water', 'liquid_argon', 'liquid_scintillator'];
const categories = [['noise', 'Background noise'], ['solar', 'Solar neutrinos'],
  ['atmospheric', 'Atmospheric neutrinos'], ['astronomical', 'Astronomical neutrinos']];
const detectors = [['player', 'Your detector', '#1455dc'], ['ice_cube', 'IceCube', '#7945cc'], ['super_k', 'Super-K', '#b87400']];
const rendered = new WeakMap();

function node(tag, text = '', attrs = {}, svg = false) {
  const element = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  element.textContent = text;
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}
const graphic = (tag, attrs, text = '') => node(tag, text, attrs, true);

// Visual randomness positions a bounded illustrative event; counts come only from results.
export function renderResultsVisualizer({ container, results, mediumId, random = Math.random }) {
  const records = results?.detectors;
  const valid = media.includes(mediumId) && results?.durationDays === 30 && Array.isArray(records)
    && records.length === detectors.length && detectors.every(([id]) =>
      records.filter(record => record?.id === id).length === 1)
    && records.every(record => categories.every(([key]) =>
      Number.isSafeInteger(record.simulatedCounts?.[key]) && record.simulatedCounts[key] >= 0));
  if (!valid) {
    rendered.delete(container);
    container.replaceChildren(node('p', 'Results are unavailable. A supported medium and complete simulated counts over 30 days are required.', { role: 'alert' }));
    return;
  }
  const counts = detectors.map(([id]) => records.find(record => record.id === id).simulatedCounts);
  const key = JSON.stringify([mediumId, counts.map(count => categories.map(([channel]) => count[channel]))]);
  const previous = rendered.get(container);
  if (previous?.key === key && previous.root.parentElement === container) return;

  const root = node('section', '', { class: 'results-visualizer' });
  root.append(node('h1', 'Your first 30 days of data'), node('p', 'Your detector ran for 30 days. Here’s what it caught, next to two real detectors: IceCube (a cubic kilometer of Antarctic ice) and Super-Kamiokande (50,000 tons of water in Japan).'));
  const layout = node('div', '', { class: 'results-layout' });
  const monitor = node('figure', '', { 'aria-label': 'Player detector event monitor', 'data-medium-id': mediumId, class: 'event-monitor' });
  const mediumName = { ultra_purified_water: 'Ultrapure water', liquid_argon: 'Liquid argon', liquid_scintillator: 'Liquid scintillator' }[mediumId];
  monitor.append(node('h2', mediumName), node('p', 'What one neutrino looks like in your detector'));
  const display = graphic('svg', { viewBox: '0 0 600 360', 'aria-hidden': 'true', class: 'event-points' });
  for (let i = 0; i < 96; i++) {
    const angle = mediumId === media[0] ? (i + random() * .5) * Math.PI * 2 / 96 : random() * Math.PI * 2;
    const radius = mediumId === media[0] ? .94 + random() * .12 : Math.sqrt(random());
    const spread = mediumId === media[1] ? [65, 45] : [190, 110];
    display.append(graphic('circle', { cx: 300 + Math.cos(angle) * radius * spread[0],
      cy: 180 + Math.sin(angle) * radius * spread[1], r: 1.5 + random() * 2,
      fill: '#55eaff', opacity: mediumId === media[2] ? .35 + random() * .5 : .65 + random() * .35,
      'data-response': 'signal' }));
  }
  // Display-only compression: never allocate a point for each simulated background event.
  const noisePoints = Math.min(64, Math.ceil(8 * Math.log10(1 + counts[0].noise)));
  for (let i = 0; i < noisePoints; i++) display.append(graphic('circle', {
    cx: 15 + random() * 570, cy: 15 + random() * 330, r: 1.5 + random() * 1.5,
    fill: '#ff7777', 'data-response': 'background' }));
  const pointLegend = node('div', '', { class: 'point-legend' });
  pointLegend.append(node('span', 'Light caught by your sensors', { class: 'signal-key' }), node('span', 'Stray noise hits', { class: 'noise-key' }));
  monitor.append(display, pointLegend, node('figcaption', 'One neutrino’s flash as your sensors see it. Red dots are stray noise. (Illustration, not real data.)'));

  const chart = node('section', '', { role: 'region', 'aria-label': '30-day simulated counts', class: 'count-chart paper' });
  chart.append(node('h2', 'How many did you catch?'), node('p', 'Each chart has its own scale, so compare bars within one chart. Background noise is fake signals: lower is better. IceCube catches zero solar neutrinos because its sensors are too far apart to see such faint flashes.'));
  for (const [channel, title] of categories) {
    const group = node('section', '', { role: 'group', 'aria-label': title, class: 'count-category' });
    const values = counts.map(count => count[channel]);
    const max = Math.max(1, ...values);
    group.append(node('h3', title));
    const labels = node('div', '', { class: 'count-labels' });
    for (const value of values) labels.append(node('span', String(value), { 'data-count-label': '' }));
    const plot = graphic('svg', { viewBox: '0 0 360 160', class: 'count-plot' });
    const axis = graphic('g', { role: 'img', 'aria-label': title + ' vertical scale', 'data-scale-min': 0, 'data-scale-max': max });
    axis.append(graphic('text', { x: 0, y: 34, 'dominant-baseline': 'text-after-edge' }, String(max)),
      graphic('text', { x: 0, y: 150 }, '0'),
      graphic('line', { x1: 0, y1: 34, x2: 360, y2: 34, stroke: '#1d367e' }),
      graphic('line', { x1: 0, y1: 154, x2: 360, y2: 154, stroke: '#1d367e' }));
    plot.append(axis);
    detectors.forEach(([id, label, color], i) => {
      // Enlarged plot units preserve small bars within SVG's coordinate limits.
      const plotUnits = 10_000_000;
      const height = values[i] / max * plotUnits;
      const bar = graphic('rect', { x: 40 + i * 120,
        transform: `translate(0 154) scale(1 ${120 / plotUnits})`, width: 60,
        fill: color, role: 'img', 'aria-label': `${label}, ${title}: ${values[i]}`,
        'data-detector-id': id, 'data-channel': channel });
      // SVG's string length parser loses precision on very small decimal lengths.
      bar.height.baseVal.value = height;
      bar.y.baseVal.value = -height;
      plot.append(bar);
    });
    group.append(labels, plot); chart.append(group);
  }
  const legend = node('div', '', { role: 'group', 'aria-label': 'Detector legend', class: 'detector-legend' });
  for (const [id, label] of detectors) legend.append(node('span', label, { class: 'detector-' + id }));
  chart.append(legend);
  layout.append(monitor, chart); root.append(layout);

  const table = node('table', '', { 'aria-label': 'Simulated counts over 30 days', class: 'counts-table' });
  table.append(node('caption', 'All the numbers, side by side (30 days, simulated)'));
  const head = node('thead'), header = node('tr');
  header.append(node('th', 'Category', { scope: 'col' }));
  for (const [, label] of detectors) header.append(node('th', label, { scope: 'col' }));
  head.append(header); table.append(head);
  const body = node('tbody');
  for (const [channel, title] of categories) {
    const row = node('tr'); row.append(node('th', title, { scope: 'row' }));
    for (const count of counts) row.append(node('td', String(count[channel])));
    body.append(row);
  }
  table.append(body); root.append(table);
  container.replaceChildren(root);
  rendered.set(container, { key, root });
}
