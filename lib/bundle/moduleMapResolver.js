/**
 * @file lib/bundle/moduleMapResolver.js
 * @description Resolves RequireJS module paths using Magento's `requirejs-map.js` version mapping.
 *
 * Magento generates a `requirejs-map.js` file during `setup:static-content:deploy` that maps
 * module paths to versioned URLs for cache busting. This module parses that file using an
 * AST-based approach (Acorn) and provides a resolver function that translates logical module
 * names into their physical file system paths.
 *
 * @module bundle/moduleMapResolver
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.0.1: Migrated from synchronous `fs.existsSync` / `fs.readFileSync` to async
 *     `fs/promises` API. The factory function is now async and returns an async-compatible
 *     resolver, aligning with the fully asynchronous bundling pipeline.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

import logger from '../utils/logger.js';

/**
 * Safely parses JavaScript content into an AST.
 *
 * Attempts to parse as an ES Module first, then falls back to Script mode.
 * This is crucial for handling Magento's generated config files which may not
 * adhere to strict module standards.
 *
 * @param {string} contents - The JavaScript source code.
 * @returns {import('acorn').Node|null} The AST root node, or null if parsing fails.
 */
const parseAst = (contents) => {
    try {
        return acorn.parse(contents, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            locations: false,
        });
    } catch (error) {
        try {
            return acorn.parse(contents, {
                ecmaVersion: 'latest',
                sourceType: 'script',
                locations: false,
            });
        } catch (fallbackError) {
            logger.debug(
                `Unable to parse requirejs map file: ${fallbackError.message}`
            );
            return null;
        }
    }
};

/**
 * Extracts a property key from an AST Property node.
 * Handles both Identifier keys (e.g., `key: 'value'`) and Literal keys (e.g., `'key': 'value'`).
 *
 * @param {import('acorn').Node} property - The AST node representing an object property.
 * @returns {string|null} The key name, or null if it cannot be determined.
 */
const getPropertyKey = (property) => {
    if (!property || property.type !== 'Property' || property.computed) {
        return null;
    }

    if (property.key.type === 'Identifier') {
        return property.key.name;
    }

    if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
        return property.key.value;
    }

    return null;
};

/**
 * Searches for a specific property within an AST ObjectExpression.
 *
 * @param {import('acorn').Node} objectExpression - The AST node representing an object literal.
 * @param {string} propertyName - The name of the property to find.
 * @returns {import('acorn').Node|null} The matching Property node, or null if not found.
 */
const findObjectProperty = (objectExpression, propertyName) => {
    if (!objectExpression || objectExpression.type !== 'ObjectExpression') {
        return null;
    }

    for (const property of objectExpression.properties) {
        const key = getPropertyKey(property);
        if (key === propertyName) {
            return property;
        }
    }

    return null;
};

/**
 * Converts an AST ObjectExpression into a plain JavaScript object (string map).
 * Only extracts properties with String Literal values.
 *
 * @param {import('acorn').Node} objectExpression - The AST node to convert.
 * @returns {Record<string, string>} A simple key-value map.
 */
const objectExpressionToStringMap = (objectExpression) => {
    const map = {};

    if (!objectExpression || objectExpression.type !== 'ObjectExpression') {
        return map;
    }

    for (const property of objectExpression.properties) {
        const key = getPropertyKey(property);
        if (!key) continue;

        if (
            property.value &&
            property.value.type === 'Literal' &&
            typeof property.value.value === 'string'
        ) {
            map[key] = property.value.value;
        }
    }

    return map;
};

/**
 * Extracts the `baseUrlInterceptor` mapping from the `requirejs-map.js` file content.
 *
 * This function performs a deep AST traversal to locate the specific `require.config` call
 * that defines the version mapping logic used by Magento for cache busting.
 *
 * Structure looked for:
 * ```js
 * require.config({
 *   config: {
 *     baseUrlInterceptor: { 'path/to/module': 'version_hash/path/to/module', ... }
 *   }
 * });
 * ```
 *
 * @param {string} contents - The raw content of `requirejs-map.js`.
 * @returns {Record<string, string>} The extracted mapping object.
 */
const extractBaseUrlInterceptor = (contents) => {
    const ast = parseAst(contents);
    if (!ast) {
        return {};
    }

    let resolvedMap = null;

    // Use a simple walker to find the first valid configuration object.
    walk.simple(ast, {
        CallExpression(node) {
            // Optimization: Stop processing if we already found the map.
            if (resolvedMap) return;

            // Check if the call is `require.config(...)` or `requirejs.config(...)`
            if (
                node.callee.type !== 'MemberExpression' ||
                node.callee.computed
            ) {
                return;
            }

            const calleeObject = node.callee.object;
            const calleeProperty = node.callee.property;

            const isRequireConfig =
                calleeProperty.type === 'Identifier' &&
                calleeProperty.name === 'config' &&
                calleeObject.type === 'Identifier' &&
                (calleeObject.name === 'require' ||
                    calleeObject.name === 'requirejs');

            if (!isRequireConfig) return;

            // Check arguments: config object is the first argument
            const configArgument = node.arguments[0];
            if (!configArgument || configArgument.type !== 'ObjectExpression') {
                return;
            }

            // Traverse: config -> baseUrlInterceptor
            const configProperty = findObjectProperty(configArgument, 'config');
            if (!configProperty) return;

            const baseUrlProperty = findObjectProperty(
                configProperty.value,
                'baseUrlInterceptor'
            );

            if (!baseUrlProperty) return;

            // Convert the AST node back to a JS object
            resolvedMap = objectExpressionToStringMap(baseUrlProperty.value);
        },
    });

    return resolvedMap || {};
};

