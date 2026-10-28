export function createRingSequence({ counts, random = Math.random }) {
  const invalid = field => { throw Object.assign(new Error(`Invalid signal counts: ${field}`), { code: 'INVALID_SIGNAL_COUNTS', field }); };
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) invalid('counts');
  let total = 0;
  for (const channel of ['solar', 'atmospheric', 'astronomical']) {
    if (!Number.isSafeInteger(counts[channel]) || counts[channel] < 0) invalid(`counts.${channel}`);
    total += counts[channel];
    if (!Number.isSafeInteger(total)) invalid('counts.total');
  }
  const uniform = () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw Object.assign(new Error('Invalid visual random value'), { code: 'INVALID_VISUAL_RANDOM' });
    }
    return value;
  };
  const length = Math.min(total, 120);
  const rings = Array.from({ length }, (_, id) => {
    const end = 29 / length * (id + 1);
    const birthSeconds = Math.min(29 / length * (id + uniform()), end - Number.EPSILON * Math.max(1, end));
    const angle = uniform() * Math.PI * 2;
    const speed = .04 + uniform() * .08;
    const radius = .05 + uniform() * .06;
    return {
      id, batchSize: Math.floor(total / length) + (id < total % length ? 1 : 0), birthSeconds,
      center: { x: .02 + uniform() * .96, y: .1 + uniform() * .8 },
      velocity: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      radii: { x: radius, y: radius * (.4 + uniform() * .3) },
      rotation: uniform() * Math.PI, brightness: .6 + uniform() * .3,
    };
  });
  return { totalDetections: total, durationSeconds: 30, rings };
}

export function ringStateAt(ring, elapsedSeconds) {
  const age = elapsedSeconds - ring.birthSeconds;
  if (elapsedSeconds < ring.birthSeconds || elapsedSeconds >= ring.birthSeconds + 1) return null;
  return {
    id: ring.id, batchSize: ring.batchSize,
    center: { x: ring.center.x + age * ring.velocity.x, y: ring.center.y + age * ring.velocity.y },
    radii: { x: ring.radii.x * (1 + age * .15), y: ring.radii.y * (1 + age * .15) },
    rotation: ring.rotation, opacity: ring.brightness * Math.sin(Math.PI * age) ** 2,
  };
}

export function createRingAnimation({ canvas, sequence, reducedMotion = false, clock = {
  now: () => performance.now(), requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
} }) {
  const context = canvas.getContext('2d');
  const pauses = new Set();
  let status = 'idle', elapsedSeconds = 0, baseElapsed = 0, lastTime = 0, pending;
  let width = 1, height = 1, dpr = 1;
  const active = () => sequence.rings.map(ring => ringStateAt(ring, elapsedSeconds)).filter(Boolean);
  function draw() {
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (status === 'completed' || status === 'disposed') return;
    const rings = status === 'stationary' && sequence.rings.length
      ? [ringStateAt(sequence.rings[0], sequence.rings[0].birthSeconds + .5)] : active();
    // A shared CSS-pixel scale preserves the ellipse proportions on narrow screens.
    const ringScale = Math.max(560, Math.min(width, height));
    for (const ring of rings) {
      context.save();
      context.globalAlpha = ring.opacity * .72;
      context.strokeStyle = '#20cbea';
      context.lineWidth = 1.35;
      context.shadowColor = '#20cbea';
      context.shadowBlur = 7;
      context.beginPath();
      context.ellipse(ring.center.x * width, ring.center.y * height, ring.radii.x * ringScale,
        ring.radii.y * ringScale, ring.rotation, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }
  function update(now) {
    elapsedSeconds = Math.min(30, baseElapsed + Math.max(0, now - lastTime) / 1000);
    if (elapsedSeconds === 30) status = 'completed';
  }
  function cancelFrame() {
    if (pending !== undefined) clock.cancelFrame(pending);
    pending = undefined;
  }
  function frame(now) {
    if (status !== 'running') return;
    pending = undefined;
    update(now);
    draw();
    if (status === 'running') pending = clock.requestFrame(frame);
  }
  return {
    start() {
      if (status !== 'idle') return;
      status = reducedMotion ? 'stationary' : sequence.totalDetections === 0 ? 'completed' : pauses.size ? 'paused' : 'running';
      lastTime = clock.now();
      draw();
      if (status === 'running') pending = clock.requestFrame(frame);
    },
    pause(reason) {
      pauses.add(reason);
      if (status !== 'running') return;
      update(clock.now());
      baseElapsed = elapsedSeconds;
      if (status !== 'completed') status = 'paused';
      cancelFrame();
      draw();
    },
    resume(reason) {
      pauses.delete(reason);
      if (status !== 'paused' || pauses.size) return;
      status = 'running';
      lastTime = clock.now();
      pending = clock.requestFrame(frame);
    },
    resize(size) {
      if (status === 'disposed') return;
      ({ width, height, dpr } = size);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      draw();
    },
    getState() { return structuredClone({ status, elapsedSeconds, activeRings: status === 'disposed' ? [] : active() }); },
    dispose() {
      if (status === 'disposed') return;
      status = 'disposed';
      cancelFrame();
      draw();
    },
  };
}
