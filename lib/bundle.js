import fs from 'fs/promises';
import path from 'path';
import { createGzip, createBrotliCompress, constants } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { minify } from 'terser';
import consola from 'consola';

import moduleWrapper from './bundle/moduleWrapper.js';
import pathResolver from './bundle/pathResolver.js';
import getLocales from './bundle/getLocales.js';

/**
 * Validates the generated configuration before processing.
 *
 * @param {Array} config - The configuration array loaded from magepack.config.js.
 * @throws {Error} If configuration is invalid.
 */
const validateConfig = (config) => {
    if (!Array.isArray(config)) {
        throw new Error('Magepack config should be an array of bundles.');
    }
};

/**
 * Compresses a file using Gzip and Brotli algorithms in parallel.
 *
 * @param {string} filePath - The absolute path to the source file.
 * @returns {Promise<void>}
 */
const compressFile = async (filePath) => {
    const source = createReadStream(filePath);

    const gzipTask = pipeline(
        source,
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );

    // Re-create stream for Brotli as streams are consumed
    const brotliSource = createReadStream(filePath);
    const brotliTask = pipeline(
        brotliSource,
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                [constants.BROTLI_PARAM_LGWIN]: 24, // Optimized window size for static assets
            },
        }),
        createWriteStream(`${filePath}.br`)
    );

    await Promise.all([gzipTask, brotliTask]);
};

/**
 * Processes a single bundle: resolves paths, concatenates content, minifies, writes, and compresses.
 *
 * @param {Object} bundle - The bundle definition object (name, modules).
 * @param {string} localePath - The path to the static content directory for the current locale.
 * @param {Object} options - CLI options (e.g., minification settings).
 * @returns {Promise<void>}
 */
const processBundle = async (bundle, localePath, options) => {
    const bundleFilename = `bundle-${bundle.name}.js`;
    const destPath = path.join(localePath, 'js', 'magepack', bundleFilename);
    
    // 1. Resolve and read all module contents
    let bundleContent = '';
    const moduleNames = Object.keys(bundle.modules);

    for (const moduleName of moduleNames) {
        const modulePath = bundle.modules[moduleName];
        try {
            const absolutePath = await pathResolver(localePath, modulePath);
            const content = await fs.readFile(absolutePath, 'utf-8');
            // Wrap the raw content to be AMD compliant (if needed)
            bundleContent += moduleWrapper(moduleName, content) + '\n';
        } catch (e) {
            consola.warn(`Skipping module ${moduleName}: ${e.message}`);
        }
    }

    // 2. Minify if requested (Aggressive Mode)
    // We use Terser to remove dead code, comments and mangle variables safely.
    let finalContent = bundleContent;
    
    // Note: We deliberately use a simplified check here.
    // In a full implementation, you might pass specific Terser options via CLI.
    const isAggressive = true; // Forced for this implementation based on user stack requirements

    if (isAggressive) {
        const result = await minify(bundleContent, {
            ecma: 2017, // Support modern browsers
            toplevel: true,
            compress: {
                drop_console: true,
                drop_debugger: true,
                passes: 2
            },
            mangle: {
                // Protect Magento global variables and Knockout keywords
                reserved: ['mage', 'varien', 'require', 'define', 'ko', 'observable']
            }
        });
        
        if (result.code) {
            finalContent = result.code;
        } else if (result.error) {
            throw result.error;
        }
    }

    // 3. Ensure directory exists and write file
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, finalContent);

    // 4. Compress (Gzip + Brotli)
    await compressFile(destPath);
};

/**
 * Generates the requirejs-config.js file to map bundles.
 *
 * @param {Array} bundles - List of processed bundles.
 * @param {string} localePath - Path to the locale directory.
 * @returns {Promise<void>}
 */
const generateRequireConfig = async (bundles, localePath) => {
    const configPath = path.join(localePath, 'js', 'magepack', 'requirejs-config.js');
    
    // 1. Build the 'bundles' configuration object
    // This tells RequireJS: "If you need module X, download bundle Y"
    const bundlesConfig = {};
    bundles.forEach((bundle) => {
        const bundleName = `magepack/bundle-${bundle.name}`;
        bundlesConfig[bundleName] = Object.keys(bundle.modules);
    });

    // 2. Determine dependencies (Preload Order)
    // We strictly enforce: Vendor -> Common -> Others
    const deps = [];
    
    // Check if we generated a vendor bundle
    if (bundles.some(b => b.name === 'vendor')) {
        deps.push('magepack/bundle-vendor');
    }
    
    // Check if we generated a common bundle
    if (bundles.some(b => b.name === 'common')) {
        deps.push('magepack/bundle-common');
    }

    // 3. Create the final configuration string
    const configContent = `
/**
 * Magepack RequireJS Configuration.
 * Auto-generated by Magepack.
 */
require.config({
    deps: ${JSON.stringify(deps)},
    bundles: ${JSON.stringify(bundlesConfig)}
});
`;

    await fs.writeFile(configPath, configContent);
};

/**
 * Main entry point for the bundling process.
 *
 * @param {Object} config - The bundling configuration.
 * @param {Object} options - Command line options.
 */
export default async (config, options) => {
    validateConfig(config);

    const locales = await getLocales(process.cwd());
    const localesPaths = locales.map((locale) =>
        path.join(process.cwd(), 'pub', 'static', 'frontend', locale.vendor, locale.name, locale.code)
    );

    consola.info(`Found ${locales.length} locales to process.`);

    const startTime = process.hrtime();

    // Process each locale sequentially to avoid OOM on CI environments,
    // but process bundles within a locale in parallel where possible.
    for (const localePath of localesPaths) {
        consola.start(`Bundling for locale: ${path.basename(localePath)}`);

        try {
            // 1. Process all bundles (Vendor, Common, Pages) in parallel
            await Promise.all(
                config.map((bundle) => processBundle(bundle, localePath, options))
            );

            // 2. Generate the RequireJS mapping configuration
            await generateRequireConfig(config, localePath);

            consola.success(`Bundling finished for ${path.basename(localePath)}`);
        } catch (e) {
            consola.error(`Failed to bundle locale ${path.basename(localePath)}: ${e.message}`);
            // We do not exit process here to allow other locales to try processing
        }
    }

    const [seconds] = process.hrtime(startTime);
    consola.success(`✨ Magepack bundling complete in ${seconds}s.`);
};
