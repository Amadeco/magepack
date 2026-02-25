/**
 * @file lib/bundle/processor.js
 * @description Handles the reading, wrapping, minification, and compression of individual bundles.
 * Optimized for Magento 2.4.8+ with concurrency controls and strict auditing.
 * @author Amadeco Dev Team
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
 * Sensitive patterns that break when aggressively mangled.
 * We automatically switch to 'safe' mode for bundles containing these.
 * @type {RegExp[]}
 */
const SENSITIVE_PATTERNS = [];

/**
 * Splits an array into smaller chunks to prevent memory/IO thrashing.
 * * @param {Array<any>} arr - The array to split.
 * @param {number} size - The maximum size of each chunk.
 * @returns {Array<Array<any>>} An array of chunked arrays.
 */
const chunkArray = (arr, size) => 
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
        arr.slice(i * size, i * size + size)
    );

/**
 * Resolves a module file on disk.
 * Handles fallbacks between `.js` and `.min.js` to ensure we always find the source content.
 * * @param {string} rootDir - The base directory to resolve from (e.g., locale path).
 * @param {string} moduleName - The RequireJS module ID.
 * @param {string} modulePath - The relative mapped path.
 * @param {boolean} isMinifyOn - Whether minification fallback is active.
 * @returns {Promise<string|null>} Absolute path to the file, or null if not found.
 */
const resolveFile = async (rootDir, moduleName, modulePath, isMinifyOn) => {
    const fullPath = path.resolve(rootDir, modulePath);
    
    // Static resources are returned as-is
    if (moduleName.startsWith('text!') || /\.(html|json|css|txt|svg)$/i.test(fullPath)) {
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {
            return null; // Handle missing static files gracefully
        }
    }

    // JS Resolution Strategy
    const basePath = fullPath.replace(/\.(min\.)?js$/, '');
    const minifiedPath = `${basePath}.min.js`;
    const standardPath = `${basePath}.js`;

    // Try primary target first, then fallback
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
            return null; // File not found
        }
    }
};

/**
 * Core Bundle Processor Function.
 * Uses the Pipeline Pattern: Read -> Minify HTML -> Wrap -> Minify JS -> Write -> Compress.
 * * @param {Object} bundle - The bundle configuration object (name, modules).
 * @param {string} localePath - Source directory for resolving modules.
 * @param {string} outputDir - Destination directory for generated bundles.
 * @param {Object} options - CLI options (minify, strict, fastCompression, sourcemap).
 * @param {boolean} isMinifyOn - True if minification is globally active.
 * @returns {Promise<void>}
 */
export const processBundle = async (bundle, localePath, outputDir, options, isMinifyOn) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;
    
    const destDir = outputDir; 
    const destPath = path.join(destDir, bundleFilename);
    
    const resolveMap = createPathResolver(localePath, isMinifyOn);
    const moduleNames = Object.keys(bundle.modules || {});
    
    /** @type {Record<string, string>} Map for Terser (filename -> content) */
    const sources = {};
    let successCount = 0;

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
                
                // Strict Dependency Auditing
                if (!absPath) {
                    if (options.strict) {
                        throw new Error(`[Strict Mode] Module "${moduleName}" is missing at path: ${mappedPath}`);
                    } else {
                        // Silent failure fallback (Legacy mode)
                        // consola.debug(`Warning: Module "${moduleName}" missing in ${bundle.name}.`);
                        return;
                    }
                }
                
                let content = await fs.readFile(absPath, 'utf8');

                // Performance Optimization: Minify HTML/Knockout templates before wrapping
                if (isText(moduleName, absPath) && absPath.endsWith('.html')) {
                    try {
                        content = await minifyHtml(content, {
                            collapseWhitespace: true,
                            removeComments: true,
                            // CRITICAL: Must preserve Magento Knockout JS bindings!
                            ignoreCustomComments: [/^\s*ko/, /^\s*\/ko/], 
                            keepClosingSlash: true
                        });
                    } catch (e) {
                        consola.warn(`⚠️ Could not minify HTML for ${moduleName}, using raw text.`);
                    }
                }
                
                // Apply AMD Wrapper to ensure non-AMD libs work inside the bundle
                const wrappedContent = moduleWrapper(moduleName, content, absPath);

                // Use relative path for accurate source maps
                const relativeSourcePath = path.relative(destDir, absPath);
                sources[relativeSourcePath] = wrappedContent;
                successCount++;
            } catch (e) {
                // If we are in strict mode, crash the build. Otherwise, log and continue.
                if (options.strict) {
                    throw e; 
                } else {
                    consola.debug(`Warning: Failed to process "${moduleName}" in ${bundle.name}: ${e.message}`);
                }
            }
        }));
    }

    if (successCount === 0) {
        consola.warn(`⚠️  Skipping empty bundle: ${bundleFilename}`);
        return;
    }

    // --- STEP 2: JS Minification Configuration ---
    let finalContent = '';
    
    // Safety check for sensitive modules (e.g. payments)
    const hasSensitive = moduleNames.some(name => SENSITIVE_PATTERNS.some(p => p.test(name)));
    const requestedStrategy = options.minifyStrategy || 'safe';
    
    // Downgrade strategy if sensitive modules are detected
    const effectiveStrategy = hasSensitive ? 'safe' : requestedStrategy;
    
    if (hasSensitive && requestedStrategy === 'aggressive') {
        consola.debug(`   🛡️  [${bundle.name}] Safe mode enforced (sensitive modules).`);
    }

    const shouldMinify = Boolean(options.minify) || effectiveStrategy === 'aggressive';
    const sourceMap = Boolean(options.sourcemap);

    // --- STEP 3: Terser JS Processing ---
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

    // --- STEP 4: Write & Compress (Parallel) ---
    // Ensure directory exists
    await fs.mkdir(destDir, { recursive: true });

    // Write JS file
    await fs.writeFile(destPath, finalContent, 'utf8');
    
    // Generate Gzip (.gz) and Brotli (.br) versions
    // Passing options allows the compressor to utilize the --fast-compression flag
    await compressFile(destPath, options);
    
    // Report savings
    await reportBundleSize(destPath);
};
