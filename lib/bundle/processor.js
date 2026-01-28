// lib/bundle/processor.js
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
 * @private
 *
 * Resolve a module file on disk.
 * Handles text!/static resources and JS modules with minified fallbacks.
 *
 * @param {string} rootDir Absolute locale directory (e.g. pub/static/frontend/Vendor/Theme/fr_FR)
 * @param {string} moduleName RequireJS module ID
 * @param {string} modulePath Relative path from requirejs mapping
 * @param {boolean} isMinifyOn Whether Magento minify is ON (controls expected filenames)
 * @returns {Promise<string>} Absolute verified file path
 */
const resolveFile = async (rootDir, moduleName, modulePath, isMinifyOn) => {
    const fullPath = path.resolve(rootDir, modulePath);
    // Treat plugin resources and explicit static extensions as literal paths
    const isStatic =
        moduleName.startsWith('text!') ||
        moduleName.startsWith('domReady!') ||
        /\.(html|json|css|txt|svg)$/i.test(fullPath);
    if (isStatic) {
        await fs.access(fullPath);
        return fullPath;
    }
    // JS resolution
    const basePath = fullPath.endsWith('.js') ? fullPath.slice(0, -3) : fullPath;
    const minifiedPath = `${basePath}.min.js`;
    const standardPath = `${basePath}.js`;
    const primaryPath = isMinifyOn ? minifiedPath : standardPath;
    const fallbackPath = isMinifyOn ? standardPath : minifiedPath;
    try {
        await fs.access(primaryPath);
        return primaryPath;
    } catch {
        await fs.access(fallbackPath);
        return fallbackPath;
    }
};

/**
 * Process a single bundle: read modules, wrap, optional minify, write, compress.
 *
 * Output path is always "<localePath>/magepack/" (theme root).
 * Output suffix ".min" follows Magento minify setting (isMinifyOn).
 *
 * @param {{name: string, modules: Record<string, string>}} bundle
 * @param {string} localePath
 * @param {{minify?: boolean, minifyStrategy?: 'safe'|'aggressive', sourcemap?: boolean}} options
 * @param {boolean} isMinifyOn
 * @returns {Promise<void>}
 */
export const processBundle = async (bundle, localePath, options, isMinifyOn) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;
    const destPath = path.join(localePath, 'magepack', bundleFilename);
    const resolveMap = createPathResolver(localePath, isMinifyOn);
    const moduleNames = Object.keys(bundle.modules || {});
    
    /** @type {Record<string, string>} */
    const sources = {};
    let successCount = 0;

    for (const moduleName of moduleNames) {
        const rawModulePath = bundle.modules[moduleName];
        try {
            const mappedPath = resolveMap(rawModulePath);
            const absPath = await resolveFile(localePath, moduleName, mappedPath, isMinifyOn);
            const content = await fs.readFile(absPath, 'utf8');
            
            sources[moduleName] = moduleWrapper(moduleName, content, absPath);
            successCount++;
        } catch (e) {
            consola.warn(`Skipping ${moduleName} in ${bundle.name}: ${e.message}`);
        }
    }

    if (successCount === 0) {
        consola.warn(`Empty bundle ${bundleFilename} - Skipped writing.`);
        return;
    }

    let finalContent = '';
    const strategy = options.minifyStrategy === 'aggressive' ? 'aggressive' : 'safe';
    const shouldMinifyContent = Boolean(options.minify) || strategy === 'aggressive';
    const shouldGenerateSourceMap = Boolean(options.sourcemap);

    if (shouldMinifyContent || shouldGenerateSourceMap) {
        try {
            const terserOptions = buildTerserOptions(strategy, shouldGenerateSourceMap, bundleFilename);
            
            if (!shouldMinifyContent) {
                terserOptions.compress = false;
                terserOptions.mangle = false;
                terserOptions.format.beautify = true; 
            }

            const result = await minify(sources, terserOptions);
            
            if (result?.code) {
                finalContent = result.code;
                if (shouldGenerateSourceMap && result.map) {
                    const mapPath = `${destPath}.map`;
                    await fs.writeFile(mapPath, result.map, 'utf8');
                }
            }
        } catch (err) {
            consola.error(`Terser error in ${bundle.name} (fallback to raw concat):`, err);
            finalContent = Object.values(sources).join('\n');
        }
    } else {
        finalContent = Object.values(sources).join('\n');
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, finalContent, 'utf8');
    await compressFile(destPath);
    await reportBundleSize(destPath);
};
