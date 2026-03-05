/**
 * @file lib/bundle/processor.js
 * @description Handles the reading, wrapping, minification, and compression of individual bundles.
 *
 * This module implements the core Bundle Processing Pipeline:
 *   Read → Minify HTML → Wrap (AMD) → Minify JS (Terser) → Write → Compress → Prune
 *
 * Optimized for Magento 2.4.8+ with:
 *   - Batched I/O (50 files per chunk) to prevent OS-level EMFILE errors.
 *   - Automatic strategy downgrade for sensitive payment/core libraries.
 *   - Concurrent Gzip, Brotli, and Zstandard static compression.
 *   - Strict dependency auditing mode for CI/CD integrity checks.
 *   - Ghost module pruning to prevent RequireJS resolution deadlocks.
 *
 * @module bundle/processor
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.0.1: Updated `createPathResolver` call to `await` the now-async factory,
 *     aligning with the migration of `moduleMapResolver.js` to `fs/promises`.
 *   - v3.0.1: Populated `SENSITIVE_PATTERNS` with documented regex patterns for
 *     jQuery, KnockoutJS, Stripe, PayPal, and Braintree libraries. Previously empty,
 *     which rendered the automatic safe-mode downgrade feature completely inert.
 *   - v3.0.1: Added ghost module pruning. Modules declared in `bundle.modules` but
 *     missing on disk are now removed from the bundle configuration object after
 *     processing. This prevents `configInjector.js` from declaring modules in
 *     `require.config({bundles:...})` that don't actually exist in the bundle file,
 *     which caused RequireJS to consider them "loaded" and never fetch them
 *     individually — resulting in undefined templates and broken UI components
 *     (e.g., `Owebia_Opickup/opickup-shipping-information` template load failure).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { minify as minifyJs } from 'terser';
import { minify as minifyHtml } from 'html-minifier-terser';

import moduleWrapper, { isText } from './moduleWrapper.js';
import createPathResolver from './moduleMapResolver.js';
import { buildTerserOptions } from './config/terserOptions.js';
import { compressFile } from './service/compressor.js';
import { reportBundleSize } from './service/reporter.js';

/**
 * Sensitive module patterns that break when aggressively mangled by Terser.
 *
 * When a bundle contains modules matching any of these patterns, the minification
 * strategy is automatically downgraded from 'aggressive' to 'safe' to prevent
 * fatal runtime errors such as:
 *   - `$ is undefined` (jQuery global reference destroyed)
 *   - Missing parentheses in KnockoutJS binding expressions
 *   - Broken payment gateway callbacks (Stripe, PayPal, Braintree)
 *
 * These patterns are intentionally broad (prefix-based) to catch all sub-modules
 * within each library ecosystem.
 *
 * @type {RegExp[]}
 */
const SENSITIVE_PATTERNS = [
    /^jquery\//i,
    /^jquery$/i,
    /^knockoutjs\//i,
    /^ko\//i,
    /^stripe/i,
    /^Stripe_/i,
    /^paypal/i,
    /^PayPal_/i,
    /^Magento_Paypal\//i,
    /^braintree/i,
    /^Magento_Braintree\//i,
    /^Amazon_Pay/i,
    /^Adyen_/i,
    /^fotorama\//i
];

/**
 * Splits an array into smaller chunks to prevent memory and I/O thrashing.
 *
 * Used to batch file read operations and avoid exceeding the OS file descriptor
 * limit (`EMFILE: too many open files`), which is common on large multi-locale
 * Magento catalogs with thousands of modules.
 *
 * @param {Array<any>} arr - The array to split.
 * @param {number} size - The maximum size of each chunk.
 * @returns {Array<Array<any>>} An array of chunked sub-arrays.
 */
const chunkArray = (arr, size) =>
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
        arr.slice(i * size, i * size + size)
    );

/**
 * Resolves a module file on disk with intelligent fallback between `.js` and `.min.js`.
 *
 * Resolution strategy:
 *   1. Static resources (HTML, JSON, CSS, TXT, SVG): returned as-is if they exist.
 *   2. JavaScript files: primary target is determined by `isMinifyOn`, with automatic
 *      fallback to the alternate extension if the primary is missing.
 *
 * @async
 * @param {string} rootDir - The base directory to resolve from (e.g., locale path).
 * @param {string} moduleName - The RequireJS module ID (e.g., `Magento_Ui/js/core/app`).
 * @param {string} modulePath - The relative mapped path from the version resolver.
 * @param {boolean} isMinifyOn - Whether minification fallback is active.
 * @returns {Promise<string|null>} Absolute path to the file, or null if not found.
 */
