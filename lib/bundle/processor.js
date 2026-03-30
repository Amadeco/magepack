/**
 * @file lib/bundle/processor.js
 * @description Handles the reading, wrapping, mixin composition, minification, and compression
 * of individual bundles.
 *
 * This module implements the core Bundle Processing Pipeline:
 *   Read → Minify HTML → Wrap (AMD) → **Compose Mixins** → Minify JS (Terser) → Write → Compress → Prune
 *
 * Optimized for Magento 2.4.8+ with:
 *   - Batched I/O (50 files per chunk) to prevent OS-level EMFILE errors.
 *   - **Build-time mixin pre-application** to bypass RequireJS mixins! plugin limitations.
 *   - Automatic strategy downgrade for sensitive payment/core libraries.
 *   - Concurrent Gzip, Brotli, and Zstandard static compression.
 *   - Strict dependency auditing mode for CI/CD integrity checks.
 *   - Ghost module pruning to prevent RequireJS resolution deadlocks.
 *
 * @module bundle/processor
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.1.0: Added mixin pre-application phase. When a bundle contains both a mixin
 *     target and its mixin factories, the processor now composes them into a single
 *     AMD module that returns the fully "mixined" result. The mixin factory modules
 *     are absorbed into the composite and removed from the bundle declaration, so
 *     RequireJS resolves the already-composed target without needing `require.load()`
 *     interception. This eliminates the silent mixin failure that occurred when
 *     `mixins!` plugin could not intercept bundled module resolution.
 *   - v3.0.1: Updated `createPathResolver` call to `await` the now-async factory.
 *   - v3.0.1: Populated `SENSITIVE_PATTERNS` with documented regex patterns.
 *   - v3.0.1: Added ghost module pruning.
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
import { composeMixinTarget } from './service/mixinComposer.js';

/**
 * Sensitive module patterns that break when aggressively mangled by Terser.
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
 * @async
 * @param {string} rootDir - The base directory to resolve from.
 * @param {string} moduleName - The RequireJS module ID.
 * @param {string} modulePath - The relative mapped path.
 * @param {boolean} isMinifyOn - Whether minification fallback is active.
 * @returns {Promise<string|null>} Absolute path to the file, or null if not found.
 */
