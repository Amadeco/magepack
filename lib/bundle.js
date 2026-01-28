import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

// Helper to escape regex characters
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cleans the output directory to prevent stale files.
 * @param {string} localePath
 */
const cleanMagepackDirectory = async (localePath) => {
    const targetDir = path.join(localePath, 'magepack');
    try {
        await fs.rm(targetDir, { recursive: true, force: true });
        await fs.mkdir(targetDir, { recursive: true });
    } catch (e) {
        consola.warn(`⚠️  Could not clean directory ${targetDir}: ${e.message}`);
    }
};

/**
 * Generates the RequireJS configuration content.
 * CORRECTION: Strict Alignment Strategy.
 * We include the '.min' extension in the Bundle ID itself if minification is on.
 * This removes the need for 'paths' mapping and prevents double-loading issues
 * where RequireJS sees "bundle" and "bundle.min" as two different modules.
 *
 * @param {Array<Object>} config 
 * @param {boolean} isMinifyOn 
 * @returns {string}
 */
const buildRequireConfigContent = (config, isMinifyOn) => {
    const bundles = {};
    const ext = isMinifyOn ? '.min' : '';

    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        // FIX: The Bundle ID matches the filename exactly (minus .js)
        // ex: 'magepack/bundle-vendor.min'
        const bundleId = `magepack/bundle-${bundle.name}${ext}`;

        const moduleNames = Array.isArray(bundle.modules) 
            ? bundle.modules 
            : Object.keys(bundle.modules);

        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
    });

    // We no longer generate 'paths'. 
    // RequireJS will automatically resolve "magepack/bundle-vendor.min" 
    // to "baseUrl/magepack/bundle-vendor.min.js".
    return `require.config({
    deps: [],
    bundles: ${JSON.stringify(bundles)}
});`;
};

/**
 * Injects the configuration into requirejs-config.js.
 */
async function injectConfigIntoMain(localePath, isMinifyOn, newConfigContent) {
    const ext = isMinifyOn ? '.min.js' : '.js';
    const mainConfigPath = path.join(localePath, `requirejs-config${ext}`);
    const label = path.basename(mainConfigPath);

    try {
        await fs.access(mainConfigPath);
        let mainConfig = await fs.readFile(mainConfigPath, 'utf8');

        const startMarker = '/* MAGEPACK START */';
        const endMarker = '/* MAGEPACK END */';
        const injection = `\n${startMarker}\n${newConfigContent}\n${endMarker}`;
        
        const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
        mainConfig = mainConfig.replace(cleanRegex, '');

        const finalContent = `${mainConfig.trim()};\n${injection}`;

        await fs.writeFile(mainConfigPath, finalContent, 'utf8');
        consola.success(`   ✅ Config injected: ${label}`);
    } catch (e) {
        if (e.code === 'ENOENT') {
            consola.warn(`   ⚠️  Skipping injection (Not Found): ${label}`);
        } else {
            consola.warn(`   ⚠️  Injection failed for ${label}: ${e.message}`);
        }
    }
}

/**
 * Processes a single locale completely (Bundles + Config).
 */
async function processLocale(locale, config, options) {
    const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
    const label = `${locale.vendor}/${locale.name} (${locale.code})`;

    consola.start(`Bundling ${label}...`);

    try {
        // STEP 0: Clean Output Directory
        await cleanMagepackDirectory(localePath);

        // 1. Detect Minification Context
        const detectedMinification = checkMinifyOn([localePath]);
        const isMinifyOn = options.minify || detectedMinification;

        if (options.minify && !detectedMinification) {
            consola.debug(`   [${label}] Forced minification active.`);
        }

        // 2. Process ALL bundles for this locale in PARALLEL
        await Promise.all(
            config.map(bundle => processBundle(bundle, localePath, options, isMinifyOn))
        );

        // 3. Generate & Inject Config
        const configContent = buildRequireConfigContent(config, isMinifyOn);
        await injectConfigIntoMain(localePath, isMinifyOn, configContent);

    } catch (e) {
        consola.error(`❌ Failed ${label}:`, e);
        throw e; 
    }
}

/**
 * Main Entrypoint.
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

    if (locales.length === 0) {
        consola.error("No locales found matching criteria.");
        return;
    }

    consola.info(`🚀 Starting parallel bundling for ${locales.length} locales...`);
    const start = process.hrtime();

    // 2. Execute All Locales in Parallel
    const results = await Promise.allSettled(
        locales.map(locale => processLocale(locale, config, options))
    );

    // 3. Summary Report
    const [sec] = process.hrtime(start);
    const failed = results.filter(r => r.status === 'rejected');

    if (failed.length > 0) {
        consola.error(`💀 Finished in ${sec}s with ${failed.length} errors.`);
        process.exit(1);
    } else {
        consola.success(`✨ All locales bundled successfully in ${sec}s.`);
    }
};
