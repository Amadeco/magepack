/**
 * @file lib/bundle/processor.js
 * @description Handles the reading, wrapping, minification, and compression of individual bundles.
 * @author Amadeco Dev Team
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { minify } from 'terser';

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
 * * @param {string} rootDir 
 * @param {string} moduleName 
 * @param {string} modulePath 
 * @param {boolean} isMinifyOn 
 * @returns {Promise<string>} Absolute path
 */
const resolveFile = async (rootDir, moduleName, modulePath, isMinifyOn) => {
    const fullPath = path.resolve(rootDir, modulePath);
    
    // Static resources are returned as-is
    if (moduleName.startsWith('text!') || /\.(html|json|css|txt|svg)$/i.test(fullPath)) {
        await fs.access(fullPath);
        return fullPath;
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
        await fs.access(fallback);
        return fallback;
    }
};

/**
 * Core Bundle Processor Function.
 * Uses the Pipeline Pattern: Read -> Wrap -> Minify -> Write -> Compress.
 * * @param {Object} bundle 
 * @param {string} localePath 
 * @param {Object} options 
 * @param {boolean} isMinifyOn 
 */
export const processBundle = async (bundle, localePath, options, isMinifyOn) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;
    const destDir = path.join(localePath, 'magepack');
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
            
            const content = await fs.readFile(absPath, 'utf8');
            
            // Apply AMD Wrapper to ensure non-AMD libs work inside the bundle
            const wrappedContent = moduleWrapper(moduleName, content, absPath);

            // Use relative path for source maps
            const relativeSourcePath = path.relative(destDir, absPath);
            sources[relativeSourcePath] = wrappedContent;
            successCount++;
        } catch (e) {
            // Log debug only to keep console clean, warn only if critical
            // consola.debug(`   Warning: Module "${moduleName}" missing in ${bundle.name}.`);
        }
    }));

    if (successCount === 0) {
        consola.warn(`⚠️  Skipping empty bundle: ${bundleFilename}`);
        return;
    }

    // --- STEP 2: Minification Configuration ---
    let finalContent = '';
    
    // Safety check for payment gateways
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
            consola.error(`❌ Minification failed for ${bundle.name}. Writing raw output.`);
            finalContent = Object.values(sources).join('\n');
        }
    } else {
        // Fast concat if no minification needed
        finalContent = Object.values(sources).join('\n');
    }

    // --- STEP 4: Write & Compress (Parallel) ---
    // Ensure directory exists
    await fs.mkdir(destDir, { recursive: true });

    // Write JS file
    await fs.writeFile(destPath, finalContent, 'utf8');
    
    // Generate Gzip (.gz) and Brotli (.br) versions
    await compressFile(destPath);
    
    // Report savings
    await reportBundleSize(destPath);
};
