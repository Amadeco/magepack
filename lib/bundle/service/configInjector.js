import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { FILES, MARKERS, PATHS } from '../../utils/constants.js';

/**
 * Escapes special characters in a string for use in a regular expression.
 * @param {string} string
 * @returns {string}
 */
const escapeRegExp = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Generates the content for the RequireJS configuration file.
 * @param {Array<Object>} config - The bundle configuration object.
 * @returns {string} The formatted RequireJS configuration code.
 */
const buildRequireConfigContent = (config) => {
    const bundles = {};
    const paths = {};

    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        // Use the constant for the directory prefix
        const bundleId = `${PATHS.MAGEPACK_DIR}/bundle-${bundle.name}`;
        
        const moduleNames = Array.isArray(bundle.modules)
            ? bundle.modules
            : Object.keys(bundle.modules);

        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
        paths[bundleId] = bundleId;
    });

    return `require.config({bundles: ${JSON.stringify(bundles)},paths: ${JSON.stringify(paths)}});`;
};

/**
 * Injects the generated RequireJS configuration into the main 'requirejs-config.js' files.
 *
 * @param {string} localePath - The absolute path to the locale's static directory.
 * @param {Array<Object>} config - The bundle configuration to generate and inject.
 * @returns {Promise<void>}
 */
export const injectRequireConfig = async (localePath, config) => {
    const newConfigContent = buildRequireConfigContent(config);
    // Use constants for filenames
    const targets = [FILES.REQUIREJS_CONFIG, FILES.REQUIREJS_CONFIG_MIN];

    for (const fileName of targets) {
        const mainConfigPath = path.join(localePath, fileName);
        const label = path.basename(mainConfigPath);

        try {
            await fs.access(mainConfigPath);

            let mainConfig = await fs.readFile(mainConfigPath, 'utf8');
            
            // Use constants for Markers
            const startMarker = MARKERS.START;
            const endMarker = MARKERS.END;

            const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
            mainConfig = mainConfig.replace(cleanRegex, '');

            const injection = `${startMarker}${newConfigContent}${endMarker}`;
            const finalContent = `${mainConfig.trim()};\n${injection}`;

            await fs.writeFile(mainConfigPath, finalContent, 'utf8');
            consola.success(`   ✅ Config injected into: ${label}`);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                consola.warn(`   ⚠️  Injection failed for ${label}: ${e.message}`);
            }
        }
    }
};
