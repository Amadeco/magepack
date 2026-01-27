import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs'; // Les streams doivent venir de fs standard
import path from 'path';
import { createRequire } from 'module';
import { createGzip, createBrotliCompress, constants } from 'zlib'; // CRITIQUE : constants doit venir de zlib
import { pipeline } from 'stream/promises';
import { minify } from 'terser';
import consola from 'consola';

import moduleWrapper from './bundle/moduleWrapper.js';
import createPathResolver from './bundle/moduleMapResolver.js';
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';

/**
 * Parses "Vendor/Theme" into { vendor, name }.
 *
 * @param {string} theme
 * @returns {{vendor: string, name: string}}
 */
const parseTheme = (theme) => {
    const [vendor, name] = String(theme || '').split('/');
    if (!vendor || !name) {
        throw new Error(`Invalid theme format "${theme}". Expected "Vendor/Theme".`);
    }
    return { vendor, name };
};

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
 * Robust logic to handle plugins (text!) and standard JS files.
 * * @param {string} rootDir - Base directory (locale path).
 * @param {string} moduleName - The RequireJS module ID.
 * @param {string} modulePath - Module path (absolute or relative).
 * @param {boolean} isMinified - Target environment state (looking for input files).
 * @returns {Promise<string>} The verified absolute path.
 */
const resolveFile = async (rootDir, moduleName, modulePath, isMinified) => {
    // 1. Resolve absolute path
    const fullPath = path.resolve(rootDir, modulePath);

    // 2. PLUGINS & STATIC FILES
    // We trust the path for text! plugins and explicit static extensions.
    const isStatic = moduleName.startsWith('text!') || 
                     moduleName.startsWith('domReady!') || 
                     /\.(html|json|css|txt)$/i.test(fullPath);

    if (isStatic) {
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch (e) {
            // Warn but don't fail hard for text resources, they might be virtual/aliased
            throw new Error(`Static resource not found: ${fullPath}`);
        }
    }

    // 3. JAVASCRIPT RESOLUTION
    // For anything else, we assume it's a JS module.
    // We strip any existing .js extension to correctly handle .min.js or plain .js
    const basePath = fullPath.endsWith('.js') ? fullPath.slice(0, -3) : fullPath;

    const minifiedPath = basePath + '.min.js';
    const standardPath = basePath + '.js';

    // Priority: strict minified if requested, otherwise standard
    const primaryPath = isMinified ? minifiedPath : standardPath;
    const fallbackPath = isMinified ? standardPath : minifiedPath;

    try {
        await fs.access(primaryPath);
        return primaryPath;
    } catch (e) {
        // Robustness: If strictly looking for .min.js but not found, try .js
        // (Solves "Skipping" errors for vendor libs that lack minified versions in prod)
        try {
            await fs.access(fallbackPath);
            return fallbackPath;
        } catch (e2) {
            throw new Error(`JS Module not found: ${primaryPath} (nor fallback ${fallbackPath})`);
        }
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
    // Fix: Respect the --minify option for output filename
    const isAggressiveStrategy = options.minifyStrategy === 'aggressive';
    const shouldMinifyOutput = options.minify || isAggressiveStrategy;
    
    // If we are minifying output, we append .min.js
    const ext = shouldMinifyOutput ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${ext}`;
    const destPath = path.join(localePath, 'js', 'magepack', bundleFilename);
    
    // Check input state (are source files minified?)
    const isSystemMinified = checkMinifyOn([localePath]);
    const resolveMap = createPathResolver(localePath, isSystemMinified);

    let bundleContent = '';
    let successCount = 0;
    const moduleNames = Object.keys(bundle.modules);

    for (const moduleName of moduleNames) {
        const rawModulePath = bundle.modules[moduleName];
        try {
            const mappedPath = resolveMap(rawModulePath);
            const absolutePath = await resolveFile(localePath, moduleName, mappedPath, isSystemMinified);
            
            const content = await fs.readFile(absolutePath, 'utf-8');
            bundleContent += moduleWrapper(moduleName, content) + '\n';
            successCount++;
        } catch (e) {
            // Debug level for skips to avoid cluttering CI/CD logs unless verbose
            consola.warn(`Skipping ${moduleName} in ${bundle.name}: ${e.message}`);
        }
    }

    // Minification Logic
    let finalContent = bundleContent;

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
        // Explicitly log where the file is written
        consola.success(`Generated ${bundleFilename} at ${destPath}`);
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

export default async (configPath, globPattern, sourcemap, minifyFlag, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const config = require(path.resolve(process.cwd(), configPath));
    
    validateConfig(config);

    const options = { glob: globPattern, sourcemap, minify: minifyFlag, minifyStrategy };
    const locales = await getLocales(process.cwd());

    let filteredLocales = locales;

    if (theme) {
        const target = parseTheme(theme);
        filteredLocales = locales.filter((l) => l.vendor === target.vendor && l.name === target.name);
    
        if (filteredLocales.length === 0) {
            throw new Error(`No locales found for theme ${target.vendor}/${target.name}.`);
        }
    }

    consola.info(`Processing ${locales.length} locales...`);
    const startTime = process.hrtime();

    consola.info(`Processing ${filteredLocales.length} locales...`);

    const localesPaths = filteredLocales.map(l =>
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
