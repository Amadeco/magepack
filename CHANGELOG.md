# Changelog - Amadeco Magepack (ESM Edition)

All notable changes to this project will be documented in this file.
This fork has been specifically re-architected to meet the strict requirements of Adobe Commerce (Magento 2.4.8+), with an absolute focus on performance (KISS principle), CI/CD resilience, and advanced static compression.

## [3.1.0] - 2026-03-30

### ✨ Added
- **Build-Time Mixin Composition:** Introduced the `mixinComposer.js` service that resolves the fundamental incompatibility between Magepack JS bundling and Magento's `mixins!` RequireJS plugin. When a bundle contains both a mixin target (e.g., `Magento_Swatches/js/swatch-renderer`) and its mixin factories, the composer now produces a single composite AMD module that applies the full mixin chain at RequireJS resolution time — with zero additional HTTP requests and zero reliance on the `require.load()` interception mechanism.
  - `lib/bundle/service/mixinComposer.js` — Generates composite `define()` blocks: renames the original target with a `__magepack_original__` suffix, keeps mixin factory `define()` calls intact, and appends a composite `define("target", ["target__magepack_original__", "mixin0", ...])` that chains all mixins via RequireJS's native dependency resolution.
  - `lib/bundle/service/mixinResolver.js` — Parses the deployed `requirejs-config.js` (via sandboxed `new Function()` evaluation) to extract all `config.mixins` declarations. Builds per-bundle mixin maps that classify each mixin factory as "bundled" (composed at build-time) or "external" (loaded at runtime by `mixins!`).

### 🚀 Changed
- **Bundle Orchestrator (`lib/bundle.js`):** The locale processing pipeline now resolves mixin declarations once per locale via `resolveLocaleMixins()`, builds per-bundle mixin maps via `buildBundleMixinMap()`, and passes them to `processBundle()`. Added `structuredClone()` isolation per locale to prevent cross-locale state corruption when processing multiple locales concurrently via `Promise.allSettled` — both ghost module pruning and mixin composition mutate `bundle.modules` in place.
- **Bundle Processor (`lib/bundle/processor.js`):** Integrated the mixin composition phase (Step 2.5) between module wrapping and Terser minification. The processor now uses a `Map`-based `wrappedModules` collection (preserving insertion order) instead of a plain `Object` for deterministic output. Absorbed mixin modules are removed from both the bundle output and the `bundle.modules` declaration, preventing `configInjector.js` from declaring them in `require.config({bundles:...})` — which would cause RequireJS to consider them "loaded" globally and break mixin resolution on non-bundled pages. Added trailing semicolon enforcement (`ensureTrailingSemicolon`) on every module entry in the Terser sources map to prevent ASI failures when Terser's aggressive mode strips whitespace between adjacent `define()` calls.

### 🐛 Fixed
- **Silent Mixin Failure (Critical):** Resolved the root cause of RequireJS mixins being silently ignored when their target modules were included in Magepack bundles. The `mixins!` plugin intercepts `require.load()` to apply mixin wrappers, but bundled modules are resolved directly from RequireJS's internal registry without ever triggering `require.load()`. The new composition pipeline eliminates this by pre-applying the mixin chain at build-time inside the bundle itself.
- **IIFE Orchestrator Timing Bug:** The initial v3.1.0-alpha implementation used a synchronous IIFE that read from `require.s.contexts._.defined` immediately after the bundle's `define()` calls. However, RequireJS named `define("name", [deps], factory)` does **not** execute the factory synchronously — it queues the module and only resolves dependencies when triggered by a `require()` call. The IIFE found `undefined` for all entries and silently exited. Replaced with a proper `define()`-based composite that uses RequireJS's native dependency resolution, guaranteeing all participants are available before the composition factory executes.
- **`define(...) is not a function` Error:** Added mandatory trailing semicolons to all module source blocks before Terser concatenation. Without explicit semicolons, Terser's aggressive mode produces `define(...)define(...)` which JavaScript parses as `define(...)(define(...))` — a function call on the return value of the first `define()`, which is `undefined`.
- **Cross-Locale State Corruption:** The shared `config` array passed to `processLocale()` was mutated in place by both ghost module pruning (`delete bundle.modules[name]`) and mixin absorption. When processing multiple locales concurrently via `Promise.allSettled`, the second locale operated on a partially pruned/composed configuration from the first. Fixed by deep-cloning the config per locale with `structuredClone()`.
- **Checkout Collector Crash (`lib/generate/collector/checkout.js`):** Fixed `undefined is not iterable` error in the `page.evaluate` block that handles product option selection during checkout bundle generation. The code called `Array.from(select.options)` without verifying the matched DOM element was an actual `<select>` element — on simple products without configurable options, the selector could match non-`<select>` elements where `.options` is `undefined`. Added defensive guards: array type checks on `swatchClickers`/`dropdownSelects`, null checks on `querySelectorAll` results, and `<select>` element validation before accessing `.options`.

