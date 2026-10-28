import GameData from './game_data.js';
import GameSession from './game_session.js';
import Player from './player.js';
import ChoiceManager from './choice.js';
import BudgetManager from './budget.js';
import { compareResults, calculateExpectedResults } from './results_comparison.js';

let nextApp = 0;
const validDuration = value => value === 30;

export default class AppController {
  #id = ++nextApp;
  #revision = 0;
  #epoch = 0;
  #state;
  #ports;
  #dependencies;
  #configuration;
  #data;
  #catalog;
  #benchmarks;
  #session;
  #build;
  #passage;
  #loading;
  #unsubscribe;
  #validated = false;

  constructor({ source, view, printer, audio, configuration, dependencies = {} }) {
    this.#ports = { source, view, printer, audio };
    this.#configuration = structuredClone(configuration);
    this.#dependencies = {
      createGameData: args => new GameData(args),
      createSession: args => new GameSession(args), compareResults, ...dependencies,
    };
    this.#state = {
      phase: 'idle', identity: null, durationDays: configuration?.durationDays,
      session: null, choices: [], dialogue: null, firingLetter: null, results: null, error: null,
    };
    this.#unsubscribe = view.onAction((action, token) => this.dispatch(action, token));
    this.#render();
  }

  getState() {
    return structuredClone(this.#state);
  }

  #render() {
    this.#state.actionToken = `${this.#id}:${++this.#revision}`;
    this.#ports.view.render(this.getState());
  }

  #sound(method, ...args) {
    try { Promise.resolve(this.#ports.audio?.[method](...args)).catch(() => {}); } catch {}
  }

  #stop() {
    this.#passage = null;
    try { this.#ports.printer.cancel(); } catch {}
    this.#sound('stop_typing', 'cancelled');
  }

  #error(stage, error) {
    this.#state.phase = 'error';
    this.#state.results = null;
    this.#state.error = { stage, code: error.code ?? 'ERROR', message: error.message || String(error) };
    this.#render();
  }

  #validate() {
    const config = this.#configuration;
    const choices = this.#catalog.getChoices();
    const map = config?.comparisonCalibration?.player?.optionMap;
    const invalid = () => { throw new Error('Invalid required application configuration'); };
    if (!validDuration(config?.durationDays) || !map) invalid();
    for (const option of choices) {
      if (!Object.hasOwn(map, option.id) || map[option.id]?.round !== option.round) invalid();
    }
    const rounds = [...new Set(choices.map(option => option.round))];
    for (const round of rounds) {
      const source = this.#catalog.getChoice(config.researchByRound?.[round]);
      if (!source || source.round !== round) invalid();
    }
    // Let the conversion modules validate calibration and each available response.
    const roles = ['medium', 'location', 'sensors', 'shielding'];
    const base = roles.map(role => choices.find(option => map[option.id]?.role === role));
    if (base.some(option => !option)) invalid();
    for (const option of choices) {
      const selected = base.map((entry, index) => roles[index] === map[option.id].role ? option : entry);
      calculateExpectedResults({ build: { choices: selected, totalSpent: 0 }, benchmarks: this.#benchmarks,
        calibration: config.comparisonCalibration, durationDays: config.durationDays });
    }
    this.#validated = true;
  }

  initialize() {
    if (this.#state.phase === 'disposed') return Promise.resolve(false);
    if (this.#loading) return this.#loading;
    if (this.#validated) return Promise.resolve(this.#state.phase === 'setup');
    const epoch = this.#epoch;
    this.#state.phase = 'loading';
    this.#state.error = null;
    this.#render();
    const operation = (async () => {
      if (!this.#data) {
        try {
          const data = this.#dependencies.createGameData({ source: this.#ports.source });
          await data.import();
          if (epoch !== this.#epoch) return false;
          data.parse();
          data.load();
          const choices = structuredClone(data.catalog.getChoices());
          this.#catalog = {
            getChoices: round => choices.filter(option => round === undefined || option.round === round),
            getChoice: id => choices.find(option => option.id === id),
          };
          this.#benchmarks = structuredClone(data.benchmarks);
          this.#data = data;
        } catch (error) {
          if (epoch === this.#epoch) this.#error('load', error);
          return false;
        }
      }
      try { this.#validate(); } catch (error) {
        if (epoch === this.#epoch) this.#error('configuration', error);
        return false;
      }
      if (epoch !== this.#epoch) return false;
      this.#state.phase = 'setup';
      this.#state.error = null;
      this.#render();
      return true;
    })();
    this.#loading = operation;
    operation.then(() => { if (this.#loading === operation) this.#loading = null; });
    return operation;
  }

  #sync() {
    const session = this.#session.getState();
    this.#state.session = session;
    this.#state.choices = session.availableChoices.map(option => ({ ...option, description: option.description ?? '' }));
    this.#state.phase = session.phase;
  }

  #dialogue() {
    this.#stop();
    const round = this.#state.session.round;
    const sourceOptionId = this.#configuration.researchByRound[round];
    const source = this.#catalog.getChoice(sourceOptionId);
    const dialogue = {
      round, sourceOptionId, headline: source.history_headline ?? 'Research update',
      startYear: source.history_start_year ?? null, endYear: source.history_end_year ?? null,
      text: source.history_context ?? 'No research update is available for this round.', status: 'printing',
    };
    this.#state.dialogue = dialogue;
    this.#state.phase = 'research';
    const passage = {};
    this.#passage = passage;
    this.#sound('start_typing');
    this.#render();
    try {
      Promise.resolve(this.#ports.printer.print_passage(dialogue.text)).then(
        status => this.#settlePassage(passage, status),
        () => this.#settlePassage(passage, 'failed'),
      );
    } catch { this.#settlePassage(passage, 'failed'); }
  }

  #settlePassage(passage, status) {
    if (this.#passage !== passage) return;
    this.#passage = null;
    this.#state.dialogue.status = status;
    this.#sound('stop_typing', status);
    this.#render();
  }

  #skip() {
    const passage = this.#passage;
    this.#ports.printer.skip();
    this.#settlePassage(passage, 'skipped');
    return true;
  }

  async #compare() {
    const epoch = this.#epoch;
    this.#state.phase = 'calculating';
    this.#state.results = null;
    this.#state.error = null;
    this.#render();
    try {
      const results = await this.#dependencies.compareResults({
        build: structuredClone(this.#build), benchmarks: structuredClone(this.#benchmarks),
        calibration: structuredClone(this.#configuration.comparisonCalibration), durationDays: this.#state.durationDays,
      });
      if (epoch !== this.#epoch) return false;
      this.#state.phase = 'results';
      this.#state.results = structuredClone(results);
      this.#render();
      return true;
    } catch (error) {
      if (epoch === this.#epoch) this.#error('comparison', error);
      return false;
    }
  }

  async dispatch(action, token) {
    const state = this.#state;
    if (state.phase === 'disposed' || token !== state.actionToken || !action || typeof action !== 'object') return false;
    const { type } = action;
    if (type === 'restart') {
      this.#epoch++;
      this.#loading = null;
      this.#stop();
      this.#sound('pause_game');
      this.#session = null;
      this.#build = null;
      Object.assign(state, { session: null, choices: [], dialogue: null, firingLetter: null, results: null, error: null });
      if (!this.#validated) return this.initialize();
      state.phase = 'setup';
      this.#render();
      return true;
    }
    if (type === 'retry' && state.phase === 'error') {
      return state.error.stage === 'comparison' ? this.#compare() : this.initialize();
    }
    if (type === 'start' && state.phase === 'setup') {
      const identity = action.identity;
      if (!identity || !['surname', 'university_name'].every(key => typeof identity[key] === 'string' && identity[key].trim())) return false;
      const player = new Player(identity.surname, identity.university_name);
      this.#session = this.#dependencies.createSession({ player, catalog: this.#catalog,
        choiceManager: new ChoiceManager(this.#catalog), budgetManager: new BudgetManager(50_000_000) });
      state.identity = { surname: player.surname, university_name: player.university_name };
      this.#sync();
      this.#sound(typeof this.#ports.audio?.restart_game === 'function' ? 'restart_game' : 'start_game');
      this.#dialogue();
      return true;
    }
    if (type === 'select' && state.phase === 'choice') {
      try { this.#session.selectOption(action.id, state.session.actionToken); } catch { return false; }
      this.#sync();
      if (state.phase === 'fired') {
        this.#stop();
        this.#sound('pause_game');
        state.firingLetter = structuredClone(state.session.dismissal);
        this.#render();
      } else if (state.phase === 'simulation_ready') {
        this.#stop();
        state.dialogue = null;
        this.#build = this.#session.getSimulationBuild();
        await this.#compare();
      } else this.#dialogue();
      return true;
    }
    if (state.phase === 'research') {
      if ((type === 'skip' || type === 'continue') && state.dialogue.status === 'printing') return this.#skip();
      if (type === 'continue') {
        this.#stop();
        state.dialogue = null;
        state.phase = 'choice';
        this.#render();
        return true;
      }
    }
    return false;
  }

  dispose() {
    if (this.#state.phase === 'disposed') return;
    this.#epoch++;
    this.#stop();
    this.#sound('pause_game');
    this.#sound('dispose');
    this.#unsubscribe();
    this.#state.phase = 'disposed';
    this.#render();
  }
}
