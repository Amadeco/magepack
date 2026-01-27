import path from 'node:path';
import fs from 'node:fs';
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
 * require.config({
 * config: {
 * baseUrlInterceptor: { 'path/to/module': 'version_hash/path/to/module', ... }
 * }
 * });
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

    // We use a simple walker to find the first valid configuration object.
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
 * Helper: Joins paths using the standard OS separator.
 * @param {string} themePath
 * @param {string} modulePath
 * @returns {string}
 */
const defaultModulePath = (themePath, modulePath) => {
    return path.join(themePath, modulePath);
};

/**
 * Helper: Resolves a module path using the Magento version map.
 * If a module is mapped, the version hash is injected into the path.
 *
 * @param {string} themePath - Base path of the theme.
 * @param {string} modulePath - Relative path of the module.
 * @param {Record<string, string>} map - The version map.
 * @returns {string} The resolved file system path.
 */
const mappedModulePath = (themePath, modulePath, map) => {
    if (!map[modulePath]) {
        return defaultModulePath(themePath, modulePath);
    }
    // Magento maps: "js/module" -> "version/js/module"
    // We construct: themePath + version/js/module + modulePath (which is redundant if not handled carefully)
    // Actually, the map value usually REPLACES the prefix.
    // Based on standard Magento behavior: map[key] is the path prefix to use.
    return path.join(themePath, map[modulePath], modulePath);
};

/**
 * Factory that creates a path resolver function for a specific locale.
 *
 * It automatically detects if `requirejs-map.js` exists and loads the version mapping.
 * This is essential for bundling to work on production environments where version signing is enabled.
 *
 * @param {string} themePath - The absolute path to the theme's static files (e.g., `pub/static/frontend/Vendor/Theme/en_US`).
 * @param {boolean} isMinified - Whether to look for `.min.js` map files.
 * @returns {function(string): string} A function that takes a module path and returns its absolute file system path.
 */
export default function (themePath, isMinified) {
    const bundleMapFile = path.join(
        themePath,
        'requirejs-map.' + (isMinified ? 'min.' : '') + 'js'
    );

    if (fs.existsSync(bundleMapFile)) {
        try {
            const mapContents = fs.readFileSync(bundleMapFile, 'utf8');
            const map = extractBaseUrlInterceptor(mapContents);

            logger.debug(`Loaded version map from ${bundleMapFile} with ${Object.keys(map).length} entries.`);

            return function (modulePath) {
                return mappedModulePath(themePath, modulePath, map);
            };
        } catch (e) {
            logger.warn(`Failed to process requirejs-map.js: ${e.message}. Falling back to default resolution.`);
        }
    }

    // Fallback strategy if map file is missing or unreadable
    return function (modulePath) {
        return defaultModulePath(themePath, modulePath);
    };
}
