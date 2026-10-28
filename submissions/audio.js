function volume(level) {
  if (!Number.isFinite(level) || level < 0 || level > 1) {
    throw new RangeError('Volume must be a number between 0 and 1');
  }
  return level;
}

// The recording is decoded unchanged; only a short key transient is voiced per print tick.
class SynchronizedTyping {
  #context;
  #gain;
  #buffer;
  #loading;
  #voices = new Set();
  #wanted = false;
  #disposed = false;
  #volume = 1;
  #muted = false;
  #resumePending = false;

  constructor(media, notify, { audioContextFactory, loadTypingBuffer } = {}) {
    this.media = media;
    this.notify = notify;
    this.contextFactory = audioContextFactory ?? (() => {
      const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return new Context({ latencyHint: 'interactive' });
    });
    this.loadBuffer = loadTypingBuffer ?? (async (context, src) => {
      const response = await fetch(src);
      if (!response.ok) throw new Error('Typing recording unavailable');
      return context.decodeAudioData(await response.arrayBuffer());
    });
  }

  #stateChanged = () => {
    if (this.#context?.state !== 'running') for (const voice of [...this.#voices]) this.#remove(voice, true);
    this.notify(this.#wanted && !this.#disposed && this.#context?.state !== 'running');
  };

  start(retry = false) {
    if (this.#disposed) return Promise.resolve(false);
    this.#wanted = true;
    try {
      if (!this.#context) {
        this.#context = this.contextFactory();
        this.#gain = this.#context.createGain();
        this.#gain.gain.value = this.#muted ? 0 : this.#volume;
        this.#gain.connect(this.#context.destination);
        this.#context.addEventListener('statechange', this.#stateChanged);
      }
      if (!this.#loading) {
        this.#loading = Promise.resolve(this.loadBuffer(this.#context, this.media.currentSrc || this.media.src))
          .then(buffer => { if (!this.#disposed) this.#buffer = buffer; }).catch(() => {});
      }
      if (this.#context.state !== 'running' && (!this.#resumePending || retry)) {
        // resume() is invoked within the gesture; never await a Safari permission-pending promise.
        this.#resumePending = true;
        Promise.resolve(this.#context.resume()).then(() => {
          this.#resumePending = false; this.#stateChanged();
        }, () => { this.#resumePending = false; this.#stateChanged(); });
      }
      this.#stateChanged();
      return Promise.resolve(this.#context.state === 'running');
    } catch {
      this.notify(true);
      return Promise.resolve(false);
    }
  }

  #remove(voice, stop = false) {
    if (!this.#voices.delete(voice)) return;
    if (stop) { try { voice.source.stop(); } catch {} }
    voice.source.disconnect(); voice.gain.disconnect();
  }

  pulse(_character, intervalSeconds = 1 / 30) {
    if (!this.#wanted || this.#disposed || !this.#buffer || this.#context.state !== 'running'
      || this.#muted || this.#volume === 0) return false;
    if (this.#voices.size >= 2) this.#remove(this.#voices.values().next().value, true);
    const source = this.#context.createBufferSource(), gain = this.#context.createGain();
    const now = this.#context.currentTime;
    const duration = Math.min(.032, Math.max(.004, intervalSeconds * .85));
    const offset = Math.min(.140, Math.max(0, this.#buffer.duration - duration));
    source.buffer = this.#buffer;
    source.connect(gain); gain.connect(this.#gain);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + Math.min(.002, duration / 4));
    gain.gain.setValueAtTime(1, now + duration - Math.min(.003, duration / 3));
    gain.gain.linearRampToValueAtTime(0, now + duration);
    const voice = { source, gain };
    source.onended = () => this.#remove(voice);
    this.#voices.add(voice);
    source.start(now, offset, duration);
    return true;
  }

  setVolume(value) { this.#volume = value; this.#applyGain(); }
  setMuted(value) { this.#muted = value; this.#applyGain(); }
  #applyGain() {
    if (!this.#gain) return;
    this.#gain.gain.cancelScheduledValues(this.#context.currentTime);
    this.#gain.gain.setTargetAtTime(this.#muted ? 0 : this.#volume, this.#context.currentTime, .005);
  }

  stop(reason) {
    this.#wanted = false;
    this.notify(false);
    // Let the final printed key finish its <=32ms envelope; reveal/skip/pause never add a sound.
    if (reason !== 'finished') for (const voice of [...this.#voices]) this.#remove(voice, true);
  }

  getState() {
    return { typingMode: 'synchronized', typingContextState: this.#context?.state ?? 'uninitialized',
      typingReady: !!this.#buffer, typingVoices: this.#voices.size };
  }

  dispose() {
    this.#disposed = true; this.stop();
    if (this.#context) {
      this.#context.removeEventListener('statechange', this.#stateChanged);
      this.#gain.disconnect();
      Promise.resolve(this.#context.close()).catch(() => {});
    }
  }
}

export default class Audio {
  #playbacks = new Map();
  #tracks;
  #playlist;
  #index = 0;
  #music;
  #failed = new Set();
  #pauses = new Set();
  #wanted = false;
  #disposed = false;
  #typingWanted = false;
  #blocked = { musicBlocked: false, typingBlocked: false };
  #listeners = new Set();
  #typingSync;
  #musicVolume;
  #typingVolume;
  #musicMuted;
  #typingMuted;

  constructor(game_music, printing_sound, options = {}) {
    this.#playlist = Array.isArray(game_music);
    this.#tracks = this.#playlist ? [...game_music] : [game_music];
    this.game_music = this.#tracks[0];
    this.printing_sound = printing_sound;
    this.#musicVolume = this.game_music.volume;
    this.#typingVolume = printing_sound.volume;
    this.#musicMuted = !!this.game_music.muted;
    this.#typingMuted = !!printing_sound.muted;
    if (this.#musicVolume === 0) for (const track of this.#tracks) track.muted = true;
    if (this.#typingVolume === 0) printing_sound.muted = true;
    if (options.synchronizedTyping) {
      this.printing_sound.loop = false;
      this.#typingSync = new SynchronizedTyping(printing_sound, blocked => this.#setBlocked(printing_sound, blocked), options);
      this.#typingSync.setVolume(this.#typingVolume);
      this.#typingSync.setMuted(this.#typingMuted);
    }
  }

  getPlaybackState() {
    return { ...this.#blocked, typingWanted: this.#typingWanted,
      ...(this.#typingSync?.getState() ?? { typingMode: 'native', typingContextState: 'uninitialized',
        typingReady: true, typingVoices: 0 }) };
  }

  onPlaybackState(listener) {
    this.#listeners.add(listener);
    listener({ ...this.#blocked });
    return () => this.#listeners.delete(listener);
  }

  #setBlocked(sound, blocked) {
    const channel = sound === this.printing_sound ? 'typingBlocked' : 'musicBlocked';
    if (this.#blocked[channel] === blocked) return;
    this.#blocked[channel] = blocked;
    for (const listener of this.#listeners) {
      try { listener({ ...this.#blocked }); } catch {}
    }
  }

  enable_sound() {
    if (this.#disposed || this.#pauses.size) return Promise.resolve(false);
    // Invoke both play() requests inside the activating gesture, before awaiting either.
    const requests = [];
    if (this.#blocked.musicBlocked && this.#wanted) {
      requests.push(this.#playlist ? this.#playMusic(true) : this.#start(this.game_music));
    }
    if (this.#blocked.typingBlocked && this.#typingWanted) {
      requests.push(this.#typingSync ? this.#typingSync.start(true) : this.start_typing());
    }
    return Promise.all(requests).then(results => results.length > 0 && results.every(Boolean));
  }

  game_volume(level) {
    const value = volume(level);
    this.#musicVolume = value;
    for (const track of this.#tracks) {
      track.volume = value;
      track.muted = this.#musicMuted || value === 0;
    }
  }

  typing_volume(level) {
    const value = volume(level);
    this.#typingVolume = value;
    this.printing_sound.volume = value;
    this.printing_sound.muted = this.#typingMuted || value === 0;
    this.#typingSync?.setVolume(value);
  }

  mute_game() {
    this.#musicMuted = true;
    for (const track of this.#tracks) track.muted = true;
  }

  mute_typing() {
    this.#typingMuted = true;
    this.printing_sound.muted = true;
    this.#typingSync?.setMuted(true);
  }

  unmute_game() {
    this.#musicMuted = false;
    for (const track of this.#tracks) track.muted = this.#musicVolume === 0;
  }

  unmute_typing() {
    this.#typingMuted = false;
    this.printing_sound.muted = this.#typingVolume === 0;
    this.#typingSync?.setMuted(false);
  }

  #start(sound, loop = true, onFailure = () => {}) {
    if (this.#disposed) return Promise.resolve(false);
    if (this.#playbacks.has(sound)) return this.#playbacks.get(sound).promise;
    const request = {};
    this.#playbacks.set(sound, request);
    request.promise = (async () => {
      try {
        sound.loop = loop;
        await sound.play();
        const started = this.#playbacks.get(sound) === request;
        if (started) this.#setBlocked(sound, false);
        return started;
      } catch (error) {
        if (this.#playbacks.get(sound) === request) {
          this.#playbacks.delete(sound);
          this.#setBlocked(sound, error?.name === 'NotAllowedError');
          onFailure(error);
        }
        return false;
      }
    })();
    return request.promise;
  }

  #pause(sound) {
    this.#playbacks.delete(sound);
    sound.pause();
  }

  #clearMusic() {
    const request = this.#music;
    this.#music = null;
    if (!request) return;
    for (const [type, listener] of request.listeners) request.sound.removeEventListener(type, listener);
    this.#pause(request.sound);
  }

  #advance(request, failed = false) {
    if (this.#music !== request) return Promise.resolve(false);
    if (failed) this.#failed.add(this.#index);
    this.#clearMusic();
    if (this.#failed.size === this.#tracks.length) return Promise.resolve(false);
    do { this.#index = (this.#index + 1) % this.#tracks.length; } while (this.#failed.has(this.#index));
    this.game_music = this.#tracks[this.#index];
    this.game_music.currentTime = 0;
    return this.#playMusic();
  }

  #playMusic(retryBlocked = false) {
    if (this.#disposed || this.#pauses.size || (this.#blocked.musicBlocked && !retryBlocked)
      || this.#failed.size === this.#tracks.length) return Promise.resolve(false);
    if (this.#music) return this.#music.promise;
    const sound = this.#tracks[this.#index];
    const request = { sound, listeners: [] };
    this.#music = request;
    for (const type of ['ended', 'error']) {
      const listener = () => { void this.#advance(request, type === 'error'); };
      request.listeners.push([type, listener]);
      sound.addEventListener(type, listener);
    }
    request.promise = (async () => {
      let blocked = false;
      const started = await this.#start(sound, this.#tracks.length === 1, error => { blocked = error?.name === 'NotAllowedError'; });
      if (this.#music !== request) return false;
      // Autoplay denial applies to the channel; changing recordings cannot grant permission.
      if (blocked) {
        this.#clearMusic();
        return false;
      }
      if (!started) return this.#advance(request, true);
      this.#failed.clear();
      return true;
    })();
    return request.promise;
  }

  start_game() {
    this.#wanted = true;
    if (this.#disposed || this.#pauses.size) return Promise.resolve(false);
    if (this.#playlist) return this.#playMusic();
    return this.#start(this.game_music);
  }

  start_typing() {
    if (this.#disposed) return Promise.resolve(false);
    this.#typingWanted = true;
    if (this.#pauses.size) return Promise.resolve(false);
    return this.#typingSync ? this.#typingSync.start() : this.#start(this.printing_sound);
  }

  type_character(character, intervalSeconds) {
    if (this.#disposed || this.#pauses.size) return false;
    return this.#typingSync?.pulse(character, intervalSeconds) ?? false;
  }

  pause_game(reason) {
    if (reason !== undefined) this.#pauses.add(reason);
    else { this.#wanted = false; this.#setBlocked(this.game_music, false); }
    if (this.#playlist) this.#clearMusic();
    else this.#pause(this.game_music);
  }

  resume_game(reason) {
    this.#pauses.delete(reason);
    return this.#wanted ? this.start_game() : Promise.resolve(false);
  }

  restart_game() {
    if (this.#disposed) return Promise.resolve(false);
    this.pause_game();
    this.#failed.clear();
    this.#index = 0;
    for (const track of this.#tracks) track.currentTime = 0;
    this.game_music = this.#tracks[0];
    return this.start_game();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.pause_game();
    this.stop_typing();
    this.#typingSync?.dispose();
    this.#listeners.clear();
  }

  stop_typing(reason) {
    this.#typingWanted = false;
    this.#setBlocked(this.printing_sound, false);
    this.#typingSync?.stop(reason);
    this.#pause(this.printing_sound);
    this.printing_sound.loop = false;
    this.printing_sound.currentTime = 0;
  }
}
