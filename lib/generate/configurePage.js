import authenticate from './authenticate.js';
import blockMagepack from './blockMagepack.js';

/**
 * Configures and initializes a new Puppeteer page instance with standardized settings.
 *
 * This factory function ensures that every page used by the collectors adheres to
 * the global configuration, including:
 * - Strict timeouts for navigation and selectors.
 * - Blocking/Neutralizing of existing Magepack bundles to prevent double-bundling pollution.
 * - HTTP Basic Authentication (if credentials are provided).
 *
 * @param {import('puppeteer').BrowserContext} browserContext - The isolated browser context to create the page in.
 * @param {Object} config - The generation configuration object.
 * @param {string|number} config.timeout - Global timeout in milliseconds.
 * @param {string} [config.authUsername] - HTTP Basic Auth username.
 * @param {string} [config.authPassword] - HTTP Basic Auth password.
 * @returns {Promise<import('puppeteer').Page>} A promise that resolves to the fully configured Puppeteer Page instance.
 */
export default async (browserContext, config) => {
    const page = await browserContext.newPage();
    const exclusions = config.exclusions || [];

    // --- MAGEPACK EVOLUTION: RequireJS Hooks & Config Sanitization ---
    // We inject a script before the page loads to hook into RequireJS.
    // This allows us to:
    // 1. Record the EXACT order in which modules are fully resolved.
    // 2. Intercept 'require.config' to remove existing Magepack bundles causing deadlocks.
    await page.evaluateOnNewDocument((rules) => {
        // 1. Store exclusions globally in the browser
        window.__MAGEPACK_EXCLUSIONS__ = rules;
        
        // 2. Initialize Order Tracker
        window.__magepackOrderedModules = [];

        /**
         * Hooks into a RequireJS instance to attach listeners and sanitizers.
         * @param {Object} instance - The requirejs or require function.
         */
        const hookRequire = (instance) => {
            if (!instance || instance._magepackHooked) return;
            instance._magepackHooked = true;

            // ---------------------------------------------------------
            // 1. Capture Execution Order (onResourceLoad)
            // ---------------------------------------------------------
            const originalLoad = instance.onResourceLoad;
            instance.onResourceLoad = function (context, map, depArray) {
                // 'map.name' is the module ID (e.g., 'jquery', 'Magento_Ui/js/modal/modal').
                if (map.name) {
                    window.__magepackOrderedModules.push(map.name);
                }
                // Always call the original method to not break functionality.
                if (originalLoad) originalLoad.apply(this, arguments);
            };

            // ---------------------------------------------------------
            // 2. Intercept Configuration (Fix for "Blocking/Deadlock" issue)
            // ---------------------------------------------------------
            const originalConfig = instance.config;
            instance.config = function (cfg) {
                
                // A. Sanitize 'bundles': Remove only Magepack-related bundles
                if (cfg.bundles) {
                    Object.keys(cfg.bundles).forEach(key => {
                        // Check if the bundle key contains 'magepack' (e.g. 'magepack/bundle-common')
                        if (key.indexOf('magepack') !== -1) {
                            delete cfg.bundles[key];
                        }
                    });
                }

                // B. Sanitize 'deps': Remove global dependencies pointing to Magepack
                if (cfg.deps) {
                    cfg.deps = cfg.deps.filter(dep => {
                        // Keep everything that is NOT a magepack bundle
                        return typeof dep === 'string' && dep.indexOf('magepack') === -1;
                    });
                }

                return originalConfig.apply(this, arguments);
            };

            // Copy static properties to ensure compatibility (e.g. require.toUrl)
            Object.assign(instance.config, originalConfig);
        };

        // ---------------------------------------------------------
        // Watchers for global variables (requirejs / require)
        // ---------------------------------------------------------
        let rjs;
        Object.defineProperty(window, 'requirejs', {
            get() { return rjs; },
            set(val) { rjs = val; hookRequire(rjs); },
            configurable: true
        });

        let req;
        Object.defineProperty(window, 'require', {
            get() { return req; },
            set(val) { req = val; hookRequire(req); },
            configurable: true
        });
    }, exclusions);
    // ---------------------------------------------------

    // Set strict default timeouts for all subsequent operations on this page.
    page.setDefaultTimeout(config.timeout);
    page.setDefaultNavigationTimeout(config.timeout);

    // Prevent network requests to existing bundles (Safety net)
    await blockMagepack(page);

    // Perform authentication if credentials are provided in the config.
    if (config.authUsername && config.authPassword) {
        await authenticate(page, config.authUsername, config.authPassword);
    }

    return page;
};
