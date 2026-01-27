import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { createGzip, createBrotliCompress, constants } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { minify } from 'terser';
import consola from 'consola';

import moduleWrapper from './bundle/moduleWrapper.js';
import createPathResolver from './bundle/moduleMapResolver.js';
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';

/**
 * Validates the generated configuration structure.
 * @param {Array<Object>} config
 */
const validateConfig = (config) => {
    if (!Array.isArray(config)) {
        throw new Error('Magepack config should be an array of bundle definitions.');
    }
};

/**
 * Core Logic: Resolves the physical file path based on strict environment rules.
 * Follows Magento 2 standards:
 * - Dev Mode: path/to/file.js
 * - Prod Mode: path/to/file.min.js
 * * @param {string} rootDir - Base directory (locale path).
 * @param {string} modulePath - Module path (can be absolute from resolver or relative).
 * @param {boolean} isMinified - Target environment state.
 * @returns {Promise<string>} The verified absolute path.
 * @throws {Error} If file cannot be found.
 */
const resolveFile = async (rootDir, modulePath, isMinified) => {
    // 1. Normalize: Remove .js extension to work with a raw "Module ID" concept
    // We explicitly do NOT use path.extname() to avoid treating .cookie or .min as extensions.
    const baseName = modulePath.replace(/\.js$/, '');

    // 2. Determine Strategy: What extension are we strictly looking for?
    let targetExtension = '.js';
    
    if (isMinified) {
        // If we want minified, we look for .min.js
        // UNLESS the file is already explicitly minified in its name (e.g., 'lazyload.min')
        targetExtension = baseName.endsWith('.min') ? '.js' : '.min.js';
    }

    // 3. Construct Path
    // FIX: Use path.resolve instead of path.join.
    // If 'baseName' is absolute (provided by moduleMapResolver), 'rootDir' is ignored.
    // If 'baseName' is relative, it is correctly appended to 'rootDir'.
    const targetPath = path.resolve(rootDir, baseName + targetExtension);
    const fallbackPath = path.resolve(rootDir, baseName + '.js');

    // 4. Verify Existence (Robustness)
    // We prioritize the Strict Target. If missing (edge case: vendor file not minified), we fall back.
    try {
        await fs.access(targetPath);
        return targetPath;
    } catch (e) {
        // Fallback: If strict minified file is missing, try the standard .js version
        // This prevents build failure if a specific module lacks a minified version.
        if (isMinified && targetPath !== fallbackPath) {
            try {
                await fs.access(fallbackPath);
                consola.debug(`Fallback used for ${path.basename(baseName)}: Found .js instead of .min.js`);
                return fallbackPath;
            } catch (e2) {
                // Ignore, throw original error below
            }
        }
        throw new Error(`File not found: ${targetPath}`);
    }
};

// ... (Rest of the file remains unchanged: compressFile, processBundle, etc.)
// Just make sure processBundle calls resolveFile correctly (it already does).
// The key logic change is purely inside resolveFile to handle absolute paths correctly.

/**
 * Compresses a file using Gzip and Brotli (Parallel I/O).
 * @param {string} filePath 
 */
const compressFile = async (filePath) => {
    // ... (Implementation unchanged)
    const source = createReadStream(filePath);
    const gzip = pipeline(
        source, 
        createGzip({ level: constants.Z_BEST_COMPRESSION }), 
        createWriteStream(`${filePath}.gz`)
    );

    const brotliSource = createReadStream(filePath);
    const brotli = pipeline(
        brotliSource, 
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                [constants.BROTLI_PARAM_LGWIN]: 24,
            },
        }), 
        createWriteStream(`${filePath}.br`)
    );

    await Promise.all([gzip, brotli]);
};

/**
 * Processes a single bundle.
 * @param {Object} bundle 
 * @param {string} localePath 
 * @param {Object} options 
 */
