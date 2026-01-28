import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

/**
 * Generates the RequireJS configuration content string for the bundles.
 *
 * CRITICAL FIX applied for Production:
 * 1. Decouples Bundle IDs from File Extensions.
 * 2. Uses 'paths' configuration to map Bundle IDs to physical files (with .min if needed).
 * 3. Prevents RequireJS from double-loading bundles due to extension mismatch.
 *
 * @param {Array<Object>} config - The bundle configuration object.
 * @param {boolean} isMinifyOn - Whether minification is enabled.
 * @returns {string} The generated configuration string.
 */
const buildRequireConfigContent = (config, isMinifyOn) => {
    const bundles = {};
    const paths = {};
    const deps = []; // Empty deps: On-demand loading strategy

    // Determine the suffix for physical files
    const ext = isMinifyOn ? '.min' : '';

    config.forEach((bundle) => {
        // Validation
        if (!bundle || !bundle.name || !bundle.modules) {
            return;
        }

        // FIX: The Bundle ID used by RequireJS logic should NOT have an extension.
        // ex: 'magepack/bundle-common'
        const bundleId = `magepack/bundle-${bundle.name}`;

        // FIX: The Physical Path relative to baseUrl (pub/static/...)
        // ex: 'magepack/bundle-common.min'
        const bundlePath = `${bundleId}${ext}`;

        // 1. Define what modules are inside this bundle
        const moduleNames = Array.isArray(bundle.modules)
            ? bundle.modules
            : Object.keys(bundle.modules);

        // Normalize module names (strip .js)
        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));

        // 2. Map the Bundle ID to the physical file path
        // This tells RequireJS: "When you need 'magepack/bundle-common', download 'magepack/bundle-common.min.js'"
        paths[bundleId] = bundlePath;
    });

    // Output valid JSON configuration
    return `require.config({
    deps: ${JSON.stringify(deps)},
    bundles: ${JSON.stringify(bundles)},
    paths: ${JSON.stringify(paths)}
});`;
};

/**
 * MERGE STRATEGY: Marker-based Replacement.
 * Reads the main config, strips out any existing Magepack block using Regex,
 * and appends the new block. This ensures idempotency.
 *
 * @param {string} localePath - Absolute path to the locale static directory.
 * @param {boolean} isMinifyOn - Whether we are targeting minified files.
 * @param {string} newConfigContent - The content to inject.
 * @returns {Promise<void>}
 */
async function injectConfigIntoMain(localePath, isMinifyOn, newConfigContent) {
    const ext = isMinifyOn ? '.min.js' : '.js';
    const mainConfigPath = path.join(localePath, `requirejs-config${ext}`);

    try {
        await fs.access(mainConfigPath);

        let mainConfig = await fs.readFile(mainConfigPath, 'utf8');

        // 1. Define Markers
        const startMarker = '/* MAGEPACK START */';
        const endMarker = '/* MAGEPACK END */';

        // 2. Prepare the injection block
        const injection = `\n${startMarker}\n${newConfigContent}\n${endMarker}`;

        // 3. Remove EXISTING block (Regex to match everything between markers)
        // Improved Regex for safety
        const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
        mainConfig = mainConfig.replace(cleanRegex, '');

        // 4. Append the new block
        const finalContent = `${mainConfig.trim()};\n${injection}`;

        await fs.writeFile(mainConfigPath, finalContent, 'utf8');
        consola.success(`   ✅ Config injected into ${path.basename(mainConfigPath)}`);

    } catch (e) {
        if (e.code === 'ENOENT') {
            consola.warn(`   ⚠️  Main config not found, skipping injection: ${path.basename(mainConfigPath)}`);
        } else {
            consola.warn(`   ⚠️  Injection failed: ${e.message}`);
        }
    }
}

// Helper to escape regex characters
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Main Bundling Entrypoint.
 *
 * @param {string} configPath - Path to magepack.config.js.
 * @param {string} globPattern - Glob pattern to find locales.
 * @param {boolean} sourcemap - Whether to generate sourcemaps.
 * @param {boolean} minify - CLI override to force minification (-m).
 * @param {string} minifyStrategy - 'aggressive' or 'safe'.
 * @param {string} theme - Specific theme to filter (optional).
 * @returns {Promise<void>}
 */
export default async (configPath, globPattern, sourcemap, minify, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const config = require(path.resolve(process.cwd(), configPath));

    const options = { glob: globPattern, sourcemap, minify, minifyStrategy };

    // 1. Resolve Locales
    let locales = await getLocales(process.cwd());
    if (theme) {
        locales = locales.filter(l => `${l.vendor}/${l.name}` === theme);
    }

    consola.info(`🚀 Starting bundling for ${locales.length} locales...`);
    const start = process.hrtime();

    // 2. Process each locale
    for (const locale of locales) {
        const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
        const label = `${locale.vendor}/${locale.name} (${locale.code})`;

        consola.start(`Bundling ${label}`);

        try {
            // 3. Detect Minification
            const detectedMinification = checkMinifyOn([localePath]);
            const isMinifyOn = minify || detectedMinification;

            if (minify && !detectedMinification) {
                consola.info(`   forced minification mode (-m) for ${label}`);
            }

            // 4. Process Bundles (Parallel)
            await Promise.all(config.map(b => processBundle(b, localePath, options, isMinifyOn)));

            // 5. Build Config Content ONCE
            const configContent = buildRequireConfigContent(config, isMinifyOn);

            // 6. Inject Directly into Main Config
            await injectConfigIntoMain(localePath, isMinifyOn, configContent);

        } catch (e) {
            consola.error(`Failed ${label}:`, e);
        }
    }

    const [sec] = process.hrtime(start);
    consola.success(`✨ Bundling completed in ${sec}s.`);
};
