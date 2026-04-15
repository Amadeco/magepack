import puppeteer from 'puppeteer';
import { stringify } from 'javascript-stringify';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import logger from './utils/logger.js';
import { FILES } from './utils/constants.js';
import * as collectors from './generate/collector/index.js';
import extractCommonBundle from './generate/extractCommonBundle.js';

/**
 * Generates the Magepack bundling configuration by launching a Puppeteer browser
 * and visiting specific storefront pages to collect RequireJS dependencies.
 *
 * This module acts as the central orchestrator. It initializes the browser instance
 * with mobile-first settings and iterates through defined collectors (CMS, Category, Product, Checkout).
 *
 * @param {Object} generationConfig - The configuration object from the CLI.
 * @param {string} generationConfig.cmsUrl - URL of the CMS page to scan.
 * @param {string} generationConfig.categoryUrl - URL of the Category page to scan.
 * @param {string} generationConfig.productUrl - URL of the Product page to scan.
 * @param {string} [generationConfig.authUsername] - HTTP Basic Auth username (optional).
 * @param {string} [generationConfig.authPassword] - HTTP Basic Auth password (optional).
 * @param {string|number} generationConfig.timeout - Global timeout for browser operations in seconds.
 * @param {boolean} [generationConfig.skipCheckout] - Whether to skip the checkout bundle generation.
 * @returns {Promise<void>} Resolves when the configuration file has been written to disk.
 */
