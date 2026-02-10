/**
 * @file lib/bundle.js
 * @description Main bundling orchestrator for Magepack.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

// Service Imports (SRP Compliance)
import { updateSriHashes } from './bundle/service/sriUpdater.js';
import { injectRequireConfig } from './bundle/service/configInjector.js';

/**
 * Filters out modules from bundles based on a list of exclusion prefixes.
 *
 * @param {Array<Object>} bundles - The list of bundle configurations to process.
 * @param {string[]} exclusions - An array of module name prefixes to exclude.
 * @returns {Array<Object>} The filtered list of bundles.
 */
const applyExclusions = (bundles, exclusions) => {
    if (!exclusions || exclusions.length === 0) return bundles;

    consola.info(`🛡️  Applying ${exclusions.length} exclusion rules...`);

    bundles.forEach(bundle => {
        const originalCount = Object.keys(bundle.modules).length;
        
        // Filter the modules object keys
        Object.keys(bundle.modules).forEach(moduleName => {
            const isExcluded = exclusions.some(rule => 
                moduleName === rule || moduleName.startsWith(rule)
            );

            if (isExcluded) {
                delete bundle.modules[moduleName];
            }
        });

        const newCount = Object.keys(bundle.modules).length;
        if (originalCount !== newCount) {
            consola.debug(`   - [${bundle.name}] Removed ${originalCount - newCount} modules.`);
        }
    });

    return bundles;
};

/**
 * Prepares the temporary build directory for a specific locale.
 *
 * @param {string} localePath - The absolute path to the locale's static directory.
 * @returns {Promise<string>} The absolute path to the created 'magepack_build' directory.
 */
const prepareBuildDirectory = async (localePath) => {
    const buildDir = path.join(localePath, 'magepack_build');
    try {
        await fs.rm(buildDir, { recursive: true, force: true });
        await fs.mkdir(buildDir, { recursive: true });
        return buildDir;
    } catch (e) {
        consola.error(`❌ Could not create temp directory ${buildDir}: ${e.message}`);
        throw e;
    }
};

/**
 * Performs an atomic swap of the build directory to the production directory.
 *
 * @param {string} localePath - The absolute path to the locale's static directory.
 * @param {string} buildDir - The absolute path to the temporary build directory.
 */
const finalizeBuild = async (localePath, buildDir) => {
    const finalDir = path.join(localePath, 'magepack');
    const backupDir = path.join(localePath, 'magepack_backup');

    try {
        let previousExists = false;
        try {
            await fs.access(finalDir);
            previousExists = true;
        } catch { /* ignore */ }

        if (previousExists) {
            await fs.rm(backupDir, { recursive: true, force: true });
            await fs.rename(finalDir, backupDir);
        }

        await fs.rename(buildDir, finalDir);

        if (previousExists) {
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    } catch (e) {
        consola.error(`❌ Atomic swap failed for ${localePath}.`);
        consola.error(`   Detailed error: ${e.message}`);
        throw e;
    }
};

/**
 * Processes a single locale: builds bundles, performs atomic swap, and updates config.
 *
 * @param {Object} locale - The locale object (vendor, name, code).
 * @param {Array<Object>} config - The bundle configuration.
 * @param {Object} options - CLI options (minify, sourcemap, etc.).
 */
async function processLocale(locale, config, options) {
    const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
    const label = `${locale.vendor}/${locale.name} (${locale.code})`;

    consola.start(`Bundling ${label}...`);

    try {
        // 1. PREPARE: Create temporary build directory
        const buildDir = await prepareBuildDirectory(localePath);

        const detectedMinification = await checkMinifyOn(localePath);
        const isMinifyOn = options.minify || detectedMinification;

        if (options.minify && !detectedMinification) {
            consola.info(`   [${label}] Forced minification enabled.`);
        }

        // 2. BUILD: Generate bundles into the temporary directory
        await Promise.all(
            config.map(bundle => processBundle(bundle, localePath, buildDir, options, isMinifyOn))
        );

        // 3. SWAP: Atomic replacement of the old folder with the new one
        await finalizeBuild(localePath, buildDir);

        // 4. CONFIG: Generate and inject configuration (Delegated to Service)
        await injectRequireConfig(localePath, config);

    } catch (e) {
        consola.error(`❌ Failed to process ${label}:`, e);
        throw e;
    }
}

/**
 * Main entry point for the bundling command.
 */
export default async (configPath, globPattern, sourcemap, minify, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const absConfigPath = path.resolve(process.cwd(), configPath);
    const rawConfig = require(absConfigPath);
    
    let bundles = [];
    let exclusions = [];

    if (Array.isArray(rawConfig)) {
        bundles = rawConfig;
    } else {
        bundles = rawConfig.bundles || [];
        exclusions = rawConfig.exclusions || [];
    }

    if (!bundles || bundles.length === 0) {
        consola.error("Invalid configuration: 'bundles' list is empty.");
        process.exit(1);
    }

    bundles = applyExclusions(bundles, exclusions);

    const options = { glob: globPattern, sourcemap, minify, minifyStrategy };

    let locales = await getLocales(process.cwd());
    if (theme) {
        locales = locales.filter(l => `${l.vendor}/${l.name}` === theme);
    }

    if (locales.length === 0) {
        consola.error("No locales found matching criteria.");
        return;
    }

    consola.info(`🚀 Starting Bundle Pipeline for ${locales.length} locales...`);
    const start = process.hrtime();

    const results = await Promise.allSettled(
        locales.map(locale => processLocale(locale, bundles, options))
    );

    const [sec, nanosec] = process.hrtime(start);
    const totalSec = (sec + nanosec / 1e9).toFixed(2);

    const failed = results.filter(r => r.status === 'rejected');

    if (failed.length > 0) {
        consola.error(`💀 Finished in ${totalSec}s with ${failed.length} errors.`);
        process.exit(1);
    } else {
        await updateSriHashes(locales, bundles);
        consola.success(`✨ All locales bundled successfully in ${totalSec}s.`);
    }
};
