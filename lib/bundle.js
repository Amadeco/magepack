import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { 
    createGzip, 
    createBrotliCompress, 
    brotliCompressSync, 
    constants as zlibConstants 
} from 'node:zlib';
import path from 'node:path';
import { stringify } from 'javascript-stringify';
import * as terser from 'terser';
import { gzipSizeSync } from 'gzip-size';
import genSourceMap from 'generate-sourcemap';

import logger from './utils/logger.js';
import getLocales from './bundle/getLocales.js';
import pathResolver from './bundle/pathResolver.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import * as moduleWrapper from './bundle/moduleWrapper.js';
import modulePathMapper from './bundle/moduleMapResolver.js';

/**
 * Base Terser Configuration.
 * Contains settings critical for Magento 2 architecture (RequireJS/KnockoutJS).
 * * @constant {import('terser').MinifyOptions}
 */
const BASE_TERSER_CONFIG = {
    module: false, // Output as global script/AMD
    mangle: {
        reserved: [
            // Standard Globals
            '$', 'jQuery', 'define', 'require', 'exports', 'requirejs', 'window', 'document',
            // Magento Core
            'mage', 'Magento', 'varien', 'varienGlobal',
            // Translation / Utils (Protected from mangling)
            'translate', '__', '$t', 
            // KnockoutJS Specific
            'ko', 'Knockout', 'observable', 'computed', 'observableArray'
        ],
        toplevel: false,
        safari10: true, // Workaround for scoping bugs in older Safari/iOS
    },
    format: {
        comments: false,
        ascii_only: true, // Safe for servers with varying encoding configs
        safari10: true,
        webkit: true,
    },
};

/**
 * Minification Strategies.
 * * @constant {Record<string, import('terser').MinifyOptions>}
 */
const TERSER_STRATEGIES = {
    safe: {
        ecma: 5, 
        compress: {
            passes: 1,
            drop_console: false,
            pure_getters: false,
            unsafe: false,
            unsafe_proto: false,
            sequences: false,
            side_effects: false,
            keep_fnames: true, 
        },
    },
    aggressive: {
        // ES2018 is safe. ES2020/2022 can break some specific Magento shims logic.
        ecma: 2018, 
        compress: {
            passes: 2,
            drop_console: true,  // PERFORMANCE WIN: Remove logs
            drop_debugger: true,
            
            // --- INTEGRITY PROTECTION (CRITICAL FOR REQUIREJS) ---
            unused: false,       // DO NOT DROP unused args (RequireJS needs exact arity)
            keep_fargs: true,    // DO NOT DROP function arguments
            keep_fnames: true,   // DO NOT RENAME functions (needed for Knockout inference)
            sequences: false,    // DO NOT JOIN statements with commas (preserves execution order)
            side_effects: false, // DO NOT DROP code appearing "pure" (like plugin registration)
            
            // --- VARIABLE PROTECTION ---
            collapse_vars: false, // DO NOT MERGE variables
            reduce_vars: false,   // DO NOT INLINE variables into expressions
            inline: false,        // DO NOT INLINE functions
            hoist_funs: false,    // DO NOT MOVE functions
            hoist_props: false,
            
            // --- SAFE OPTIMIZATIONS ALLOWED ---
            dead_code: true,     // Remove unreachable code
            conditionals: true,  // Optimize if/else
            booleans: true,      // Optimize boolean expressions
            if_return: true,     // Optimize return statements
            join_vars: true,     // Join var declarations
            booleans_as_integers: true, // true -> 1, false -> 0
        },
    }
};

/**
 * Compresses a file using Gzip (Level 9) and Brotli (Level 11).
 * * @param {string} filePath - Path to the original file.
 * @returns {Promise<void>}
 */
const compressFile = async (filePath) => {
    try {
        // Gzip Compression (Best Compression)
        await pipeline(
            createReadStream(filePath),
            createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }),
            createWriteStream(`${filePath}.gz`)
        );

        // Brotli Compression (Max Quality)
        await pipeline(
            createReadStream(filePath),
            createBrotliCompress({ 
                params: { 
                    [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
                    [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
                } 
            }),
            createWriteStream(`${filePath}.br`)
        );
        
        logger.debug(`Compressed artifacts generated for ${path.basename(filePath)}`);
    } catch (error) {
        logger.warn(`Compression failed for ${path.basename(filePath)}: ${error.message}`);
    }
};

/**
 * Generates Terser configuration based on strategy.
 * * @param {string} strategy 
 * @param {boolean} includeSourcemaps 
 * @param {string} bundleFileName 
 * @param {Object} sourceMap 
 * @returns {import('terser').MinifyOptions}
 */
const getTerserConfig = (strategy, includeSourcemaps, bundleFileName, sourceMap) => {
    const selectedStrategy = TERSER_STRATEGIES[strategy] || TERSER_STRATEGIES.aggressive;
    return {
        ...BASE_TERSER_CONFIG,
        ...selectedStrategy,
        mangle: {
            ...BASE_TERSER_CONFIG.mangle,
        },
        compress: {
            ...selectedStrategy.compress
        },
        sourceMap: includeSourcemaps ? {
            content: sourceMap.getMap(),
            filename: bundleFileName,
            url: `${bundleFileName}.map`,
        } : false
    };
};

/**
 * Main bundling function.
 * * @param {string} bundlingConfigPath
 * @param {string} [localesGlobPattern]
 * @param {boolean} [includeSourcemaps=false]
 * @param {boolean} [forceMinify=false]
 * @param {string} [minifyStrategy='aggressive']
 */
