// BudgetManager.js
export default class BudgetManager {
  constructor(initialBudget = 0) {
    this.budget = initialBudget;
  }

  current_budget() {
    return this.budget;
  }

  subtract(amount) {
    this.budget -= amount;
  }

  is_in_debt() {
    return this.budget < 0
  }
}
