#!/usr/bin/env node

import { createRequire } from 'node:module';
import { program } from 'commander';
import logger from './lib/utils/logger.js'; // Note the .js extension, mandatory in ESM

// ESM doesn't import JSON by default without flags, so we use createRequire
const require = createRequire(import.meta.url);
const { version } = require('./package.json');

const errorHandler = function (error) {
    logger.error(error);
    process.exit(1);
};

program.name('magepack').usage('[generate|bundle] <options...>');

program
    .version(version, '-v, --version', 'Output the current version.')
    .helpOption('-h, --help', 'Show this command summary.')
    .addHelpCommand(false);

program
    .command('generate')
    .description(
        'Generate optimization configuration based on given page URLs.'
    )
    .requiredOption('--cms-url <url>', 'CMS page URL.')
    .requiredOption('--category-url <url>', 'Category page URL.')
    .requiredOption('--product-url <url>', 'Product page URL.')
    .option('-u, --auth-username <user>', 'Basic authentication username.')
    .option('-p, --auth-password <password>', 'Basic authentication password.')
    .option('-d, --debug', 'Enable logging of debugging information.')
    .option('-t, --timeout <seconds>', 'Timeout for browser operations in seconds.', '30')
    .option('--skip-checkout', 'Do not generate a bundle for checkout.')
    .action(async (config) => {
        if (config.debug) {
            logger.level = 5;
        }

        // Dynamic Import: Loads lib/generate.js only when this command is run
        try {
            const generateModule = await import('./lib/generate.js');
            // Support both default export and module.exports compatibility
            const generate = generateModule.default || generateModule;
            await generate(config);
        } catch (error) {
            errorHandler(error);
        }
    });

program
    .command('bundle')
    .description('Bundle JavaScript files using given configuration file.')
    .option(
        '-c, --config <path>',
        'Configuration file path.',
        'magepack.config.js'
    )
    .option('-g, --glob <path>', 'Glob pattern of themes to bundle.')
    .option('-d, --debug', 'Enable logging of debugging information.')
    .option('-s, --sourcemap', 'Include sourcemaps with generated bundles')
    .option(
        '-m, --minify',
        'Minify bundle using terser irrespective of Magento 2 minification setting'
    )
    .option(
        '--minify-strategy <strategy>', 
        'Minification strategy: "aggressive" (best performance) or "safe" (best compatibility).', 
        'safe'
    )
    .action(async ({ config, sourcemap, minify, debug, glob }) => {
        if (debug) {
            logger.level = 5;
        }

        // Dynamic Import: Loads lib/bundle.js only when this command is run
        try {
            const bundleModule = await import('./lib/bundle.js');
            // Support both default export and module.exports compatibility
            const bundle = bundleModule.default || bundleModule;
            await bundle(config, glob, sourcemap, minify, minifyStrategy);
        } catch (error) {
            errorHandler(error);
        }
    });

program.parse(process.argv);