const processBundle = async (bundle, localePath, options) => {
    const bundleFilename = `bundle-${bundle.name}.js`;
    const destPath = path.join(localePath, 'js', 'magepack', bundleFilename);
    
    // Environment Context
    const isSystemMinified = checkMinifyOn([localePath]);
    const resolveMap = createPathResolver(localePath, isSystemMinified);

    let bundleContent = '';
    let successCount = 0;
    const moduleNames = Object.keys(bundle.modules);

    for (const moduleName of moduleNames) {
        const rawModulePath = bundle.modules[moduleName];
        try {
            // 1. Resolve logical path (This returns an ABSOLUTE path now, as per SRP)
            const mappedPath = resolveMap(rawModulePath);

            // 2. Resolve physical path (Handles extension check without double-joining)
            const absolutePath = await resolveFile(localePath, mappedPath, isSystemMinified);
            
            // 3. Read & Wrap
            const content = await fs.readFile(absolutePath, 'utf-8');
            bundleContent += moduleWrapper(moduleName, content) + '\n';
            successCount++;

        } catch (e) {
            consola.warn(`Skipping ${moduleName} in ${bundle.name}: ${e.message}`);
        }
    }

    // ... (Minification and writing logic unchanged)
    
    // Minification Output Logic
    let finalContent = bundleContent;
    const isAggressiveStrategy = options.minifyStrategy === 'aggressive';
    const shouldMinifyOutput = options.minify || isAggressiveStrategy;

    if (shouldMinifyOutput && bundleContent.length > 0) {
        try {
            const result = await minify(bundleContent, {
                ecma: 2017,
                toplevel: true,
                compress: {
                    drop_console: isAggressiveStrategy,
                    drop_debugger: true,
                    passes: 2,
                    pure_funcs: isAggressiveStrategy ? ['console.info', 'console.debug', 'console.warn'] : []
                },
                mangle: {
                    reserved: ['mage', 'varien', 'require', 'define', 'ko', 'observable']
                }
            });
            if (result.code) finalContent = result.code;
        } catch (err) {
            consola.error(`Minification error in ${bundle.name}:`, err);
        }
    }

    // Write & Compress
    if (successCount > 0) {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, finalContent);
        await compressFile(destPath);
        consola.success(`Generated ${bundleFilename} (${successCount} modules)`);
    } else {
        consola.warn(`Empty bundle ${bundleFilename} - Skipped writing.`);
    }
};

// ... (rest of the file: generateRequireConfig, default export) ...

const generateRequireConfig = async (bundles, localePath) => {
    const configPath = path.join(localePath, 'js', 'magepack', 'requirejs-config-common.js');
    const bundlesConfig = {};
    const deps = [];

    bundles.forEach((bundle) => {
        bundlesConfig[`magepack/bundle-${bundle.name}`] = Object.keys(bundle.modules);
    });

    if (bundles.some(b => b.name === 'vendor')) deps.push('magepack/bundle-vendor');
    if (bundles.some(b => b.name === 'common')) deps.push('magepack/bundle-common');

    const content = `require.config({ deps: ${JSON.stringify(deps)}, bundles: ${JSON.stringify(bundlesConfig)} });`;
    await fs.writeFile(configPath, content);
};

export default async (configPath, globPattern, sourcemap, minifyFlag, minifyStrategy) => {
    const require = createRequire(import.meta.url);
    const config = require(path.resolve(process.cwd(), configPath));
    
    validateConfig(config);

    const options = { glob: globPattern, sourcemap, minify: minifyFlag, minifyStrategy };
    const locales = await getLocales(process.cwd());

    consola.info(`Processing ${locales.length} locales...`);
    const startTime = process.hrtime();

    const localesPaths = locales.map(l => 
        path.join(process.cwd(), 'pub', 'static', 'frontend', l.vendor, l.name, l.code)
    );

    for (const localePath of localesPaths) {
        const name = path.basename(localePath);
        consola.start(`Bundling: ${name}`);
        
        try {
            await Promise.all(config.map(b => processBundle(b, localePath, options)));
            await generateRequireConfig(config, localePath);
        } catch (e) {
            consola.error(`Error in ${name}:`, e);
        }
    }

    const [sec] = process.hrtime(startTime);
    consola.success(`Done in ${sec}s.`);
};