export default async (
    bundlingConfigPath,
    localesGlobPattern,
    includeSourcemaps = false,
    forceMinify = false,
    minifyStrategy = 'aggressive'
) => {
    const bundlingConfigRealPath = path.resolve(bundlingConfigPath);
    logger.info(`Using bundling config from "${bundlingConfigRealPath}".`);

    const bundlingConfigModule = await import(bundlingConfigRealPath);
    const bundlingConfig = bundlingConfigModule.default || bundlingConfigModule;

    const localesPaths = getLocales(localesGlobPattern);
    const isMinifyOn = checkMinifyOn(localesPaths);

    for (const localePath of localesPaths) {
        logger.info(`Creating bundles for "${localePath}".`);
        const pathMapper = modulePathMapper(localePath, isMinifyOn);

        for (const bundle of bundlingConfig) {
            const bundleName = bundle.name;
            logger.debug(`Processing bundle "${bundleName}"...`);

            const bundlePath = pathResolver.getBundlePath(localePath, bundleName, isMinifyOn);
            const bundleFileName = path.basename(bundlePath);
            const bundlePathDir = path.dirname(bundlePath);

            await fs.mkdir(bundlePathDir, { recursive: true });

            let bundleContents = '';
            const bundledModules = [];
            const sourceMapRanges = [];
            const sourceRange = { start: 0, end: 0 };

            logger.debug(`Collecting modules for "${bundleName}".`);

            for (const [moduleName, moduleEntry] of Object.entries(bundle.modules)) {
                const rawModulePath = pathResolver.getModuleRealPath(
                    moduleName,
                    moduleEntry,
                    isMinifyOn
                );
                const modulePath = pathMapper(rawModulePath);

                try {
                    let content = await fs.readFile(modulePath, { encoding: 'utf8' });

                    if (moduleWrapper.isText(modulePath)) {
                        content = moduleWrapper.wrapText(moduleName, content);
                    } else if (moduleWrapper.isNonAmd(content)) {
                        content = moduleWrapper.wrapNonAmd(moduleName, content);
                    } else if (moduleWrapper.isAnonymousAmd(content)) {
                        content = moduleWrapper.wrapAnonymousAmd(moduleName, content);
                    }

                    const lines = content.split('\n').length;
                    sourceRange.end = sourceRange.start + lines;
                    
                    bundleContents += content + '\n';
                    bundledModules.push(moduleName);
                    
                    sourceMapRanges.push({
                        sourceFile: path.relative(bundlePathDir, modulePath),
                        start: sourceRange.start,
                        end: sourceRange.end,
                    });
                    
                    sourceRange.start = sourceRange.end;
                } catch (error) {
                    logger.debug(`Module "${moduleName}" skipped: ${error.message}`);
                }
            }

            const sourceMap = genSourceMap(bundleFileName);
            sourceMap.addRanges(sourceMapRanges);

            // --- MINIFICATION ---
            if (isMinifyOn || forceMinify) {
                logger.debug(`Minifying "${bundleName}" (Strategy: ${minifyStrategy})...`);
                const terserConfig = getTerserConfig(minifyStrategy, includeSourcemaps, bundleFileName, sourceMap);

                try {
                    const result = await terser.minify(bundleContents, terserConfig);
                    if (result.error) throw result.error;

                    bundleContents = result.code;
                    
                    if (includeSourcemaps && result.map) {
                        await fs.writeFile(`${bundlePath}.map`, result.map);
                    }
                } catch (err) {
                    logger.error(`Minification failed for "${bundleName}": ${err.message}`);
                    logger.warn('Falling back to unminified content.');
                }
            } else if (includeSourcemaps) {
                bundleContents += `\n//# sourceMappingURL=${bundleFileName}.map\n`;
                await fs.writeFile(`${bundlePath}.map`, sourceMap.getMap());
            }

            logger.debug(`Writing "${bundleName}" to disk.`);
            await fs.writeFile(bundlePath, bundleContents);

            // --- COMPRESSION (Gzip + Brotli) ---
            if (isMinifyOn || forceMinify) {
                logger.debug(`Compressing "${bundleName}"...`);
                await compressFile(bundlePath);
            }

            // --- CONFIG GENERATION ---
            const bundleOptions = {
                bundles: { [`magepack/bundle-${bundleName}`]: bundledModules },
            };

            const bundleConfigPath = pathResolver.getBundleConfigPath(localePath, bundleName, isMinifyOn);
            const bundleConfigPathDir = path.dirname(bundleConfigPath);
            
            await fs.mkdir(bundleConfigPathDir, { recursive: true });
            await fs.writeFile(bundleConfigPath, `requirejs.config(${stringify(bundleOptions)});`);

            // --- STATS LOGGING ---
            const bundleSize = Math.round(bundleContents.length / 1024) + ' kB';
            const gzipedSize = Math.round(gzipSizeSync(bundleContents) / 1024) + ' kB';
            
            let brotliSize = 'N/A';
            try {
                const brBuffer = brotliCompressSync(bundleContents);
                brotliSize = Math.round(brBuffer.length / 1024) + ' kB';
            } catch (e) {}

            logger.success(
                `Generated bundle "${bundleName}"`.padEnd(30) + 
                `- ${bundleSize} (${gzipedSize} gz, ${brotliSize} br).`
            );
        }
    }
};
