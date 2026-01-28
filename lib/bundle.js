// lib/bundle.js
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import consola from 'consola';
import { minify } from 'terser';
import { glob } from 'glob'; //
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
 * @param {boolean} sourcemap
 * @param {string} bundleFilename
 * @returns {import('terser').MinifyOptions}
 */
const buildTerserOptions = (strategy, sourcemap, bundleFilename) => {
    const strat = TERSER_STRATEGIES[strategy] || TERSER_STRATEGIES.safe;
    
    /** @type {import('terser').MinifyOptions} */
    const options = {
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

    if (sourcemap) {
        options.sourceMap = {
            filename: bundleFilename,
            url: `${bundleFilename}.map`,
            includeSources: true
        };
    }

    return options;
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
 * @param {{minify?: boolean, minifyStrategy?: 'safe'|'aggressive', sourcemap?: boolean}} options
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
    
    // Structure to hold content for Terser (supports multiple input files)
    /** @type {Record<string, string>} */
    const sources = {};
    let successCount = 0;

    for (const moduleName of moduleNames) {
        const rawModulePath = bundle.modules[moduleName];
        try {
            const mappedPath = resolveMap(rawModulePath);
            const absPath = await resolveFile(localePath, moduleName, mappedPath, isMinifyOn);
            
            // Fix: Use correct variable from fix B
            const content = await fs.readFile(absPath, 'utf8');
            
            // IMPORTANT: pass absPath for correct text-vs-js detection
            const optimizedId = getOptimizedModuleName(moduleName, isMinifyOn);
            
            // We store wrapped content in an object keyed by "filename"
            // This allows Terser to generate source maps that point to correct "virtual" files
            sources[moduleName] = moduleWrapper(optimizedId, content, absPath);
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

    // Prepare content for writing
    let finalContent = '';
    
    // Content minification behavior is controlled by CLI.
    // - If --minify is passed: minify using selected strategy
    // - If strategy is aggressive: minify even if --minify omitted
    // - If --sourcemap is passed: we MUST use Terser to concatenate and generate map
    const strategy = options.minifyStrategy === 'aggressive' ? 'aggressive' : 'safe';
    const shouldMinifyContent = Boolean(options.minify) || strategy === 'aggressive';
    const shouldGenerateSourceMap = Boolean(options.sourcemap);

    // If we need minification OR source maps, we go through Terser
    if (shouldMinifyContent || shouldGenerateSourceMap) {
        try {
            const terserOptions = buildTerserOptions(strategy, shouldGenerateSourceMap, bundleFilename);
            
            // If we only want SourceMaps but NO minification, we disable compression/mangling
            // This effectively treats Terser as a smart concatenator + sourcemap generator
            if (!shouldMinifyContent) {
                terserOptions.compress = false;
                terserOptions.mangle = false;
                // Prettify output if not minifying, to make it readable
                terserOptions.format.beautify = true; 
            }

            const result = await minify(sources, terserOptions);
            
            if (result?.code) {
                finalContent = result.code;
                
                // Handle Source Map output
                if (shouldGenerateSourceMap && result.map) {
                    const mapPath = `${destPath}.map`;
                    await fs.writeFile(mapPath, result.map, 'utf8');
                    // sourceMappingURL is automatically appended by Terser if 'url' option is set
                }
            }
        } catch (err) {
            consola.error(`Terser error in ${bundle.name} (fallback to raw concat):`, err);
            // Fallback: simple concatenation
            finalContent = Object.values(sources).join('\n');
        }
    } else {
        // Simple concatenation (Fastest path)
        finalContent = Object.values(sources).join('\n');
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
        sourcemap: Boolean(sourcemap),
        minify: Boolean(minifyFlag),
        minifyStrategy: minifyStrategy === 'aggressive' ? 'aggressive' : 'safe',
    };

    const locales = await getLocales(process.cwd());
    
    // Filter by theme (Exact match) OR Glob pattern
    let filteredLocales = locales;

    if (theme) {
        const target = parseTheme(theme);
        filteredLocales = locales.filter((l) => l.vendor === target.vendor && l.name === target.name);
        if (filteredLocales.length === 0) {
            throw new Error(`No locales found for theme ${target.vendor}/${target.name}.`);
        }
    } else if (globPattern) {
        // Implement Glob filtering
        // We filter the list of locales by checking if "Vendor/Theme" matches the glob pattern
        filteredLocales = locales.filter((l) => {
            const themeId = `${l.vendor}/${l.name}`;
            const pattern = globPattern.endsWith('/') ? `${globPattern}**` : `${globPattern}/**`;
            // We use glob to find matching directories in frontend path to validate
            // Simple match using glob pattern:
            const matches = glob.sync(path.join(process.cwd(), 'pub/static/frontend', l.vendor, l.name), {
                ignore: 'node_modules/**' 
            });
            // Optimization: instead of filesystem globbing which is slow, we should just match the string pattern.
            // Since "glob" package is mainly for FS, we can rely on basic matching or assume users pass FS paths.
            // Standard Magepack behavior is usually path-based. 
            // Let's rely on checking if the locale path is covered by the user's glob pattern relative to root.
            // If the user passes "app/design/frontend/Amadeco/*", we shouldn't match pub/static directly.
            // BUT usually --glob in Magepack implies "Vendor/Theme".
            
            // SIMPLIFIED APPROACH:
            // Check if the vendor/theme string matches the pattern, 
            // OR checks if the locale directory is inside the glob result.
            
            // Actually, simplest is to use glob to expand the pattern to paths, then check if locale path is in it.
            return true; // (Placeholder logic - see below for robust implementation inside the main block)
        });
        
        // BETTER IMPLEMENTATION for glob:
        // 1. Expand glob to find directories
        const matchedPaths = await glob(globPattern || 'pub/static/frontend/**');
        const matchedSet = new Set(matchedPaths.map(p => path.resolve(p)));
        
        filteredLocales = locales.filter(l => {
            const localePath = path.join(process.cwd(), 'pub/static/frontend', l.vendor, l.name, l.code);
            // Check if the locale path or its parent (theme) is in the glob match
            const themePath = path.join(process.cwd(), 'pub/static/frontend', l.vendor, l.name);
            
            // Allow loose matching if user provided a partial glob like "pub/static/frontend/Amadeco/*"
            // Since glob returns files, we need to be careful.
            
            // Revert to documented behavior: --glob is usually for finding specific theme directories.
            // Let's assume globPattern matches "Vendor/Theme" string style for simplicity and speed?
            // No, the argument says "Glob pattern of themes".
            
            // Let's simply re-filter using the theme property if possible, but standard globbing is file-based.
            // Let's stick to the most effective way:
            return matchedPaths.some(mp => localePath.startsWith(path.resolve(mp)));
        });
    }

    // --- FIX: ROBUST GLOB FILTERING ---
    if (globPattern) {
        // We find all directories matching the glob. 
        // Example: 'pub/static/frontend/Amadeco/*'
        const foundDirs = await glob(globPattern, { cwd: process.cwd(), absolute: true });
        
        filteredLocales = filteredLocales.filter(l => {
            const localeAbsolutePath = path.join(process.cwd(), 'pub/static/frontend', l.vendor, l.name, l.code);
            // Check if the locale path is inside any of the found directories
            return foundDirs.some(dir => localeAbsolutePath.startsWith(dir));
        });
        
        if (filteredLocales.length === 0) {
            consola.warn(`No locales matched the glob pattern: ${globPattern}`);
        }
    }
    // ----------------------------------

    consola.info(`Processing ${filteredLocales.length} locales...`);
    
    const startTime = process.hrtime();
    const localesPaths = filteredLocales.map((l) =>
        path.join(process.cwd(), 'pub', 'static', 'frontend', l.vendor, l.name, l.code)
    );

    for (const localePath of localesPaths) {
        const { label } = describeLocalePath(localePath);
        consola.start(`Bundling: ${label}`);
        try {
            // Compute once per locale; used for naming and resolution
            const isMinifyOn = checkMinifyOn([localePath]);
            await Promise.all(config.map((b) => processBundle(b, localePath, options, isMinifyOn)));
            await generateRequireConfig(config, localePath, isMinifyOn);
        } catch (e) {
            consola.error(`Error in ${label}:`, e);
        }
    }

    const [sec] = process.hrtime(startTime);
    consola.success(`Done in ${sec}s.`);
};
