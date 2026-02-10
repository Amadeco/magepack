/**
 * @file lib/bundle.js
 * @description Double-Loading Fix: "Clean ID + Implicit Resolution" Strategy with Atomic Swapping
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter modules based on the exclusion list.
 * @param {Array} bundles - The list of bundles to process.
 * @param {Array} exclusions - The list of module prefixes to exclude.
 * @returns {Array} The filtered bundles.
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
 * Prepares the temporary build directory.
 * @param {string} localePath 
 * @returns {Promise<string>} The path to the build directory.
 */
const prepareBuildDirectory = async (localePath) => {
    const buildDir = path.join(localePath, 'magepack_build');
    try {
        // Clean up any leftovers from a failed previous run
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
 * @param {string} localePath 
 * @param {string} buildDir 
 */
const finalizeBuild = async (localePath, buildDir) => {
    const finalDir = path.join(localePath, 'magepack');
    const backupDir = path.join(localePath, 'magepack_backup');

    try {
        // Step 1: Check if 'magepack' exists. If so, rename it to 'magepack_backup'
        let previousExists = false;
        try {
            await fs.access(finalDir);
            previousExists = true;
        } catch { /* ignore */ }

        if (previousExists) {
            // Remove any old backup if it exists for some reason
            await fs.rm(backupDir, { recursive: true, force: true });
            await fs.rename(finalDir, backupDir);
        }

        // Step 2: Promote build directory to production 'magepack'
        await fs.rename(buildDir, finalDir);

        // Step 3: Remove backup (Cleanup)
        if (previousExists) {
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    } catch (e) {
        consola.error(`❌ Atomic swap failed for ${localePath}.`);
        consola.error(`   Detailed error: ${e.message}`);
        throw e; // Critical failure
    }
};

/**
 * Generates the RequireJS configuration.
 * @param {Array} config - The bundle configuration.
 * @returns {string} The RequireJS config string.
 */
const buildRequireConfigContent = (config) => {
    const bundles = {};
    const paths = {};
    
    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        // 1. Standard Logical ID (e.g., 'magepack/bundle-vendor')
        const bundleId = `magepack/bundle-${bundle.name}`;
        
        // 2. Abstract Physical Path (e.g., 'magepack/bundle-vendor')
        const bundlePath = `magepack/bundle-${bundle.name}`;

        const moduleNames = Array.isArray(bundle.modules) 
            ? bundle.modules 
            : Object.keys(bundle.modules);

        // Module normalization
        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
        
        // 3. Explicit Mapping
        paths[bundleId] = bundlePath;
    });

    return `require.config({
    bundles: ${JSON.stringify(bundles)},
    paths: ${JSON.stringify(paths)}
});`;
};

async function injectConfigIntoMain(localePath, newConfigContent) {
    const targets = ['requirejs-config.js', 'requirejs-config.min.js'];
    
    for (const fileName of targets) {
        const mainConfigPath = path.join(localePath, fileName);
        const label = path.basename(mainConfigPath);

        try {
            await fs.access(mainConfigPath);
            
            let mainConfig = await fs.readFile(mainConfigPath, 'utf8');
            const startMarker = '/* MAGEPACK START */';
            const endMarker = '/* MAGEPACK END */';
            
            const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
            mainConfig = mainConfig.replace(cleanRegex, '');

            const injection = `${startMarker}${newConfigContent}${endMarker}`;
            const finalContent = `${mainConfig.trim()};\n${injection}`;

            await fs.writeFile(mainConfigPath, finalContent, 'utf8');
            consola.success(`   ✅ Config injected into: ${label}`);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                consola.warn(`   ⚠️  Injection failed for ${label}: ${e.message}`);
            }
        }
    }
}

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
        // We pass 'buildDir' as the output destination
        await Promise.all(
            config.map(bundle => processBundle(bundle, localePath, buildDir, options, isMinifyOn))
        );

        // 3. SWAP: Atomic replacement of the old folder with the new one
        await finalizeBuild(localePath, buildDir);

        // 4. CONFIG: Generate and inject configuration
        const configContent = buildRequireConfigContent(config);
        await injectConfigIntoMain(localePath, configContent);

    } catch (e) {
        consola.error(`❌ Failed to process ${label}:`, e);
        throw e;
    }
}

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

    // Apply exclusion rules
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
        consola.success(`✨ All locales bundled successfully in ${totalSec}s.`);
    }
};