const resolveFile = async (rootDir, moduleName, modulePath, isMinifyOn) => {
    const fullPath = path.resolve(rootDir, modulePath);

    // Static resources are returned as-is (no .min variant)
    if (moduleName.startsWith('text!') || /\.(html|json|css|txt|svg)$/i.test(fullPath)) {
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {
            return null;
        }
    }

    // JS Resolution Strategy: try primary target first, then fallback
    const basePath = fullPath.replace(/\.(min\.)?js$/, '');
    const minifiedPath = `${basePath}.min.js`;
    const standardPath = `${basePath}.js`;

    const primary = isMinifyOn ? minifiedPath : standardPath;
    const fallback = isMinifyOn ? standardPath : minifiedPath;

    try {
        await fs.access(primary);
        return primary;
    } catch {
        try {
            await fs.access(fallback);
            return fallback;
        } catch {
            return null;
        }
    }
};

/**
 * Core Bundle Processor Function.
 *
 * Implements the full pipeline for a single bundle:
 *   1. **Read**: Batch-read module files from disk (50 per chunk).
 *   2. **Minify HTML**: Pre-minify KnockoutJS `.html` templates before wrapping.
 *   3. **Wrap**: Apply AMD wrapper to non-AMD, anonymous AMD, and text modules.
 *   4. **Prune**: Remove missing modules from `bundle.modules` (ghost module prevention).
 *   5. **Minify JS**: Run Terser with strategy-aware configuration.
 *   6. **Write**: Output the concatenated/minified bundle to the build directory.
 *   7. **Compress**: Generate `.gz`, `.br`, and `.zst` static compressed variants.
 *
 * **Ghost Module Prevention (v3.0.1):**
 * After processing, any module declared in `bundle.modules` that was not found on disk
 * is removed from the bundle configuration object. This is critical because `configInjector.js`
 * uses `bundle.modules` to generate `require.config({bundles:...})`. If a missing module
 * remains declared, RequireJS considers it "provided" by the bundle and never attempts
 * to load it individually — causing `undefined` template errors and broken UI components
 * (e.g., `Owebia_Opickup/opickup-shipping-information` template load failure).
 *
 * @async
 * @param {Object} bundle - The bundle configuration object. **Mutated in place** to remove
 *   modules that were not found on disk.
 * @param {string} bundle.name - The bundle identifier (e.g., 'cms', 'vendor', 'common').
 * @param {Object<string, string>} bundle.modules - Map of module names to their relative paths.
 *   Entries for missing modules are deleted after processing.
 * @param {string} localePath - Source directory for resolving modules (locale static path).
 * @param {string} outputDir - Destination directory for generated bundles.
 * @param {Object} options - CLI options passed from the bundling command.
 * @param {boolean} [options.minify] - Force JavaScript minification.
 * @param {string} [options.minifyStrategy='safe'] - Minification strategy: 'safe' or 'aggressive'.
 * @param {boolean} [options.sourcemap] - Generate `.map` source map files.
 * @param {boolean} [options.strict] - Fail immediately if a mapped module is missing.
 * @param {boolean} [options.fastCompression] - Use lower compression levels for faster builds.
 * @param {boolean} isMinifyOn - True if minification is globally active for this locale.
 * @returns {Promise<void>}
 */
