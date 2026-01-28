import excludedModules from './excludedModules.js';
import { waitForNetworkStability } from './waitForNetworkStability.js';

/**
 * Collects all defined RequireJS modules on a given page.
 *
 * This function orchestrates the retrieval of module paths by:
 * 1. Waiting for RequireJS and all dependencies to fully load.
 * 2. Injecting a script into the browser context to map module names to their paths.
 * 3. Respecting the exact execution order captured by the 'configurePage' hook.
 *
 * @param {import('puppeteer').Page} page - The Puppeteer page instance to scrape.
 * @returns {Promise<Object.<string, string>>} A promise resolving to an object mapping module names to their relative paths.
 */
const collectModules = async (page) => {
    // 1. Wait for global RequireJS object availability.
    await page.waitForFunction(() => window.require);

    // 2. Intelligent Wait: Use Magento's internal 'rjsResolver' to ensure dependencies are resolved.
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                require(['rjsResolver'], (resolver) => {
                    resolver(() => resolve());
                });
            })
    );

    // 3. CPU Idle Wait: Wait for the browser main thread to settle.
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                requestIdleCallback(resolve);
            })
    );

    // 4. Safety Buffer: Extra 5s wait for delayed scripts (e.g., trackers, async widgets).
    await waitForNetworkStability(page, {
        idleMs: 900,
        timeoutMs: 20000,
        includeResourceTypes: new Set(['script', 'xhr', 'fetch']),
    });

    const modules = await page.evaluate((excludedModules) => {
        /**
         * Extracts the base URL from the RequireJS configuration.
         * @param {Object} require - The global require object.
         * @returns {string} The normalized base URL.
         */
        function extractBaseUrl(require) {
            const baseUrl = require.toUrl('');
            return baseUrl.replace(/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/$/, '/');
        }

        /**
         * Strips the base URL from a full module path to get the relative path.
         * @param {string} baseUrl - The base URL.
         * @param {string} moduleUrl - The full URL of the module.
         * @returns {string} The relative path.
         */
        function stripBaseUrl(baseUrl, moduleUrl) {
            if (!moduleUrl.startsWith(baseUrl)) {
                return moduleUrl;
            }
            return moduleUrl
                .substring(baseUrl.length)
                .replace(/^[^/]+\/[^/]+\/[^/]+\/[^/]+\//, '');
        }

        /**
         * Removes loader plugins from the module name (e.g. "text!file.html" -> "file.html").
         * @param {string} moduleName - The module name with potential plugins.
         * @returns {string} The clean module path.
         */
        const stripPlugin = (moduleName) => moduleName.replace(/^[^!].+!/, '');

        const baseUrl = extractBaseUrl(require);
        const unbundledContext = require.s.newContext('magepack');

        // Configure a separate context to resolve real paths without affecting the main context.
        const defConfig = require.s.contexts._.config;

        // --- FIX: PREVENT DOUBLE MAPPING ---
        // We do NOT include 'map: defConfig.map' here.
        // Since we are resolving module names that are already finalized/normalized (captured via onResourceLoad),
        // re-applying the map would cause recursive resolution errors (e.g., vimeo -> vimeo/player -> vimeo/player/player).
        unbundledContext.configure({
            baseUrl: defConfig.baseUrl,
            paths: defConfig.paths,
            shim: defConfig.shim,
            config: defConfig.config
        });
        // -----------------------------------

        const modules = {};

        // --- FEATURE: EXECUTION ORDER PRESERVATION ---
        // Retrieve the exact loading order captured by the hook in 'configurePage.js'.
        // This ensures the bundle respects the browser's actual dependency execution chain.
        const capturedOrder = window.__magepackOrderedModules || [];
        const definedRegistry = window.require.s.contexts._.defined;
        const registryKeys = Object.keys(definedRegistry);

        // Create a Set for O(1) lookup performance
        const capturedSet = new Set(capturedOrder);

        // Merge Strategy:
        // 1. Captured Order (Strict topological sort from RequireJS events)
        // 2. Remaining Registry Keys (Safety net for modules defined but missed by the hook)
        const orderedModuleNames = [
            ...capturedOrder,
            ...registryKeys.filter(key => !capturedSet.has(key))
        ];
        // ---------------------------------------------

        orderedModuleNames.forEach(
            (moduleName) => {
                // Safety check: ensure the module actually exists in the final registry
                if (!Object.prototype.hasOwnProperty.call(definedRegistry, moduleName)) {
                    return;
                }
        
                // Ignore plugins (except text!) and external URLs (CDN, http/https)
                if (
                    (moduleName.includes('!') &&
                        !moduleName.startsWith('text!')) ||
                    moduleName.match(/^(https?:)?\/\//)
                ) {
                    return;
                }
        
                // --- MODIFICATION START ---
                // Skip explicitly excluded modules (supports exact match AND prefix/folder match)
                const isExcluded = excludedModules.some(rule => {
                    // 1. Exact match (e.g. 'mixins', 'require')
                    if (moduleName === rule) return true;
                    // 2. Prefix match (e.g. 'Magento_Paypal/') to exclude full directories
                    if (moduleName.startsWith(rule)) return true;
                    
                    return false;
                });
        
                if (isExcluded) {
                    return;
                }
                // --- MODIFICATION END ---
        
                // Resolve the physical path using the unbundled context
                modules[moduleName] = stripBaseUrl(
                    baseUrl,
                    unbundledContext.require.toUrl(stripPlugin(moduleName))
                );
            }
        );

        return modules;
    }, excludedModules);

    return modules;
};

export default collectModules;
