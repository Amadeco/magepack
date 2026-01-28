// lib/bundle.js
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

import consola from 'consola';
import { minify } from 'terser';

import moduleWrapper from './bundle/moduleWrapper.js';
import createPathResolver from './bundle/moduleMapResolver.js';
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';

/**
 * Base Terser Configuration.
 * Contains settings critical for Magento 2 architecture (RequireJS/KnockoutJS).
 *
 * @type {import('terser').MinifyOptions}
 */
const BASE_TERSER_CONFIG = {
    module: false,
    mangle: {
        reserved: [
            // Standard Globals
            '$', 'jQuery', 'define', 'require', 'exports', 'requirejs', 'window', 'document',
            // Magento Core
            'mage', 'Magento', 'varien', 'varienGlobal',
            // Translation / Utils
            'translate', '__', '$t',
            // KnockoutJS
            'ko', 'Knockout', 'observable', 'computed', 'observableArray'
        ],
        toplevel: false,
        safari10: true,
    },
    format: {
        comments: false,
        ascii_only: true,
        safari10: true,
        webkit: true,
    },
};

/**
 * Minification strategies.
 *
 * @type {Record<'safe'|'aggressive', import('terser').MinifyOptions>}
 */
const TERSER_STRATEGIES = {
    safe: {
        ecma: 5,
        compress: {
            passes: 1,
            drop_console: false,
            drop_debugger: true,
            pure_getters: false,
            unsafe: false,
            unsafe_proto: false,
            sequences: false,
            side_effects: false,
            keep_fnames: true,
        },
    },
    aggressive: {
        ecma: 2017,
        compress: {
            passes: 2,
            drop_console: true,
            drop_debugger: true,
            dead_code: true,
            unused: true,
            reduce_vars: true,
            booleans: true,
            conditionals: true,
            comparisons: true,
            evaluate: true,
            sequences: true,
            typeofs: true,
            pure_getters: false,
            unsafe: false,
            unsafe_proto: false,
            side_effects: true,
            keep_fnames: false,
        }
    }
};

/**
 * Format bytes into a human-readable string.
 *
 * @param {number} bytes
 * @returns {string}
 */
const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
    const units = ['B', 'KB', 'MB'];
    let i = 0;
    let value = bytes;

    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }

    const precision = i === 0 ? 0 : i === 1 ? 1 : 2;
    return `${value.toFixed(precision)} ${units[i]}`;
};

/**
 * @param {number} raw
 * @param {number} compressed
 * @returns {string}
 */
const ratio = (raw, compressed) => {
    if (raw <= 0 || compressed <= 0) return '';
    const pct = ((1 - compressed / raw) * 100);
    return ` (${pct.toFixed(1)}% saved)`;
};

/**
 * Safe stat.size reader. Returns -1 on failure.
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
const statSize = async (filePath) => {
    try {
        const st = await fs.stat(filePath);
        return st.size;
    } catch {
        return -1;
    }
};

/**
 * Make long paths readable by splitting them across lines.
 *
 * @param {string} filePath
 * @returns {string}
 */
const formatPathMultiline = (filePath) => {
    const normalized = path.normalize(filePath);

    // Prefer splitting by OS separator
    const parts = normalized.split(path.sep).filter(Boolean);

    // Keep the filename on the last line
    if (parts.length <= 4) return normalized;

    const head = parts.slice(0, 3).join(path.sep);
    const tail = parts.slice(3).join(path.sep);

    return `${path.sep}${head}${path.sep}${tail}`;
};

/**
 * Compute and return size metrics for a bundle and its compressed variants.
 *
 * @param {string} filePath
 * @returns {Promise<{raw: number, gzip: number, brotli: number}>}
 */
const getBundleSizes = async (filePath) => {
    const [raw, gzip, brotli] = await Promise.all([
        statSize(filePath),
        statSize(`${filePath}.gz`),
        statSize(`${filePath}.br`),
    ]);

    return { raw, gzip, brotli };
};

/**
 * Render a compact size report with icons.
 *
 * @param {{raw: number, gzip: number, brotli: number}} sizes
 * @returns {string}
 */
const renderSizeReport = (sizes) => {
    const raw = formatBytes(sizes.raw);
    const gz = formatBytes(sizes.gzip);
    const br = formatBytes(sizes.brotli);

    // Use a fixed layout that stays readable in CI logs
    return [
        `raw: ${raw}`,
        `gzip: ${gz}${ratio(sizes.raw, sizes.gzip)}`,
        `br: ${br}${ratio(sizes.raw, sizes.brotli)}`,
    ].join(' - ');
};

/**
 * Parse "Vendor/Theme" into an object.
 *
 * @param {string} theme
 * @returns {{vendor: string, name: string}}
 */
