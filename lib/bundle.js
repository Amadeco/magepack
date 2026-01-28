import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

/**
 * Generates the RequireJS configuration content for the bundles.
 *
 * @param {Array<Object>} config - The bundle configuration object.
 * @param {boolean} isMinifyOn - Whether minification is enabled.
 * @returns {string} The generated configuration string.
 */
const buildRequireConfigContent = (config, isMinifyOn) => {
    const bundles = {};
    const deps = [];
    const ext = isMinifyOn ? '.min' : '';

    config.forEach((bundle) => {
        // Validation adaptée à la structure 'modules' (objet) vue dans vos logs
        if (!bundle || !bundle.name || !bundle.modules) {
            consola.warn(`Skipping invalid bundle definition: ${JSON.stringify(bundle)}`);
            return;
        }

        const bundleName = `magepack/${bundle.name}${ext}`;
        deps.push(bundleName);
        
        // Extraction des noms de modules
        // On supporte les deux formats : Array (legacy) ou Object (actuel)
        const moduleNames = Array.isArray(bundle.modules) 
            ? bundle.modules 
            : Object.keys(bundle.modules);

        // Nettoyage des extensions .js éventuelles (par sécurité)
        bundles[bundleName] = moduleNames.map((f) => f.replace(/\.js$/, ''));
    });

    return `require.config({ deps: ${JSON.stringify(deps)}, bundles: ${JSON.stringify(bundles)} })`;
};

/**
 * Writes the Magepack specific RequireJS configuration file.
 *
 * @param {Array<Object>} config - The bundle configuration.
 * @param {string} localePath - Path to the locale directory.
 * @param {boolean} isMinifyOn - Whether minification is enabled.
 * @returns {Promise<void>}
 */
const generateRequireConfig = async (config, localePath, isMinifyOn) => {
    const ext = isMinifyOn ? '.min.js' : '.js';
    const filename = `requirejs-config-common${ext}`;
    const dest = path.join(localePath, 'magepack', filename);

    const content = buildRequireConfigContent(config, isMinifyOn);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
};

/**
 * CRITICAL FIX: Merges the Magepack bundle configuration DIRECTLY into the main Magento configuration.
 * This prevents "Race Conditions" where the browser attempts to load individual files 
 * before RequireJS is aware that they are part of a bundle.
 *
 * @param {string} localePath - Absolute path to the locale static directory.
 * @param {boolean} isMinifyOn - Whether we are targeting minified files.
 * @returns {Promise<void>}
 */
async function mergeConfigs(localePath, isMinifyOn) {
    const ext = isMinifyOn ? '.min.js' : '.js';
    const mainConfigPath = path.join(localePath, `requirejs-config${ext}`);
    const bundleConfigPath = path.join(localePath, 'magepack', `requirejs-config-common${ext}`);

    try {
        // 1. Verify files exist
        await fs.access(mainConfigPath);
        await fs.access(bundleConfigPath);

        // 2. Read contents in parallel
        const [mainConfig, bundleConfig] = await Promise.all([
            fs.readFile(mainConfigPath, 'utf8'),
            fs.readFile(bundleConfigPath, 'utf8')
        ]);

        // 3. Idempotency Check: Prevent duplicate merging if script runs twice
        if (mainConfig.includes('magepack/bundle-vendor')) {
            consola.info(`   ℹ️  Configuration already merged for ${path.basename(localePath)}`);
            return;
        }

        // 4. Merge: Append bundle config to main config
        // We add a semicolon and newline to ensure safety between IIFEs
        const mergedContent = `${mainConfig};\n${bundleConfig}`;

        // 5. Write back to the main file
        await fs.writeFile(mainConfigPath, mergedContent, 'utf8');
        consola.success(`   ✅ Configs merged successfully (Hard Merge) for ${path.basename(localePath)}`);

    } catch (e) {
        if (e.code === 'ENOENT') {
            consola.warn(`   ⚠️  Skipping merge for ${path.basename(localePath)}: File not found (${e.path})`);
        } else {
            consola.warn(`   ⚠️  Could not merge configs in ${localePath}: ${e.message}`);
        }
    }
}

/**
 * Main Bundling Entrypoint.
 * Orchestrates the finding, bundling, minification, and configuration injection.
 * * @param {string} configPath - Path to magepack.config.js.
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
            // 3. Detect Minification State
            const detectedMinification = checkMinifyOn([localePath]);
            const isMinifyOn = minify || detectedMinification;

            if (minify && !detectedMinification) {
                consola.info(`   forced minification mode (-m) for ${label}`);
            }
            
            // 4. Process Bundles (Concat -> Minify -> Compress)
            await Promise.all(config.map(b => processBundle(b, localePath, options, isMinifyOn)));
            
            // 5. Generate Magepack Configuration (requirejs-config-common.min.js)
            await generateRequireConfig(config, localePath, isMinifyOn);

            // 6. Merge Configurations
            await mergeConfigs(localePath, isMinifyOn);

        } catch (e) {
            consola.error(`Failed ${label}:`, e);
        }
    }

    const [sec] = process.hrtime(start);
    consola.success(`✨ Bundling completed in ${sec}s.`);
};
