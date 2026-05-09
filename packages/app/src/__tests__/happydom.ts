// Bun preload module that registers happy-dom's globals (window,
// document, navigator, requestAnimationFrame, etc.) on the bun runtime
// before any test file is loaded.
//
// Tests that only touch zustand stores don't need this; tests that
// render React components do. Wired via packages/app/bunfig.toml.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