const parseTheme = (theme) => {
    const [vendor, name] = String(theme || '').split('/');
    if (!vendor || !name) {
        throw new Error(`Invalid theme "${theme}". Expected "Vendor/Theme".`);
    }
    return { vendor, name };
};

/**
 * Build a readable label from a Magento static locale path.
 * Expected shape: .../pub/static/frontend/<Vendor>/<Theme>/<locale>
 *
 * @param {string} localePath
 * @returns {{ vendor: string, theme: string, locale: string, label: string }}
 */
const describeLocalePath = (localePath) => {
    const normalized = path.normalize(localePath);
    const parts = normalized.split(path.sep).filter(Boolean);

    const locale = parts.at(-1) || '';
    const theme = parts.at(-2) || '';
    const vendor = parts.at(-3) || '';

    const label = vendor && theme && locale
        ? `${vendor}/${theme} · ${locale}`
        : locale || localePath;

    return { vendor, theme, locale, label };
};

/**
 * Validate the Magepack configuration structure.
 *
 * @param {unknown} config
 * @throws {Error}
 * @returns {void}
 */
const validateConfig = (config) => {
    if (!Array.isArray(config)) {
        throw new Error('Magepack config should be an array of bundle definitions.');
    }
};

/**
 * Build the final Terser options by merging base config and strategy.
 *
 * @param {'safe'|'aggressive'} strategy
 * @returns {import('terser').MinifyOptions}
 */
const buildTerserOptions = (strategy) => {
    const strat = TERSER_STRATEGIES[strategy] || TERSER_STRATEGIES.safe;

    // Shallow merge is enough here because we control the nested structure
    return {
        ...BASE_TERSER_CONFIG,
        ...strat,
        compress: {
            ...(BASE_TERSER_CONFIG.compress || {}),
            ...(strat.compress || {}),
        },
        mangle: {
            ...(BASE_TERSER_CONFIG.mangle || {}),
            ...(strat.mangle || {}),
        },
        format: {
            ...(BASE_TERSER_CONFIG.format || {}),
            ...(strat.format || {}),
        },
    };
};

/**
 * Normalizes a module name based on Magento 2 minification settings.
 * Ensures that if minification is ON, the Module ID includes the ".min" suffix.
 * * @param {string} name - The RequireJS module name.
 * @param {boolean} isMinifyOn - Whether Magento minification is enabled.
 * @returns {string} The normalized module name.
 */
const getOptimizedModuleName = (name, isMinifyOn) => {
    if (!isMinifyOn) return name;
    // Skip loader plugins (text!, domReady!) and already minified modules
    if (name.includes('!') || name.includes('.min')) return name;
    // Append .min suffix to standard JS modules
    return name.replace(/(\.js)?$/, '.min');
};

/**
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
 * Compress a file as .gz and .br in parallel.
 *
 * @param {string} filePath
 * @returns {Promise<void>}
 */
const compressFile = async (filePath) => {
    const gzipJob = pipeline(
        createReadStream(filePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );

    const brotliJob = pipeline(
        createReadStream(filePath),
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                [constants.BROTLI_PARAM_LGWIN]: 24,
            },
        }),
        createWriteStream(`${filePath}.br`)
    );

    await Promise.all([gzipJob, brotliJob]);
};

/**
 * Process a single bundle: read modules, wrap, optional minify, write, compress.
 *
 * Output path is always "<localePath>/magepack/" (theme root).
 * Output suffix ".min" follows Magento minify setting (isMinifyOn).
 *
 * @param {{name: string, modules: Record<string, string>}} bundle
 * @param {string} localePath
 * @param {{minify?: boolean, minifyStrategy?: 'safe'|'aggressive'}} options
 * @param {boolean} isMinifyOn
 * @returns {Promise<void>}
 */
