/**
 * Test environment bootstrap — installs a happy-dom global before any
 * test file imports run, so React Testing Library can render into a
 * real DOM. Loaded via `bunfig.toml` `[test] preload`.
 *
 * Without this, importing `@testing-library/react` blows up because
 * `document` / `window` / `HTMLElement` are undefined under bun's
 * default test runtime.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  GlobalRegistrator.register();
}