export const processBundle = async (bundle, localePath, outputDir, options, isMinifyOn) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;

    const destDir = outputDir;
    const destPath = path.join(destDir, bundleFilename);

    // Await the async path resolver factory (reads and parses requirejs-map.js)
    const resolveMap = await createPathResolver(localePath, isMinifyOn);
    const moduleNames = Object.keys(bundle.modules || {});

    /** @type {Record<string, string>} Map for Terser input (filename -> content) */
    const sources = {};

    /**
     * Set of module names that were successfully read, wrapped, and included
     * in the bundle output. Used for ghost module pruning after processing.
     * @type {Set<string>}
     */
    const includedModules = new Set();

    /**
     * Set of module names that were declared but not found on disk.
     * These will be removed from `bundle.modules` after processing to prevent
     * `configInjector.js` from declaring them in the RequireJS bundle config.
     * @type {Set<string>}
     */
    const missingModules = new Set();

    // --- STEP 1: Batched Reading, HTML Minification & Wrapping ---
    // Read files in chunks of 50 to prevent EMFILE (Too many open files) OS errors
    const BATCH_SIZE = 50;
    const moduleChunks = chunkArray(moduleNames, BATCH_SIZE);

    for (const chunk of moduleChunks) {
        await Promise.all(chunk.map(async (moduleName) => {
            try {
                const rawModulePath = bundle.modules[moduleName];
                const mappedPath = resolveMap(rawModulePath);
                const absPath = await resolveFile(localePath, moduleName, mappedPath, isMinifyOn);

                // Module not found on disk
                if (!absPath) {
                    if (options.strict) {
                        throw new Error(`[Strict Mode] Module "${moduleName}" is missing at path: ${mappedPath}`);
                    }

                    // Track the missing module for pruning and log with appropriate severity
                    missingModules.add(moduleName);

                    // Templates and text resources get a visible warning since they cause
                    // UI component failures (broken KO bindings, missing templates)
                    if (isText(moduleName, mappedPath)) {
                        consola.warn(`⚠️  [${bundle.name}] Text resource missing: "${moduleName}" → ${mappedPath}`);
                    } else {
                        consola.debug(`   [${bundle.name}] Module missing: "${moduleName}" → ${mappedPath}`);
                    }
                    return;
                }

                let content = await fs.readFile(absPath, 'utf8');

                // Performance Optimization: Minify HTML/Knockout templates before wrapping
                if (isText(moduleName, absPath) && absPath.endsWith('.html')) {
                    try {
                        content = await minifyHtml(content, {
                            collapseWhitespace: true,
                            removeComments: true,
                            // CRITICAL: Must preserve Magento Knockout JS bindings!
                            // e.g., <!-- ko if: isVisible() --> ... <!-- /ko -->
                            ignoreCustomComments: [/^\s*ko/, /^\s*\/ko/],
                            keepClosingSlash: true
                        });
                    } catch (e) {
                        consola.warn(`⚠️  Could not minify HTML for ${moduleName}, using raw text.`);
                    }
                }

                // Apply AMD Wrapper to ensure non-AMD libs work inside the bundle
                const wrappedContent = moduleWrapper(moduleName, content, absPath);

                // Use relative path for accurate source maps
                const relativeSourcePath = path.relative(destDir, absPath);
                sources[relativeSourcePath] = wrappedContent;
                includedModules.add(moduleName);
            } catch (e) {
                // If we are in strict mode, crash the build. Otherwise, log and continue.
                if (options.strict) {
                    throw e;
                }

                missingModules.add(moduleName);
                consola.debug(`   [${bundle.name}] Failed to process "${moduleName}": ${e.message}`);
            }
        }));
    }

    // --- STEP 2: Ghost Module Pruning ---
    // Remove modules that were declared in the config but not found on disk.
    // This prevents configInjector.js from declaring them in require.config({bundles:...}),
    // which would cause RequireJS to consider them "loaded" and never fetch them individually.
    // This is the root cause of "Failed to load template" errors for third-party extensions
    // whose files may not exist during the bundling phase.
    if (missingModules.size > 0) {
        for (const moduleName of missingModules) {
            delete bundle.modules[moduleName];
        }

        consola.info(
            `   [${bundle.name}] Pruned ${missingModules.size} missing module(s) from bundle declaration.`
        );
    }

    if (includedModules.size === 0) {
        consola.warn(`⚠️  Skipping empty bundle: ${bundleFilename}`);
        return;
    }

    // --- STEP 3: JS Minification Configuration ---
    let finalContent = '';

    // Safety check: detect sensitive modules (e.g., payment gateways, core jQuery)
    // and automatically downgrade to 'safe' Terser strategy to prevent fatal runtime errors
    const hasSensitive = moduleNames.some(name => SENSITIVE_PATTERNS.some(p => p.test(name)));
    const requestedStrategy = options.minifyStrategy || 'safe';

    // Downgrade strategy if sensitive modules are detected
    const effectiveStrategy = hasSensitive ? 'safe' : requestedStrategy;

    if (hasSensitive && requestedStrategy === 'aggressive') {
        consola.debug(`   🛡️  [${bundle.name}] Safe mode enforced (sensitive modules detected).`);
    }

    const shouldMinify = Boolean(options.minify) || effectiveStrategy === 'aggressive';
    const sourceMap = Boolean(options.sourcemap);

    // --- STEP 4: Terser JS Processing ---
    if (shouldMinify || sourceMap) {
        try {
            const terserOptions = buildTerserOptions(effectiveStrategy, sourceMap, bundleFilename);

            // If minification is strictly OFF but sourceMap is ON, disable compression rules
            if (!shouldMinify) {
                terserOptions.compress = false;
                terserOptions.mangle = false;
                terserOptions.format = { beautify: true };
            }

            const result = await minifyJs(sources, terserOptions);

            if (result.code) {
                finalContent = result.code;
                if (sourceMap && result.map) {
                    await fs.writeFile(`${destPath}.map`, result.map, 'utf8');
                }
            }
        } catch (err) {
            consola.error(`❌ Minification failed for ${bundle.name}. Writing raw output. Error: ${err.message}`);
            finalContent = Object.values(sources).join('\n');
        }
    } else {
        // Fast concatenation if no minification is required
        finalContent = Object.values(sources).join('\n');
    }

    // --- STEP 5: Write & Compress (Parallel) ---
    // Ensure output directory exists
    await fs.mkdir(destDir, { recursive: true });

    // Write the JavaScript bundle file
    await fs.writeFile(destPath, finalContent, 'utf8');

    // Generate static compressed variants (Gzip, Brotli, Zstandard) concurrently
    await compressFile(destPath, options);

    // Report file sizes and compression savings
    await reportBundleSize(destPath);
};