const resolveFile = async (rootDir, moduleName, modulePath, isMinifyOn) => {
    const fullPath = path.resolve(rootDir, modulePath);

    if (moduleName.startsWith('text!') || /\.(html|json|css|txt|svg)$/i.test(fullPath)) {
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {
            return null;
        }
    }

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
 *   4. **Compose Mixins**: Pre-apply mixin chains on bundled targets (v3.1.0).
 *   5. **Prune**: Remove ghost modules and absorbed mixins from `bundle.modules`.
 *   6. **Minify JS**: Run Terser with strategy-aware configuration.
 *   7. **Write**: Output the concatenated/minified bundle to the build directory.
 *   8. **Compress**: Generate `.gz`, `.br`, and `.zst` static compressed variants.
 *
 * **Mixin Pre-Application (v3.1.0):**
 * After wrapping, the processor identifies modules that are mixin targets (via
 * `mixinMap`) and composes them with their mixin factories into single AMD modules.
 * The mixin factory modules are then "absorbed" — they remain physically in the
 * bundle code (as part of the composite) but are removed from `bundle.modules`
 * so `configInjector.js` does NOT declare them in `require.config({bundles:...})`.
 *
 * This is critical: if a mixin factory were declared as a bundle member,
 * RequireJS would consider it "loaded" and the `mixins!` plugin would skip it
 * on non-bundled pages, breaking the mixin chain for individual module loads.
 *
 * @async
 * @param {Object} bundle - The bundle configuration object. **Mutated in place**.
 * @param {string} bundle.name - The bundle identifier.
 * @param {Object<string, string>} bundle.modules - Map of module names to paths.
 * @param {string} localePath - Source directory for resolving modules.
 * @param {string} outputDir - Destination directory for generated bundles.
 * @param {Object} options - CLI options.
 * @param {boolean} isMinifyOn - True if minification is active for this locale.
 * @param {Map<string, import('./service/mixinResolver.js').MixinTargetInfo>} [mixinMap] -
 *   Optional mixin map for this bundle.
 * @param {Set<string>} [allMixinModuleIds] - Set of all known mixin module IDs.
 * @returns {Promise<void>}
 */
export const processBundle = async (bundle, localePath, outputDir, options, isMinifyOn, mixinMap, allMixinModuleIds) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;

    const destDir = outputDir;
    const destPath = path.join(destDir, bundleFilename);

    const resolveMap = await createPathResolver(localePath, isMinifyOn);
    const moduleNames = Object.keys(bundle.modules || {});

    /**
     * Individual module sources after wrapping.
     * Keyed by module ID for composition lookup.
     * Preserves insertion order (Map guarantee) for deterministic output.
     * @type {Map<string, string>}
     */
    const wrappedModules = new Map();

    /** @type {Set<string>} */
    const includedModules = new Set();

    /** @type {Set<string>} */
    const missingModules = new Set();

    const effectiveMixinMap = mixinMap || new Map();

    // --- STEP 1: Batched Reading, HTML Minification & Wrapping ---
    const BATCH_SIZE = 50;
    const moduleChunks = chunkArray(moduleNames, BATCH_SIZE);

    for (const chunk of moduleChunks) {
        await Promise.all(chunk.map(async (moduleName) => {
            try {
                const rawModulePath = bundle.modules[moduleName];
                const mappedPath = resolveMap(rawModulePath);
                const absPath = await resolveFile(localePath, moduleName, mappedPath, isMinifyOn);

                if (!absPath) {
                    if (options.strict) {
                        throw new Error(`[Strict Mode] Module "${moduleName}" is missing at path: ${mappedPath}`);
                    }

                    missingModules.add(moduleName);

                    if (isText(moduleName, mappedPath)) {
                        consola.warn(`⚠️  [${bundle.name}] Text resource missing: "${moduleName}" → ${mappedPath}`);
                    } else {
                        consola.debug(`   [${bundle.name}] Module missing: "${moduleName}" → ${mappedPath}`);
                    }
                    return;
                }

                let content = await fs.readFile(absPath, 'utf8');

                // HTML template minification
                if (isText(moduleName, absPath) && absPath.endsWith('.html')) {
                    try {
                        content = await minifyHtml(content, {
                            collapseWhitespace: true,
                            removeComments: true,
                            ignoreCustomComments: [/^\s*ko/, /^\s*\/ko/],
                            keepClosingSlash: true
                        });
                    } catch (e) {
                        consola.warn(`⚠️  Could not minify HTML for ${moduleName}, using raw text.`);
                    }
                }

                const wrappedContent = moduleWrapper(moduleName, content, absPath);

                wrappedModules.set(moduleName, wrappedContent);
                includedModules.add(moduleName);
            } catch (e) {
                if (options.strict) {
                    throw e;
                }

                missingModules.add(moduleName);
                consola.debug(`   [${bundle.name}] Failed to process "${moduleName}": ${e.message}`);
            }
        }));
    }

    // --- STEP 2: Mixin Pre-Application ---
    //
    // For each mixin target in this bundle, compose it with its bundled mixin
    // factories into a single AMD module. The composite `define()` replaces the
    // original target: it declares merged dependencies, executes the original
    // factory, then applies each mixin factory sequentially, returning the fully
    // composed result.
    //
    // Absorbed mixin modules are removed from the bundle output AND from
    // `bundle.modules` so that `configInjector.js` does not declare them in
    // `require.config({bundles:...})`. This is essential: if a mixin factory
    // were declared as "provided by this bundle", RequireJS would consider it
    // already loaded on ALL pages, and the `mixins!` plugin would never load
    // it individually for non-bundled resolution paths.

    /** @type {Set<string>} Mixin modules absorbed into composites */
    const absorbedMixins = new Set();

    if (effectiveMixinMap.size > 0) {
        for (const [targetId, mixinInfo] of effectiveMixinMap) {
            const targetContent = wrappedModules.get(targetId);

            if (!targetContent) {
                continue;
            }

            /** @type {Array<{ mixinId: string, wrappedContent: string }>} */
            const mixinSources = [];

            for (const mixinId of mixinInfo.bundledMixinIds) {
                const mixinContent = wrappedModules.get(mixinId);

                if (mixinContent) {
                    mixinSources.push({ mixinId, wrappedContent: mixinContent });
                } else {
                    consola.debug(
                        `   [${bundle.name}] Mixin "${mixinId}" for target "${targetId}" ` +
                        `not available in bundle. Will load via mixins! plugin at runtime.`
                    );
                }
            }

            if (mixinSources.length === 0) {
                continue;
            }

            if (mixinInfo.externalMixinIds.length > 0) {
                consola.debug(
                    `   [${bundle.name}] "${targetId}" has ${mixinInfo.externalMixinIds.length} ` +
                    `external mixin(s) that will load at runtime: ${mixinInfo.externalMixinIds.join(', ')}`
                );
            }

            const { compositeContent, absorbedMixinIds } = composeMixinTarget(
                targetId,
                targetContent,
                mixinSources
            );

            wrappedModules.set(targetId, compositeContent);
            absorbedMixinIds.forEach((id) => absorbedMixins.add(id));
        }
    }

    // Remove absorbed mixin modules from wrapped content.
    // Their code is now inlined inside the composite target — a separate
    // `define()` for them in the bundle would create a duplicate definition.
    for (const absorbedId of absorbedMixins) {
        wrappedModules.delete(absorbedId);
        includedModules.delete(absorbedId);
    }

    // --- STEP 3: Ghost Module Pruning + Absorbed Mixin Pruning ---
    const modulesToPrune = new Set([...missingModules, ...absorbedMixins]);

    if (modulesToPrune.size > 0) {
        for (const moduleName of modulesToPrune) {
            delete bundle.modules[moduleName];
        }

        const ghostCount = missingModules.size;
        const mixinCount = absorbedMixins.size;
        const parts = [];

        if (ghostCount > 0) parts.push(`${ghostCount} missing`);
        if (mixinCount > 0) parts.push(`${mixinCount} absorbed mixin(s)`);

        consola.info(
            `   [${bundle.name}] Pruned ${modulesToPrune.size} module(s) from declaration (${parts.join(', ')}).`
        );
    }

    if (wrappedModules.size === 0) {
        consola.warn(`⚠️  Skipping empty bundle: ${bundleFilename}`);
        return;
    }

    // Build Terser sources map from remaining wrapped modules.
    // CRITICAL: Each module MUST end with a semicolon to prevent ASI failures.
    // When Terser concatenates multiple sources in aggressive mode, adjacent
    // define() calls without semicolons produce `define(...)define(...)` which
    // is parsed as `define(...)(define(...))` — a function call on the return
    // value of the first define(), causing "define(...) is not a function".
    /** @type {Record<string, string>} */
    const sources = {};

    for (const [moduleName, content] of wrappedModules) {
        const trimmed = content.trimEnd();
        sources[moduleName] = trimmed.endsWith(';') ? trimmed + '\n' : trimmed + ';\n';
    }

    // --- STEP 4: JS Minification Configuration ---
    let finalContent = '';

    const hasSensitive = moduleNames.some(name => SENSITIVE_PATTERNS.some(p => p.test(name)));
    const requestedStrategy = options.minifyStrategy || 'safe';
    const effectiveStrategy = hasSensitive ? 'safe' : requestedStrategy;

    if (hasSensitive && requestedStrategy === 'aggressive') {
        consola.debug(`   🛡️  [${bundle.name}] Safe mode enforced (sensitive modules detected).`);
    }

    const shouldMinify = Boolean(options.minify) || effectiveStrategy === 'aggressive';
    const sourceMap = Boolean(options.sourcemap);

    // --- STEP 5: Terser JS Processing ---
    if (shouldMinify || sourceMap) {
        try {
            const terserOptions = buildTerserOptions(effectiveStrategy, sourceMap, bundleFilename);

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
        finalContent = Object.values(sources).join('\n');
    }

    // --- STEP 6: Write & Compress (Parallel) ---
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(destPath, finalContent, 'utf8');
    await compressFile(destPath, options);
    await reportBundleSize(destPath);
};
