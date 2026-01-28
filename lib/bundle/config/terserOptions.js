/**
 * Base Terser Configuration.
 * Contains settings critical for Magento 2 architecture (RequireJS/KnockoutJS).
 *
 * @type {import('terser').MinifyOptions}
 */
const BASE_CONFIG = {
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
const STRATEGIES = {
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
 * Builds the final Terser options.
 * * @param {'safe'|'aggressive'} strategy
 * @param {boolean} sourcemap
 * @param {string} filename
 * @returns {import('terser').MinifyOptions}
 */
export const buildTerserOptions = (strategy, sourcemap, filename) => {
    const stratConfig = STRATEGIES[strategy] || STRATEGIES.safe;
    const options = {
        ...BASE_CONFIG,
        ...stratConfig,
        compress: {
            ...(BASE_CONFIG.compress || {}),
            ...(stratConfig.compress || {}),
        },
        mangle: {
            ...(BASE_CONFIG.mangle || {}),
            ...(stratConfig.mangle || {}),
        },
        format: {
            ...(BASE_CONFIG.format || {}),
            ...(stratConfig.format || {}),
        },
    };

    if (sourcemap) {
        options.sourceMap = {
            filename: filename,
            url: `${filename}.map`,
            includeSources: true
        };
    }

    return options;
};
