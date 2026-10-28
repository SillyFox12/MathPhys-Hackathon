let nextSession = 0;

function reject(code) {
  throw Object.assign(new Error(code), { code });
}

export default class GameSession {
  #id = ++nextSession;
  #revision = 0;
  #options;
  #state;
  #choices;
  #budget;
  #initialBudget;

  constructor({ player, catalog, choiceManager, budgetManager }) {
    try {
      if (typeof catalog?.getChoices !== 'function' || typeof catalog?.getChoice !== 'function') reject('INVALID_CATALOG');
      const options = catalog.getChoices();
      if (!Array.isArray(options) || !options.length || options.some(option =>
        !option || typeof option.id !== 'string' || !option.id.trim() || option.id !== option.id.trim()
        || !Number.isSafeInteger(option.round) || option.round <= 0
        || !Number.isFinite(option.cost) || option.cost < 0)
        || new Set(options.map(option => option.id)).size !== options.length) reject('INVALID_CATALOG');
      this.#options = structuredClone(options);
    } catch {
      reject('INVALID_CATALOG');
    }
    this.#choices = choiceManager;
    this.#budget = budgetManager;
    this.#initialBudget = budgetManager.current_budget();
    const rounds = [...new Set(this.#options.map(option => option.round))].sort((a, b) => a - b);
    this.#state = {
      player: structuredClone({ surname: player.surname, university_name: player.university_name }),
      rounds, round: rounds[0], phase: 'choice', totalSpent: 0,
      dismissal: null, completion: null,
    };
    this.#advanceToken();
  }

  #advanceToken() {
    this.#state.actionToken = `${this.#id}:${++this.#revision}`;
  }

  #check(token, phase) {
    if (token !== this.#state.actionToken) reject('STALE_ACTION');
    if (phase && this.#state.phase !== phase) reject('INVALID_PHASE');
  }

  getState() {
    return structuredClone({
      ...this.#state,
      remainingBudget: this.#budget.current_budget(),
      selectedChoices: this.#choices.choices,
      availableChoices: this.#options.filter(option => option.round === this.#state.round),
    });
  }

  selectOption(id, token) {
    this.#check(token, 'choice');
    if (typeof id !== 'string' || !id || id !== id.trim()) reject('INVALID_OPTION_ID');
    const option = this.#options.find(option => option.id === id);
    if (!option) reject('UNKNOWN_OPTION');
    if (option.round !== this.#state.round) reject('WRONG_ROUND');
    this.#budget.subtract(option.cost);
    this.#choices.choice_tracker(structuredClone(option));
    this.#state.totalSpent += option.cost;
    this.#state.phase = this.#budget.is_in_debt() ? 'fired' : 'choice';
    if (this.#state.phase === 'fired') {
      this.#state.dismissal = {
        player: this.#state.player, selectedOption: option,
        totalSpent: this.#state.totalSpent, overBudget: -this.#budget.current_budget(),
      };
    } else this.#advanceRound();
    this.#advanceToken();
  }

  #advanceRound() {
    const index = this.#state.rounds.indexOf(this.#state.round);
    if (index + 1 < this.#state.rounds.length) {
      this.#state.round = this.#state.rounds[index + 1];
      this.#state.phase = 'choice';
    } else {
      this.#state.phase = 'simulation_ready';
      this.#state.completion = structuredClone({
        player: this.#state.player, choices: this.#choices.choices,
        totalSpent: this.#state.totalSpent, remainingBudget: this.#budget.current_budget(),
      });
    }
  }

  getSimulationBuild() {
    if (this.#state.phase !== 'simulation_ready') reject('NOT_SIMULATION_READY');
    return structuredClone(this.#state.completion);
  }

  restart(token) {
    this.#check(token);
    this.#choices.choices.length = 0;
    this.#budget.budget = this.#initialBudget;
    Object.assign(this.#state, {
      phase: 'choice', round: this.#state.rounds[0], totalSpent: 0,
      dismissal: null, completion: null,
    });
    this.#advanceToken();
  }
}