const processBundle = async (bundle, localePath, options, isMinifyOn) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;

    // IMPORTANT: output at theme root "magepack"
    const destPath = path.join(localePath, 'magepack', bundleFilename);

    // IMPORTANT: resolver uses Magento minify setting for signed/minified inputs
    const resolveMap = createPathResolver(localePath, isMinifyOn);

    const moduleNames = Object.keys(bundle.modules || {});
    let bundleContent = '';
    let successCount = 0;

    for (const moduleName of moduleNames) {
        const rawModulePath = bundle.modules[moduleName];

        try {
            const mappedPath = resolveMap(rawPath);
            const absPath = await resolveFile(localePath, moduleName, mappedPath, isMinifyOn);
            const content = await fs.readFile(absPath, 'utf8');

            const content = await fs.readFile(absolutePath, 'utf8');

            // IMPORTANT: pass absolutePath for correct text-vs-js detection (step 1 fix)
            const optimizedId = getOptimizedModuleName(moduleName, isMinifyOn);
            bundleContent += `${moduleWrapper(optimizedId, content, absPath)}\n`;
            successCount++;
        } catch (e) {
            // Keep CI output readable: warn but continue
            consola.warn(`Skipping ${moduleName} in ${bundle.name}: ${e.message}`);
        }
    }

    if (successCount === 0) {
        consola.warn(`Empty bundle ${bundleFilename} - Skipped writing.`);
        return;
    }

    // Content minification behavior is controlled by CLI.
    // - If --minify is passed: minify using selected strategy
    // - If strategy is aggressive: minify even if --minify omitted (performance-oriented default)
    const strategy = options.minifyStrategy === 'aggressive' ? 'aggressive' : 'safe';
    const shouldMinifyContent = Boolean(options.minify) || strategy === 'aggressive';

    let finalContent = bundleContent;

    if (shouldMinifyContent) {
        try {
            const result = await minify(bundleContent, buildTerserOptions(strategy));
            if (result?.code) finalContent = result.code;
        } catch (err) {
            // Do not block deployment; keep unminified bundle
            consola.error(`Minification error in ${bundle.name}:`, err);
        }
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, finalContent, 'utf8');
    await compressFile(destPath);

    const sizes = await getBundleSizes(destPath);

    consola.success(`✅ Bundle ready: ${bundleFilename}`);
    consola.info(`📍 Path ${formatPathMultiline(destPath)}`);
    consola.info(`${renderSizeReport(sizes)}`);
};

/**
 * Generate the RequireJS bundles configuration file.
 *
 * File location follows Magento conventions:
 * "<localePath>/magepack/requirejs-config-common(.min).js"
 *
 * @param {Array<{name: string, modules: Record<string, string>}>} bundles
 * @param {string} localePath
 * @param {boolean} isMinifyOn
 * @returns {Promise<void>}
 */
const generateRequireConfig = async (bundles, localePath, isMinifyOn) => {
    const suffix = isMinifyOn ? '.min' : '';
    const filename = `requirejs-config-common${suffix}.js`;
    const configPath = path.join(localePath, 'magepack', filename);

    /** @type {Record<string, string[]>} */
    const bundlesConfig = {};
    /** @type {string[]} */
    const deps = [];

    for (const bundle of bundles) {
        const bundleId = `magepack/bundle-${bundle.name}${suffix}`;
        
        // Normalize all module IDs within the bundle
        bundlesConfig[bundleId] = Object.keys(bundle.modules || {}).map(
            name => getOptimizedModuleName(name, isMinifyOn)
        );

        if (['vendor', 'common'].includes(bundle.name)) {
            deps.push(bundleId);
        }
    }

    const content = `require.config({ deps: ${JSON.stringify(deps)}, bundles: ${JSON.stringify(bundlesConfig)} });`;

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, content, 'utf8');
};

/**
 * Magepack bundling entrypoint.
 *
 * @param {string} configPath
 * @param {string|undefined} globPattern
 * @param {boolean|undefined} sourcemap
 * @param {boolean|undefined} minifyFlag
 * @param {'safe'|'aggressive'|undefined} minifyStrategy
 * @param {string|undefined} theme Optional: "Vendor/Theme" to restrict bundling to one theme
 * @returns {Promise<void>}
 */
export default async (configPath, globPattern, sourcemap, minifyFlag, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const config = require(path.resolve(process.cwd(), configPath));

    validateConfig(config);

    const options = {
        glob: globPattern,
        sourcemap,
        minify: Boolean(minifyFlag),
        minifyStrategy: minifyStrategy === 'aggressive' ? 'aggressive' : 'safe',
    };

    const locales = await getLocales(process.cwd());

    // Filter by theme if requested
    let filteredLocales = locales;
    if (theme) {
        const target = parseTheme(theme);
        filteredLocales = locales.filter((l) => l.vendor === target.vendor && l.name === target.name);

        if (filteredLocales.length === 0) {
            throw new Error(`No locales found for theme ${target.vendor}/${target.name}.`);
        }
    }

    consola.info(`Processing ${filteredLocales.length} locales...`);
    const startTime = process.hrtime();

    const localesPaths = filteredLocales.map((l) =>
        path.join(process.cwd(), 'pub', 'static', 'frontend', l.vendor, l.name, l.code)
    );

    for (const localePath of localesPaths) {
        //const localeCode = path.basename(localePath);
        //consola.start(`Bundling: ${localeCode}`);
        const { label } = describeLocalePath(localePath);
        consola.start(`Bundling: ${label}`);

        try {
            // Compute once per locale; used for naming and resolution
            const isMinifyOn = checkMinifyOn([localePath]);

            await Promise.all(config.map((b) => processBundle(b, localePath, options, isMinifyOn)));
            await generateRequireConfig(config, localePath, isMinifyOn);
        } catch (e) {
            consola.error(`Error in ${localeCode}:`, e);
        }
    }

    const [sec] = process.hrtime(startTime);
    consola.success(`Done in ${sec}s.`);
};
