export default class ChoiceManager {
  constructor(catalog) {
    this.catalog = catalog;
    this.choices = [];
  }

  choice_tracker(choice) {
    this.choices.push(choice);
  }
}
