import path from 'node:path';
import fs from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

import logger from '../utils/logger.js';

/**
 * Safely parse JavaScript contents, attempting module mode first and
 * falling back to script mode for non-ESM sources.
 *
 * @param {string} contents
 * @returns {import('acorn').Node|null}
 */
const parseAst = (contents) => {
    try {
        return acorn.parse(contents, {
            ecmaVersion: 'latest',
            sourceType: 'module',
        });
    } catch (error) {
        try {
            return acorn.parse(contents, {
                ecmaVersion: 'latest',
                sourceType: 'script',
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
 * Extract a safe property key from an Acorn Property node.
 *
 * @param {import('acorn').Node} property
 * @returns {string|null}
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
 * Find a property within an ObjectExpression by name.
 *
 * @param {import('acorn').Node} objectExpression
 * @param {string} propertyName
 * @returns {import('acorn').Node|null}
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
 * Convert an ObjectExpression to a string map, ignoring non-literal values.
 *
 * @param {import('acorn').Node} objectExpression
 * @returns {Record<string, string>}
 */
const objectExpressionToStringMap = (objectExpression) => {
    const map = {};

    if (!objectExpression || objectExpression.type !== 'ObjectExpression') {
        return map;
    }

    for (const property of objectExpression.properties) {
        const key = getPropertyKey(property);
        if (!key) {
            continue;
        }

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
 * Extract the baseUrlInterceptor map from requirejs-map.js contents.
 *
 * @param {string} contents
 * @returns {Record<string, string>}
 */
const extractBaseUrlInterceptor = (contents) => {
    const ast = parseAst(contents);
    if (!ast) {
        return {};
    }

    let resolvedMap = null;

    walk.simple(ast, {
        CallExpression(node) {
            if (resolvedMap) {
                return;
            }

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

            if (!isRequireConfig) {
                return;
            }

            const configArgument = node.arguments[0];
            if (!configArgument || configArgument.type !== 'ObjectExpression') {
                return;
            }

            const configProperty = findObjectProperty(configArgument, 'config');
            if (!configProperty) {
                return;
            }

            const baseUrlProperty = findObjectProperty(
                configProperty.value,
                'baseUrlInterceptor'
            );

            if (!baseUrlProperty) {
                return;
            }

            resolvedMap = objectExpressionToStringMap(baseUrlProperty.value);
        },
    });

    return resolvedMap || {};
};

/**
 * Helper: Default path joiner
 */
const defaultModulePath = (themePath, modulePath) => {
    return path.join(themePath, modulePath);
};

/**
 * Helper: Resolve path using the baseUrlInterceptor map
 */
const mappedModulePath = (themePath, modulePath, map) => {
    // If the module exists in the map, inject the mapped prefix/path
    if (!map[modulePath]) {
        return defaultModulePath(themePath, modulePath);
    }

    return path.join(themePath, map[modulePath], modulePath);
};

/**
 * Returns a function that resolves a module path against a specific locale,
 * accounting for Magento's requirejs-map.js (used for versioning/cache-busting).
 *
 * @param {string} themePath Path to the theme locale (e.g. pub/static/frontend/...)
 * @param {boolean} isMinified Whether we are in minification mode
 * @returns {function(string): string}
 */
export default function (themePath, isMinified) {
    const bundleMapFile = path.join(
        themePath,
        'requirejs-map.' + (isMinified ? 'min.' : '') + 'js'
    );

    if (fs.existsSync(bundleMapFile)) {
        const mapContents = fs.readFileSync(bundleMapFile, 'utf8');
        const map = extractBaseUrlInterceptor(mapContents);

        return function (modulePath) {
            return mappedModulePath(themePath, modulePath, map);
        };
    }

    // Fallback if no map file exists
    return function (modulePath) {
        return defaultModulePath(themePath, modulePath);
    };
}
