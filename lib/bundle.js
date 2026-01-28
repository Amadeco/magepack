import path from 'node:path';
import { createRequire } from 'node:module';
import { glob } from 'glob';
import consola from 'consola';
import fs from 'node:fs/promises';

import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

/**
 * Generates RequireJS config for the bundles.
 * @private
 */
const generateRequireConfig = async (bundles, localePath, isMinifyOn) => {
    const suffix = isMinifyOn ? '.min' : '';
    const configPath = path.join(localePath, 'magepack', `requirejs-config-common${suffix}.js`);
    
    const bundlesConfig = {};
    const deps = [];
    
    bundles.forEach(b => {
        const id = `magepack/bundle-${b.name}${suffix}`;
        bundlesConfig[id] = Object.keys(b.modules);
        if (['vendor', 'common'].includes(b.name)) deps.push(id);
    });

    const content = `require.config({ deps: ${JSON.stringify(deps)}, bundles: ${JSON.stringify(bundlesConfig)} });`;
    await fs.writeFile(configPath, content);
};

/**
 * Main Bundling Entrypoint.
 */
export default async (configPath, globPattern, sourcemap, minify, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const config = require(path.resolve(process.cwd(), configPath));
    
    const options = { glob: globPattern, sourcemap, minify, minifyStrategy };

    // 1. Resolve Locales
    let locales = await getLocales(process.cwd());
    if (theme) {
        const [v, n] = theme.split('/');
        locales = locales.filter(l => l.vendor === v && l.name === n);
    } else if (globPattern) {
        const foundDirs = await glob(globPattern, { cwd: process.cwd(), absolute: true });
        filteredLocales = filteredLocales.filter(l => {
            const localeAbsolutePath = path.join(process.cwd(), 'pub/static/frontend', l.vendor, l.name, l.code);
            return foundDirs.some(dir => localeAbsolutePath.startsWith(dir));
        });
        
        if (filteredLocales.length === 0) {
            consola.warn(`No locales matched the glob pattern: ${globPattern}`);
        }
    }

    consola.info(`🚀 Starting bundling for ${locales.length} locales...`);
    const start = process.hrtime();

    // 2. Process each locale
    for (const locale of locales) {
        const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
        const label = `${locale.vendor}/${locale.name} (${locale.code})`;
        
        consola.start(`Bundling ${label}`);
        
        try {
            const isMinifyOn = checkMinifyOn([localePath]);
            
            // Parallel bundle processing for speed inside a locale ? 
            // Better to keep sequential per locale to manage memory, but parallel inside locale logic
            await Promise.all(config.map(b => processBundle(b, localePath, options, isMinifyOn)));
            
            await generateRequireConfig(config, localePath, isMinifyOn);
        } catch (e) {
            consola.error(`Failed ${label}:`, e);
        }
    }

    const [sec] = process.hrtime(start);
    consola.success(`✨ Done in ${sec}s.`);
};
