import fs from 'fs/promises';
import { createReadStream, createWriteStream, constants } from 'fs'; // Sync imports for streams
import path from 'path';
import { createRequire } from 'module';
import { createGzip, createBrotliCompress } from 'zlib';
import { pipeline } from 'stream/promises';
import { minify } from 'terser';
import consola from 'consola';

import moduleWrapper from './bundle/moduleWrapper.js';
import createPathResolver from './bundle/moduleMapResolver.js';
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';

/**
 * Validates the generated configuration structure before processing.
 * @param {Array<Object>} config
 */
const validateConfig = (config) => {
    if (!Array.isArray(config)) {
        throw new Error('Magepack config should be an array of bundle definitions.');
    }
};

/**
 * Core Logic: Resolves the physical file path.
 * RE-IMPLEMENTATION of the logic from the old pathResolver.js provided by the user.
 * * @param {string} rootDir - Base directory (locale path).
 * @param {string} modulePath - Module path (can be absolute from resolver or relative).
 * @param {boolean} isMinified - Target environment state.
 * @returns {Promise<string>} The verified absolute path.
 */
const resolveFile = async (rootDir, modulePath, isMinified) => {
    // 1. Construct the base absolute path.
    // We use path.resolve to handle cases where moduleMapResolver returned an absolute path
    // and cases where it returned a relative path.
    let fullPath = path.resolve(rootDir, modulePath);

    // 2. Logic imported from old pathResolver.js:
    // If the file explicitly has an extension that is NOT .js (e.g., .html, .json),
    // we must NOT append .min.js or modify it.
    const ext = path.extname(fullPath);

    if (ext && ext !== '.js') {
        // e.g. "template.html" -> return as is.
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch (e) {
            throw new Error(`File not found: ${fullPath}`);
        }
    }

    // 3. Logic for JavaScript files
    // If minification is requested, we try to find the .min.js version first.
    // This replicates: isMinifyOn ? `${modulePath}.min.js` : `${modulePath}.js`;
    
    // Normalize path by stripping .js if present to avoid .js.min.js
    const basePathWithoutExt = fullPath.endsWith('.js') ? fullPath.slice(0, -3) : fullPath;
    
    // Determine priority paths
    const minifiedPath = basePathWithoutExt + '.min.js';
    const standardPath = basePathWithoutExt + '.js';

    let targetPath = isMinified ? minifiedPath : standardPath;

    try {
        await fs.access(targetPath);
        return targetPath;
    } catch (e) {
        // Fallback Logic (Robustness):
        // If we wanted .min.js but it doesn't exist (e.g. vendor file missing min version),
        // fallback to standard .js
        if (isMinified && targetPath !== standardPath) {
            try {
                await fs.access(standardPath);
                // consola.debug(`Fallback: Using .js instead of .min.js for ${path.basename(modulePath)}`);
                return standardPath;
            } catch (e2) {
                // Both missing
            }
        }
        throw new Error(`File not found: ${targetPath}`);
    }
};

/**
 * Compresses a file using Gzip and Brotli (Parallel I/O).
 * @param {string} filePath 
 */
const compressFile = async (filePath) => {
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
    
    const isSystemMinified = checkMinifyOn([localePath]);
    const resolveMap = createPathResolver(localePath, isSystemMinified);

    let bundleContent = '';
    let successCount = 0;
    const moduleNames = Object.keys(bundle.modules);

    for (const moduleName of moduleNames) {
        const rawModulePath = bundle.modules[moduleName];
        try {
            // 1. Resolve logical path via Map (Handles versioning)
            const mappedPath = resolveMap(rawModulePath);

            // 2. Resolve physical file (Handles extensions .html/.js/.min.js)
            const absolutePath = await resolveFile(localePath, mappedPath, isSystemMinified);
            
            // 3. Read & Wrap
            const content = await fs.readFile(absolutePath, 'utf-8');
            bundleContent += moduleWrapper(moduleName, content) + '\n';
            successCount++;

        } catch (e) {
            consola.warn(`Skipping ${moduleName} in ${bundle.name}: ${e.message}`);
        }
    }

    // Minification Logic (Using Terser)
    let finalContent = bundleContent;
    
    // We respect the CLI flag OR strict aggressive mode
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
