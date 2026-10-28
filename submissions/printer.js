const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export default class Printer {
  #charRate;
  #active;
  #audio;
  #paused = false;

  constructor(output, char_rate = 30, { audio } = {}) {
    if (output === null || typeof output !== 'object' || typeof output.textContent !== 'string') {
      throw new TypeError('Output must expose a string textContent property');
    }
    this.output = output;
    this.char_rate = char_rate;
    this.#audio = audio;
  }

  get char_rate() {
    return this.#charRate;
  }

  set char_rate(value) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('Character rate must be a positive finite number');
    }
    this.#charRate = value;
  }

  // Print one visible character immediately.
  print_char(character) {
    if (typeof character !== 'string' || [...segmenter.segment(character)].length !== 1) {
      throw new TypeError('Expected exactly one Unicode character');
    }
    this.output.textContent += character;
  }

  #sound(method, ...args) {
    try {
      Promise.resolve(this.#audio?.[method](...args)).catch(() => {});
    } catch {
      // Audio availability must not interrupt text playback.
    }
  }

  #finish(reason) {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    clearInterval(active.timer);
    this.#sound('stop_typing', reason);
    active.resolve(reason);
  }

  print_passage(text) {
    if (typeof text !== 'string') throw new TypeError('Expected passage text');
    this.cancel();
    this.output.textContent = '';
    if (text === '') return Promise.resolve('finished');
    const characters = [...segmenter.segment(text)].map(item => item.segment);
    return new Promise(resolve => {
      const active = { text, resolve };
      this.#active = active;
      let index = 0;
      const interval = 1000 / this.char_rate;
      this.#sound('start_typing');
      active.timer = setInterval(() => {
        if (this.#active !== active || this.#paused) return;
        const character = characters[index++];
        this.output.textContent += character;
        this.#sound('type_character', character, interval / 1000);
        if (index === characters.length) this.#finish('finished');
      }, interval);
    });
  }

  skip() {
    if (!this.#active) return;
    this.output.textContent = this.#active.text;
    this.#finish('skipped');
  }

  cancel() {
    this.#finish('cancelled');
  }

  pause() {
    this.#paused = true;
    this.#sound('stop_typing', 'paused');
  }

  resume() {
    this.#paused = false;
    if (this.#active) this.#sound('start_typing');
  }
}