export default async (generationConfig) => {
    // Parse timeout to milliseconds, ensuring it is an integer.
    const timeout = parseInt(generationConfig.timeout, 10) * 1000;

    /**
     * Determine headless mode for Puppeteer v24+.
     * - 'shell': The new performant headless mode (formerly 'new'), ideal for CI/Server environments.
     * - false: Spawns a full visible browser (useful for debugging if MAGEPACK_HEADFUL is set).
     */
    const isHeadless = process.env.MAGEPACK_HEADFUL ? false : 'shell';

    
    // Mobile-First Viewport Configuration (Pixel 5/Generic Mobile)
    // Crucial for collecting mobile-specific JS/CSS logic in Magento.
    const isDesktop = generationConfig.desktop === true;
    const viewportConfig = isDesktop ? {
        width: 1920,
        height: 1080,
        isMobile: false,
        hasTouch: false
    } : {
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
    };

    logger.info(`Starting generation with timeout: ${generationConfig.timeout}s`);
    logger.info(`Viewport mode: ${isDesktop ? 'Desktop (1920x1080)' : 'Mobile (412x732)'}`);
    logger.info('Launching Puppeteer browser...');

    // --- 1. PERSISTENCE STRATEGY (Safety Check) ---
    // We read the existing config to preserve 'exclusions', 'selectors', and
    // (in --merge mode) the existing 'bundles' array.
    const configPath = path.resolve(FILES.MAGEPACK_CONFIG);
    let preservedExclusions = [];
    let customSelectors = {};
    let preservedBundles = [];

    if (fs.existsSync(configPath)) {
        try {
            const require = createRequire(import.meta.url);
            const existingConfig = require(configPath);

            // Check for modern object format
            if (!Array.isArray(existingConfig)) {
                if (Array.isArray(existingConfig.exclusions)) {
                    preservedExclusions = existingConfig.exclusions;
                    logger.info(`Preserving ${preservedExclusions.length} existing exclusion rules.`);
                }

                // Load custom selectors if present
                if (existingConfig.selectors) {
                    customSelectors = existingConfig.selectors;
                    logger.info(`Loaded custom selector overrides from config.`);
                }

                // In merge mode, preserve existing bundles so we can merge into them.
                if (generationConfig.merge && Array.isArray(existingConfig.bundles)) {
                    preservedBundles = existingConfig.bundles;
                    logger.info(`Merge mode: preserving ${preservedBundles.length} existing bundle(s).`);
                }
            }
        } catch (e) {
            logger.warn(`Could not read existing config to preserve settings: ${e.message}`);
        }
    }

    // Merge custom selectors into the generation config
    generationConfig.selectors = customSelectors;

    /**
     * @type {import('puppeteer').Browser}
     */
    const browser = await puppeteer.launch({
        headless: isHeadless,
        args: [
            // Required for Docker/CI environments to prevent permission issues
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // Prevents /dev/shm crashes on low-memory containers (Docker default is 64MB)
            '--disable-dev-shm-usage',
            // Disabling GPU hardware acceleration for headless stability
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote'
        ],
        defaultViewport: viewportConfig,
        ignoreHTTPSErrors: true,
    });

    // Create a clean browser context to isolate cookies/storage if needed.
    const browserContext = await browser.createBrowserContext();

    // Create a mutable copy of collectors to manage the execution list.
    const activeCollectors = { ...collectors };

    // --only <bundles>: restrict to comma-separated collector names (e.g. "cms" or "cms,category").
    // Supersedes the removed --skip-checkout flag (use --only cms,category,product instead).
    if (generationConfig.only) {
        const allowedNames = new Set(
            generationConfig.only.split(',').map(s => s.trim().toLowerCase())
        );
        for (const name of Object.keys(activeCollectors)) {
            if (typeof activeCollectors[name] === 'function' && !allowedNames.has(name)) {
                delete activeCollectors[name];
                logger.info(`Skipping collector "${name}" (not in --only list).`);
            }
        }
    }

    logger.info('Collecting bundle modules...');

    let bundles = [];

    // Split collectors into two execution groups:
    //   - parallel: cms, category, product — fully independent, run concurrently.
    //   - sequential: checkout — must run AFTER parallel phase because it needs
    //     a populated cart (product page + add-to-cart) to navigate to checkout.
    const { SEQUENTIAL_COLLECTORS } = collectors;
    const parallelEntries = [];
    const sequentialEntries = [];

    for (const [name, collectorFn] of Object.entries(activeCollectors)) {
        if (typeof collectorFn !== 'function') continue;
        (SEQUENTIAL_COLLECTORS.has(name) ? sequentialEntries : parallelEntries).push([name, collectorFn]);
    }

    // --- PARALLEL PHASE ---
    if (parallelEntries.length > 0) {
        logger.info(`Running ${parallelEntries.length} collector(s) in parallel: ${parallelEntries.map(([n]) => n).join(', ')}`);

        const parallelResults = await Promise.allSettled(
            parallelEntries.map(([name, collectorFn]) =>
                collectorFn(browserContext, { ...generationConfig, timeout })
                    .then(result => ({ name, result }))
            )
        );

        for (const settled of parallelResults) {
            if (settled.status === 'rejected') {
                logger.error('A parallel collector failed:');
                logger.error(settled.reason);
                await browser.close();
                process.exit(1);
            }
            const { name, result } = settled.value;
            logger.debug(`Collector "${name}" completed.`);
            if (Array.isArray(result)) {
                bundles.push(...result);
            } else {
                bundles.push(result);
            }
        }
    }

    // --- SEQUENTIAL PHASE (checkout) ---
    for (const [name, collectorFn] of sequentialEntries) {
        try {
            logger.debug(`Starting sequential collector: ${name}`);
            const result = await collectorFn(browserContext, { ...generationConfig, timeout });
            if (Array.isArray(result)) {
                bundles.push(...result);
            } else {
                bundles.push(result);
            }
        } catch (error) {
            logger.error(`Collector "${name}" failed with error:`);
            logger.error(error);
            await browser.close();
            process.exit(1);
        }
    }

    logger.debug('Finished collection, closing the browser.');

    await browser.close();

    if (generationConfig.merge && preservedBundles.length > 0) {
        logger.info('Merge mode: deduplicating against existing vendor/common bundles...');

        // Build a set of all module names already covered by existing bundles.
        // This prevents the same module appearing in both an existing bundle and a new one.
        const existingModuleSet = new Set();
        preservedBundles.forEach(b => Object.keys(b.modules).forEach(m => existingModuleSet.add(m)));

        // Strip already-covered modules from newly collected bundles.
        bundles.forEach(bundle => {
            let removed = 0;
            Object.keys(bundle.modules).forEach(m => {
                if (existingModuleSet.has(m)) {
                    delete bundle.modules[m];
                    removed++;
                }
            });
            if (removed > 0) {
                logger.info(`  [${bundle.name}] Removed ${removed} module(s) already in existing bundles.`);
            }
        });

        // Merge: replace existing bundle of same name, append truly new ones.
        const newBundleMap = new Map(bundles.map(b => [b.name, b]));
        const existingNames = new Set(preservedBundles.map(b => b.name));

        const mergedBundles = preservedBundles.map(b =>
            newBundleMap.has(b.name) ? newBundleMap.get(b.name) : b
        );
        bundles.forEach(b => {
            if (!existingNames.has(b.name)) mergedBundles.push(b);
        });

        bundles = mergedBundles;
        logger.success(`Merge complete. Total bundles: ${bundles.length}`);
    } else {
        logger.debug('Extracting common modules into shared bundle...');
        // Extract modules shared across bundles to reduce redundancy (DRY output).
        bundles = extractCommonBundle(bundles);
    }

    logger.success('Generation complete. Outputting the following bundles:');

    bundles.forEach((bundle) => {
        logger.success(
            `${bundle.name} - ${Object.keys(bundle.modules).length} modules.`
        );
    });

    /**
     * Write the final configuration to `magepack.config.js`.
     * Uses synchronous write to ensure CLI process doesn't exit before IO completion.
     */
    const outputPath = path.resolve('magepack.config.js');

    // --- 2. CONSTRUCT FINAL OUTPUT ---
    const finalConfig = {
        bundles: bundles
    };

    // Only add exclusions key if we actually have some, to keep config clean
    if (preservedExclusions.length > 0) {
        finalConfig.exclusions = preservedExclusions;
    }

    // Persist custom selectors if they were used/loaded
    if (Object.keys(customSelectors).length > 0) {
        finalConfig.selectors = customSelectors;
    }

    fs.writeFileSync(
        outputPath,
        `module.exports = ${stringify(finalConfig, null, '  ')};`
    );
    
    logger.info(`Configuration saved to: ${outputPath}`);
};
