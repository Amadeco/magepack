/**
 * @file lib/bundle/processor.js
 * @description Handles the reading, wrapping, minification, and compression of individual bundles.
 * @author Amadeco Dev Team
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { minify } from 'terser'; // Assuming 'terser' import based on context, user provided code had it.

// Note: Ensure these imports point to the correct relative paths as per your structure
import moduleWrapper from './moduleWrapper.js';
import createPathResolver from './moduleMapResolver.js';
import { buildTerserOptions } from './config/terserOptions.js';
import { compressFile } from './service/compressor.js';
import { reportBundleSize } from './service/reporter.js';

/**
 * Sensitive patterns that break when aggressively mangled.
 * We automatically switch to 'safe' mode for bundles containing these.
 */
const SENSITIVE_PATTERNS = [];

/**
 * Resolves a module file on disk.
 * Handles fallbacks between .js and .min.js to ensure we always find the source content.
 * @param {string} rootDir 
 * @param {string} moduleName 
 * @param {string} modulePath 
 * @param {boolean} isMinifyOn 
 * @returns {Promise<string>} Absolute path
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
 * Uses the Pipeline Pattern: Read -> Wrap -> Minify -> Write -> Compress.
 * * @param {Object} bundle 
 * @param {string} localePath - Source directory for resolving modules
 * @param {string} outputDir - Destination directory for generated bundles
 * @param {Object} options 
 * @param {boolean} isMinifyOn 
 */
export const processBundle = async (bundle, localePath, outputDir, options, isMinifyOn) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;
    
    // CHANGED: Use the explicit outputDir instead of forcing 'magepack' suffix
    const destDir = outputDir; 
    const destPath = path.join(destDir, bundleFilename);
    
    const resolveMap = createPathResolver(localePath, isMinifyOn);
    const moduleNames = Object.keys(bundle.modules || {});
    
    /** @type {Record<string, string>} Map for Terser (filename -> content) */
    const sources = {};
    let successCount = 0;

    // --- STEP 1: Parallel Reading & Wrapping ---
    // We fetch all files in parallel to maximize IO throughput
    await Promise.all(moduleNames.map(async (moduleName) => {
        try {
            const rawModulePath = bundle.modules[moduleName];
            const mappedPath = resolveMap(rawModulePath);
            const absPath = await resolveFile(localePath, moduleName, mappedPath, isMinifyOn);
            
            if (!absPath) {
                // consola.debug(`Warning: Module "${moduleName}" missing in ${bundle.name}.`);
                return;
            }
            
            const content = await fs.readFile(absPath, 'utf8');
            
            // Apply AMD Wrapper to ensure non-AMD libs work inside the bundle
            const wrappedContent = moduleWrapper(moduleName, content, absPath);

            // Use relative path for source maps
            const relativeSourcePath = path.relative(destDir, absPath);
            sources[relativeSourcePath] = wrappedContent;
            successCount++;
        } catch (e) {
             consola.debug(`Warning: Failed to process "${moduleName}" in ${bundle.name}: ${e.message}`);
        }
    }));

    if (successCount === 0) {
        consola.warn(`⚠️  Skipping empty bundle: ${bundleFilename}`);
        return;
    }

    // --- STEP 2: Minification Configuration ---
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

    // --- STEP 3: Terser Processing ---
    if (shouldMinify || sourceMap) {
        // Need to verify sources is not empty or handle Terser errors
        try {
            const terserOptions = buildTerserOptions(effectiveStrategy, sourceMap, bundleFilename);
            
            // If minification is strictly OFF but sourceMap is ON, disable compression
            if (!shouldMinify) {
                terserOptions.compress = false;
                terserOptions.mangle = false;
                terserOptions.format = { beautify: true };
            }

            const result = await minify(sources, terserOptions);
            
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
        // Fast concat if no minification needed
        finalContent = Object.values(sources).join('\n');
    }

    // --- STEP 4: Write & Compress (Parallel) ---
    // Ensure directory exists (it should be created by the caller, but safety first)
    await fs.mkdir(destDir, { recursive: true });

    // Write JS file
    await fs.writeFile(destPath, finalContent, 'utf8');
    
    // Generate Gzip (.gz) and Brotli (.br) versions
    await compressFile(destPath);
    
    // Report savings
    await reportBundleSize(destPath);
};