## [Amadeco Edition] - 2026-03-03

### ✨ Added
- **Native Zstandard (Zstd) Compression:** Complete replacement of dynamic server-side compression in favor of static `.zst` pre-compilation. Utilizes the host OS's native CLI binary (`node:child_process`) to eliminate memory padding bugs (`U+0000` null characters) associated with WebAssembly ports.
- **"Ultra" Compression Levels:** Implemented Zstd level 19/22 (`--ultra`) and Brotli Max (level 11) running concurrently (`Promise.all`). This guarantees static bundles that are 15% to 30% lighter than on-the-fly server compression.
- **Graceful Degradation:** Added automatic detection of the `zstd` utility on the host server. If missing, the script gracefully warns the user and continues generating Gzip/Brotli assets without crashing the build.
- **Strict CSP Support (Subresource Integrity):** Added the `sriUpdater.js` service, which automatically calculates and updates SHA-256 hashes in `sri-hashes.json`, making the generated bundles 100% compliant with Magento 2.4.8+ strict CSP policies.
- **Secure HTML/Knockout Minification:** The HTML template minifier now strictly ignores Magento's virtual comments (e.g., ``), preventing the destruction of KnockoutJS DOM bindings.

### 🚀 Changed
- **ES Modules (ESM) Architecture:** Full source code migration (Node 18+) to native ESM standards (native imports, top-level await) for faster boot times and modern code maintainability.
- **Dynamic CLI Loading:** The `bundle` and `generate` commands are now loaded via dynamic imports, drastically accelerating the CLI's boot time.
- **Atomic CI/CD Deployments:** Bundles are now compiled into a temporary `magepack_build` directory, followed by an atomic folder swap. This guarantees zero downtime and eliminates 404 errors during live production deployments.
- **Terser Minification Strategy:** Introduced `safe` and `aggressive` minification modes for granular control over payload reduction.
- **Terser Security Auto-Fallback:** Added regex detection (`SENSITIVE_PATTERNS`) that automatically downgrades the minification strategy to `safe` for sensitive core libraries (jQuery, Knockout, Stripe, PayPal) to prevent fatal execution errors (`$ is undefined`, missing parentheses).
- **Transactional Isolation (Bundle Splitting):** Overhauled the `extractCommonBundle.js` logic to strictly exclude checkout and cart-related scripts from the `bundle-common.js` file, significantly reducing the payload on the homepage.
- **I/O Batching (OS Crash Prevention):** The file processor now reads dependencies in batches of 50 to prevent OS-level `EMFILE` (Too many open files) errors on large, multi-locale Magento catalogs.
- **Injected RequireJS Hook:** Directly injects `window.__magepackOrderedModules` into the Headless browser context to capture the exact execution order, resolving the classic Magento "RequireJS dependency hell".

### 🐛 Fixed
- **RequireJS Race Condition Fix:** Modified `configInjector.js` to explicitly enforce the `.min` extension within the `requirejs-config.min.js` `paths` mapping. This prevents RequireJS from accidentally attempting to load unminified files if the Magento interceptor initializes too late.
- **X11 Server Crash Fix (Headless Mode):** Reconfigured Puppeteer to natively use the lightweight Chrome Headless Shell engine (`headless: 'shell'`). The `-d` (debug) CLI flag was decoupled from Chrome's visual UI mode, preventing "Unable to open X display" crashes on monitorless SSH Linux servers.
- **Infinite XHR Loops Fix:** The `waitForNetworkStability` function now explicitly ignores external tracking pixels (Google Analytics, Facebook, etc.) to prevent the crawler from hanging indefinitely on unresolved 3rd-party requests.

### 🔒 Security
- Removed the vulnerable and memory-unstable WebAssembly dependency (`@oneidentity/zstd-js`) in favor of the host operating system's native executable.
