/**
 * @file lib/bundle/service/configInjector.js
 * @description Generates and injects RequireJS bundle configuration into Magento's static config files.
 *
 * After Magepack generates bundled JavaScript files, RequireJS must be informed about
 * which modules are available in which bundle. This service:
 *   1. Builds a `require.config({ bundles: {...}, paths: {...} })` block.
 *   2. Injects it at the end of the appropriate RequireJS config file(s).
 *   3. Uses start/end markers to enable clean replacement on subsequent runs.
 *
 * @module bundle/service/configInjector
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.0.1: Fixed scope mismatch where the minified `paths` mapping (with `.min`
 *     suffixes) was injected into the non-minified `requirejs-config.js` and vice versa.
 *     The injector now generates two distinct config payloads and writes each only to
 *     its matching target file. This prevents RequireJS resolution failures when toggling
 *     minification without re-bundling.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { FILES, MARKERS, PATHS } from '../../utils/constants.js';

/**
 * Escapes special characters in a string for safe use in a regular expression.
 *
 * @param {string} string - The raw string to escape.
 * @returns {string} The escaped string suitable for `new RegExp(...)`.
 */
const escapeRegExp = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Generates the content for the RequireJS configuration block.
 *
 * Produces a `require.config()` call that maps bundle names to their contained modules
 * and provides the correct `paths` mapping for RequireJS to locate the bundle files.
 *
 * @param {Array<Object>} config - The bundle configuration array.
 * @param {string} config[].name - The bundle name (e.g., 'vendor', 'common', 'cms').
 * @param {Object<string, string>|string[]} config[].modules - Map or list of module names.
 * @param {boolean} isMinifyTarget - Whether this config targets the minified RequireJS file.
 *   When `true`, the `paths` values include the `.min` suffix so RequireJS loads
 *   `bundle-*.min.js` files. When `false`, paths point to `bundle-*.js`.
 * @returns {string} The formatted RequireJS configuration code ready for injection.
 *
 * @example
 *   buildRequireConfigContent(bundles, true);
 *   // => 'require.config({bundles: {"magepack/bundle-vendor": [...]}, paths: {"magepack/bundle-vendor": "magepack/bundle-vendor.min"}});'
 */
const buildRequireConfigContent = (config, isMinifyTarget) => {
    /** @type {Record<string, string[]>} */
    const bundles = {};

    /** @type {Record<string, string>} */
    const paths = {};

    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        const bundleId = `${PATHS.MAGEPACK_DIR}/bundle-${bundle.name}`;

        // Scope-aware path mapping:
        // - Minified target (.min.js config) → paths include `.min` suffix
        // - Standard target (.js config) → paths use bare bundle ID
        const mappedPath = isMinifyTarget ? `${bundleId}.min` : bundleId;

        const moduleNames = Array.isArray(bundle.modules)
            ? bundle.modules
            : Object.keys(bundle.modules);

        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
        paths[bundleId] = mappedPath;
    });

    return `require.config({bundles: ${JSON.stringify(bundles)},paths: ${JSON.stringify(paths)}});`;
};

/**
 * Injects the generated RequireJS configuration into the main config files.
 *
 * Each target file receives a config payload matched to its scope:
 *   - `requirejs-config.js` → receives non-minified paths (e.g., `magepack/bundle-vendor`).
 *   - `requirejs-config.min.js` → receives minified paths (e.g., `magepack/bundle-vendor.min`).
 *
 * The injection is idempotent: existing Magepack blocks (delimited by start/end markers)
 * are removed before the new block is appended. This ensures clean re-runs without
 * accumulating duplicate configurations.
 *
 * @async
 * @param {string} localePath - The absolute path to the locale's static directory
 *   (e.g., `pub/static/frontend/Vendor/Theme/en_US`).
 * @param {Array<Object>} config - The bundle configuration to generate and inject.
 * @param {boolean} isMinifyOn - Whether Magento's global minification is active.
 *   This parameter is preserved for API compatibility but does not affect injection
 *   scope — both files are always processed when they exist.
 * @returns {Promise<void>}
 */
export const injectRequireConfig = async (localePath, config, isMinifyOn) => {
    /**
     * Mapping of target files to their scope-aware config content.
     *
     * Each entry pairs a filename with a boolean indicating whether the config
     * should use minified paths. This ensures the correct `paths` mapping is
     * written to the correct file, regardless of the global minification state.
     *
     * @type {Array<{fileName: string, isMinifyTarget: boolean}>}
     */
    const targets = [
        { fileName: FILES.REQUIREJS_CONFIG, isMinifyTarget: false },
        { fileName: FILES.REQUIREJS_CONFIG_MIN, isMinifyTarget: true },
    ];

    // Regex pattern to match and remove existing Magepack injection blocks
    const cleanRegex = new RegExp(
        `\\n?${escapeRegExp(MARKERS.START)}[\\s\\S]*?${escapeRegExp(MARKERS.END)}`,
        'g'
    );

    for (const { fileName, isMinifyTarget } of targets) {
        const mainConfigPath = path.join(localePath, fileName);
        const label = path.basename(mainConfigPath);

        try {
            // Check if the target file exists (e.g., .min.js may not exist in dev mode)
            await fs.access(mainConfigPath);

            // Read the current content
            let mainConfig = await fs.readFile(mainConfigPath, 'utf8');

            // Remove any previously injected Magepack configuration block
            mainConfig = mainConfig.replace(cleanRegex, '');

            // Generate scope-aware config content for this specific target
            const newConfigContent = buildRequireConfigContent(config, isMinifyTarget);

            // Build the injection block with markers for future idempotent replacement
            const injection = `${MARKERS.START}${newConfigContent}${MARKERS.END}`;
            const finalContent = `${mainConfig.trim()};\n${injection}`;

            // Write the updated configuration back to disk
            await fs.writeFile(mainConfigPath, finalContent, 'utf8');
            consola.success(`   ✅ Config injected into: ${label}`);
        } catch (e) {
            // ENOENT is expected when the file doesn't exist (e.g., .min.js in dev mode)
            if (e.code !== 'ENOENT') {
                consola.warn(`   ⚠️  Injection failed for ${label}: ${e.message}`);
            }
        }
    }
};
