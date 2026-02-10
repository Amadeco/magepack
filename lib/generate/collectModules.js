/**
 * @file lib/generate/collectModules.js
 * @description Scrapes the browser environment to retrieve the list of loaded RequireJS modules.
 */

import { waitForNetworkStability } from './waitForNetworkStability.js';

/**
 * Collects all defined RequireJS modules on a given page context.
 *
 * This function orchestrates the retrieval of module paths by:
 * 1. Waiting for RequireJS availability.
 * 2. Scrolling down to trigger lazy-loaded scripts (IntersectionObserver).
 * 3. Waiting for network stability (scripts loading).
 * 4. Respecting the exact execution order captured by the 'configurePage' hook.
 *
 * @param {import('puppeteer').Page} page - The Puppeteer page instance to scrape.
 * @returns {Promise<Object<string, string>>} A promise resolving to an object mapping module names to their relative paths.
 */
const collectModules = async (page) => {
    // 1. Wait for global RequireJS object availability (Safe Timeout added).
    try {
        await page.waitForFunction(() => typeof window.require === 'function', { timeout: 5000 });
    } catch (e) {
        throw new Error('RequireJS not detected on page. Ensure the page loads correctly.');
    }

    // 2. AUTO-SCROLL: Trigger lazy-loaded content (Sliders, Analytics, Menus)
    // We insert this BEFORE the network wait to ensure we capture the resulting requests.
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300; // Scroll chunk
            const maxScroll = 15000; // Safety limit
            
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                // Stop if we reached bottom OR limit
                if (totalHeight >= scrollHeight || totalHeight >= maxScroll) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });

    // 3. Intelligent Wait: Use Magento's internal 'rjsResolver'
    // Added safety timeout race to prevent hanging if resolver fails.
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                const timeoutId = setTimeout(resolve, 5000); // 5s Failsafe
                
                if (typeof require !== 'function') {
                    clearTimeout(timeoutId);
                    resolve();
                    return;
                }

                require(['rjsResolver'], (resolver) => {
                    if (resolver) {
                        resolver(() => {
                            clearTimeout(timeoutId);
                            resolve();
                        });
                    } else {
                        clearTimeout(timeoutId);
                        resolve();
                    }
                }, (err) => {
                    clearTimeout(timeoutId);
                    resolve();
                });
            })
    );

    // 4. CPU Idle Wait (Safe check for browser compatibility)
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                if ('requestIdleCallback' in window) {
                    requestIdleCallback(resolve, { timeout: 2000 });
                } else {
                    setTimeout(resolve, 500);
                }
            })
    );

    // 5. Safety Buffer: Wait for new scripts triggered by scroll to finish loading
    await waitForNetworkStability(page, {
        idleMs: 900,
        timeoutMs: 20000, // Kept your 20s preference
        includeResourceTypes: new Set(['script', 'xhr', 'fetch']),
    });

    /**
     * Extracts modules from the browser context.
     */
    const modules = await page.evaluate((excludedList) => {
        function extractBaseUrl(requireInstance) {
            const baseUrl = requireInstance.toUrl('');
            return baseUrl.replace(/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/$/, '/');
        }

        function stripBaseUrl(baseUrl, moduleUrl) {
            if (!moduleUrl.startsWith(baseUrl)) return moduleUrl;
            return moduleUrl
                .substring(baseUrl.length)
                .replace(/^[^/]+\/[^/]+\/[^/]+\/[^/]+\//, '');
        }

        const stripPlugin = (moduleName) => moduleName.replace(/^[^!].+!/, '');

        const baseUrl = extractBaseUrl(require);
        
        // Context Setup
        const unbundledContext = require.s.newContext('magepack_resolver');
        const defConfig = require.s.contexts._.config;

        // --- FIX: PREVENT DOUBLE MAPPING ---
        // We do NOT include 'map: defConfig.map' here.
        // Since we are resolving module names that are already finalized/normalized,
        // re-applying the map would cause recursive resolution errors.
        unbundledContext.configure({
            baseUrl: defConfig.baseUrl,
            paths: defConfig.paths,
            shim: defConfig.shim,
            config: defConfig.config
        });
        // -----------------------------------

        const collected = {};
        const excludedList = window.__MAGEPACK_EXCLUSIONS__ || [];

        // --- FEATURE: EXECUTION ORDER PRESERVATION ---
        // Retrieve the exact loading order captured by the hook in 'configurePage.js'.
        const capturedOrder = window.__magepackOrderedModules || [];
        const definedRegistry = window.require.s.contexts._.defined;
        const registryKeys = Object.keys(definedRegistry);
        const capturedSet = new Set(capturedOrder);

        const orderedModuleNames = [
            ...capturedOrder,
            ...registryKeys.filter(key => !capturedSet.has(key))
        ];

        orderedModuleNames.forEach((moduleName) => {
            // Safety check: ensure the module actually exists
            if (!Object.prototype.hasOwnProperty.call(definedRegistry, moduleName)) return;
    
            // Filter Plugins & External Protocols
            if (
                (moduleName.includes('!') && !moduleName.startsWith('text!')) ||
                moduleName.match(/^(https?:)?\/\//)
            ) {
                return;
            }
    
            // Skip explicitly excluded modules (Prefix & Exact Match)
            const isExcluded = excludedList.some(rule => {
                return moduleName === rule || moduleName.startsWith(rule);
            });
    
            if (isExcluded) return;
    
            // Resolve the physical path using the unbundled context
            collected[moduleName] = stripBaseUrl(
                baseUrl,
                unbundledContext.require.toUrl(stripPlugin(moduleName))
            );
        });

        return collected;
    }, excludedModules);

    return modules;
};

export default collectModules;