/**
 * Joins a theme path with a module path using the standard OS separator.
 *
 * @param {string} themePath - The absolute path to the theme's static files.
 * @param {string} modulePath - The relative module path.
 * @returns {string} The joined absolute path.
 */
const defaultModulePath = (themePath, modulePath) => {
    return path.join(themePath, modulePath);
};

/**
 * Normalizes a module path for map lookup.
 * - Converts backslashes to forward slashes.
 * - Strips query strings and hash fragments.
 * - Removes leading slash.
 *
 * @param {string} p - The raw module path.
 * @returns {string} The normalized path suitable for map key lookup.
 */
const normalizeForMap = (p) => {
    if (!p || typeof p !== 'string') return '';
    const clean = p.replace(/\\/g, '/').split('?')[0].split('#')[0];
    return clean.startsWith('/') ? clean.slice(1) : clean;
};

/**
 * Attempts to resolve a mapped path from Magento's baseUrlInterceptor map.
 *
 * Magento may store keys with or without the `.js` extension depending on the
 * build mode and deploy configuration. This function handles both variants.
 *
 * @param {Record<string, string>} map - The version mapping dictionary.
 * @param {string} modulePath - The module path to look up.
 * @returns {string|null} The mapped value if found, or null.
 */
const resolveMappedValue = (map, modulePath) => {
    const key = normalizeForMap(modulePath);
    if (!key) return null;

    // Most common: exact key match
    if (map[key]) return map[key];

    // Some setups include the extension in the key
    if (!key.endsWith('.js') && map[`${key}.js`]) return map[`${key}.js`];

    // Some callers may already pass ".js" but map may omit the extension
    if (key.endsWith('.js')) {
        const without = key.slice(0, -3);
        if (map[without]) return map[without];
    }

    return null;
};

/**
 * Resolves a module path using the Magento version map.
 *
 * If a module is found in the map, the mapped value is used as a full replacement
 * path containing the version hash. Otherwise, the default path join is used.
 *
 * @param {string} themePath - The absolute path to the theme's static files.
 * @param {string} modulePath - The relative module path.
 * @param {Record<string, string>} map - The version mapping dictionary.
 * @returns {string} The resolved absolute file system path.
 */
const mappedModulePath = (themePath, modulePath, map) => {
    const mappedValue = resolveMappedValue(map, modulePath);

    if (!mappedValue) {
        return defaultModulePath(themePath, normalizeForMap(modulePath));
    }

    // Map values are typically like "version/js/..." and already include the module path.
    const cleanValue = normalizeForMap(mappedValue);
    return path.join(themePath, cleanValue);
};

/**
 * Asynchronous factory that creates a path resolver function for a specific locale.
 *
 * It automatically detects if `requirejs-map.js` exists, reads and parses its content
 * to extract the version mapping. This is essential for bundling to work on production
 * environments where version signing (cache busting) is enabled.
 *
 * The returned resolver function is synchronous for performance, as the expensive I/O
 * (reading and parsing the map file) is performed once during factory initialization.
 *
 * @async
 * @param {string} themePath - The absolute path to the theme's static files
 *   (e.g., `pub/static/frontend/Vendor/Theme/en_US`).
 * @param {boolean} isMinified - Whether to look for `.min.js` map files.
 * @returns {Promise<function(string): string>} A function that takes a module path
 *   and returns its absolute file system path.
 *
 * @example
 *   const resolveMap = await createPathResolver('/var/www/pub/static/frontend/Amadeco/future/fr_FR', true);
 *   const absPath = resolveMap('Magento_Catalog/js/price-box');
 *   // => '/var/www/pub/static/frontend/Amadeco/future/fr_FR/version1234/Magento_Catalog/js/price-box'
 */
export default async function createPathResolver(themePath, isMinified) {
    const bundleMapFile = path.join(
        themePath,
        'requirejs-map.' + (isMinified ? 'min.' : '') + 'js'
    );

    try {
        // Async check: does the map file exist?
        await fs.access(bundleMapFile);

        // Async read: load the map file content
        const mapContents = await fs.readFile(bundleMapFile, 'utf8');

        // Parse: extract the baseUrlInterceptor mapping via AST
        const map = extractBaseUrlInterceptor(mapContents);

        logger.debug(`Loaded version map from ${bundleMapFile} with ${Object.keys(map).length} entries.`);

        // Return a synchronous resolver closure (all I/O is already done)
        return function resolveModulePath(modulePath) {
            return mappedModulePath(themePath, modulePath, map);
        };
    } catch (e) {
        // If the file doesn't exist (ENOENT) or is unreadable, fall back silently.
        if (e.code !== 'ENOENT') {
            logger.warn(`Failed to process requirejs-map.js: ${e.message}. Falling back to default resolution.`);
        }
    }

    // Fallback strategy: simple path join without version mapping
    return function resolveModulePath(modulePath) {
        return defaultModulePath(themePath, normalizeForMap(modulePath));
    };
}
