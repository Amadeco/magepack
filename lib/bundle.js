/**
 * @file lib/bundle.js
 * @description Correctif Double-Chargement : Stratégie "Clean ID + Implicit Resolution"
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 * Génère la configuration RequireJS.
 * * CORRECTION DOUBLE CHARGEMENT :
 * 1. ID : On garde l'ID standard sans extension ('magepack/bundle-vendor').
 * 2. PATHS : On map cet ID vers le chemin SANS extension.
 * - RequireJS résout 'magepack/bundle-vendor' -> 'magepack/bundle-vendor'
 * - Le Resolver Magento détecte la minification et ajoute '.min.js' -> 'magepack/bundle-vendor.min.js'
 * * Cela permet de satisfaire à la fois RequireJS (qui trouve son ID) et le Browser (qui charge le bon fichier).
 */
const buildRequireConfigContent = (config) => {
    const bundles = {};
    const paths = {};
    
    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        // 1. ID Logique Standard (ex: 'magepack/bundle-vendor')
        const bundleId = `magepack/bundle-${bundle.name}`;
        
        // 2. Chemin Physique "Abstrait" (ex: 'magepack/bundle-vendor')
        // On NE MET PAS '.min' ici, c'est Magento qui l'ajoutera dynamiquement.
        const bundlePath = `magepack/bundle-${bundle.name}`;

        const moduleNames = Array.isArray(bundle.modules) 
            ? bundle.modules 
            : Object.keys(bundle.modules);

        // Normalisation des modules
        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
        
        // 3. Mapping Explicite
        // On force RequireJS à associer l'ID au chemin.
        paths[bundleId] = bundlePath;
    });

    return `require.config({
    bundles: ${JSON.stringify(bundles)},
    paths: ${JSON.stringify(paths)}
});`;
};

async function injectConfigIntoMain(localePath, newConfigContent) {
    // On cible les deux fichiers potentiels pour être sûr
    const targets = ['requirejs-config.js', 'requirejs-config.min.js'];
    
    for (const fileName of targets) {
        const mainConfigPath = path.join(localePath, fileName);
        const label = path.basename(mainConfigPath);

        try {
            await fs.access(mainConfigPath);
            
            let mainConfig = await fs.readFile(mainConfigPath, 'utf8');
            const startMarker = '/* MAGEPACK START */';
            const endMarker = '/* MAGEPACK END */';
            
            const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
            mainConfig = mainConfig.replace(cleanRegex, '');

            const injection = `\n${startMarker}\n${newConfigContent}\n${endMarker}`;
            const finalContent = `${mainConfig.trim()};\n${injection}`;

            await fs.writeFile(mainConfigPath, finalContent, 'utf8');
            consola.success(`   ✅ Config injected into: ${label}`);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                consola.warn(`   ⚠️  Injection failed for ${label}: ${e.message}`);
            }
        }
    }
}

async function processLocale(locale, config, options) {
    const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
    const label = `${locale.vendor}/${locale.name} (${locale.code})`;

    consola.start(`Bundling ${label}...`);

    try {
        await cleanMagepackDirectory(localePath);

        const detectedMinification = checkMinifyOn([localePath]);
        const isMinifyOn = options.minify || detectedMinification;

        if (options.minify && !detectedMinification) {
            consola.info(`   [${label}] Forced minification enabled.`);
        }

        // 1. Création des fichiers .js et .min.js
        await Promise.all(
            config.map(bundle => processBundle(bundle, localePath, options, isMinifyOn))
        );

        // 2. Génération de la Config (Note: on ne passe plus isMinifyOn car la logique est universelle)
        const configContent = buildRequireConfigContent(config);
        
        // 3. Injection
        await injectConfigIntoMain(localePath, configContent);

    } catch (e) {
        consola.error(`❌ Failed to process ${label}:`, e);
        throw e;
    }
}

export default async (configPath, globPattern, sourcemap, minify, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const absConfigPath = path.resolve(process.cwd(), configPath);
    const config = require(absConfigPath);
    const options = { glob: globPattern, sourcemap, minify, minifyStrategy };

    let locales = await getLocales(process.cwd());
    if (theme) {
        locales = locales.filter(l => `${l.vendor}/${l.name}` === theme);
    }

    if (locales.length === 0) {
        consola.error("No locales found matching criteria.");
        return;
    }

    consola.info(`🚀 Starting Bundle Pipeline for ${locales.length} locales...`);
    const start = process.hrtime();

    const results = await Promise.allSettled(
        locales.map(locale => processLocale(locale, config, options))
    );

    const [sec] = process.hrtime(start);
    const failed = results.filter(r => r.status === 'rejected');

    if (failed.length > 0) {
        consola.error(`💀 Finished in ${sec}s with ${failed.length} errors.`);
        process.exit(1);
    } else {
        consola.success(`✨ All locales bundled successfully in ${sec}s.`);
    }
};
