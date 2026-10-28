import AppController from './app_controller.js';
import BrowserSource from './browser_source.js';
import Printer from './printer.js';

export function startApplication({ configuration, view, output, audio, printer = new Printer(output, 30, { audio }), source = new BrowserSource() }) {
  const app = new AppController({ source, configuration, view, printer, audio });
  // AppController alone owns GameData import -> parse -> load and retry.
  const ready = app.initialize();
  return { app, ready };
}
