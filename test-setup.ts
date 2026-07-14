// Registers a DOM (document/window/Element…) for `bun test` so the extension's
// DOM-touching modules (e.g. the score-grid ranker) can be tested. Additive —
// the pure web/gmaps-shared tests are unaffected.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
