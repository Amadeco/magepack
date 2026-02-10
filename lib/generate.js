import puppeteer from 'puppeteer';
import { stringify } from 'javascript-stringify';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import logger from './utils/logger.js';
import * as collectors from './generate/collector/index.js';
import extractCommonBundle from './generate/extractCommonBundle.js';
import defaultExclusions from './generate/excludedModules.js';

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

    // --- CONFIGURATION LOADING STRATEGY ---
    const configPath = path.resolve('magepack.config.js');
    let userExclusions = [];
    let existingConfig = {};

    if (fs.existsSync(configPath)) {
        try {
            const require = createRequire(import.meta.url);
            existingConfig = require(configPath);
            
            // Support both Object (new) and Array (legacy) formats
            if (!Array.isArray(existingConfig) && existingConfig.exclusions) {
                userExclusions = existingConfig.exclusions;
                logger.info(`Loaded ${userExclusions.length} custom exclusions from config.`);
            }
        } catch (e) {
            logger.warn(`Could not load existing config: ${e.message}`);
        }
    }

    // Merge defaults with user config
    const combinedExclusions = [...defaultExclusions, ...userExclusions];
    // --------------------------------------

    logger.info(`Starting generation with timeout: ${generationConfig.timeout}s`);
    logger.info('Launching Puppeteer browser...');

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
        // Mobile-First Viewport Configuration (Pixel 5/Generic Mobile)
        // Crucial for collecting mobile-specific JS/CSS logic in Magento.
        defaultViewport: { 
            width: 412, 
            height: 732,
            isMobile: true,
            hasTouch: true
        },
        ignoreHTTPSErrors: true,
    });

    // Create a clean browser context to isolate cookies/storage if needed.
    const browserContext = await browser.createBrowserContext();

    // Create a mutable copy of collectors to manage the execution list.
    const activeCollectors = { ...collectors };

    if (generationConfig.skipCheckout) {
        delete activeCollectors['checkout'];
    }

    logger.info('Collecting bundle modules via Mobile Viewport...');

    let bundles = [];

    /**
     * Iterate over collectors sequentially using for...of.
     * * STRICT REQUIREMENT: We avoid .forEach() to ensure proper async/await flow control
     * and error handling. If one collector crashes, we can catch it cleanly without 
     * unhandled promise rejections.
     */
    for (const [name, collectorFn] of Object.entries(activeCollectors)) {
        // Ensure we are executing a valid collector function
        if (typeof collectorFn === 'function') {
            try {
                logger.debug(`Starting collector: ${name}`);
                
                const bundle = await collectorFn(
                    browserContext, 
                    { 
                        ...generationConfig, 
                        timeout,
                        exclusions: combinedExclusions
                    }
                );
                
                bundles.push(bundle);
            } catch (error) {
                // Log the error but rethrow to stop generation (integrity check)
                // or handle gracefully depending on severity. Here we stop to ensure config validity.
                logger.error(`Collector "${name}" failed with error:`);
                logger.error(error);
                await browser.close();
                process.exit(1);
            }
        }
    }

    logger.debug('Finished collection, closing the browser.');

    await browser.close();

    logger.debug('Extracting common modules into shared bundle...');

    // Extract modules shared across bundles to reduce redundancy (DRY output).
    bundles = extractCommonBundle(bundles);

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

    // Prepare the new configuration object
    const newConfig = Array.isArray(existingConfig) ? {} : existingConfig;
    newConfig.bundles = bundles;
    
    // Explicitly persist user exclusions if they exist
    if (userExclusions.length > 0) {
        newConfig.exclusions = userExclusions;
    }
    
    fs.writeFileSync(
        outputPath,
        `module.exports = ${stringify(newConfig, null, '  ')};`
    );
    
    logger.info(`Configuration saved to: ${outputPath}`);
};
