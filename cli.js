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
    .option('--cms-url <url>', 'CMS page URL.')
    .option('--category-url <url>', 'Category page URL.')
    .option('--product-url <url>', 'Product page URL.')
    .option('-u, --auth-username <user>', 'Basic authentication username.')
    .option('-p, --auth-password <password>', 'Basic authentication password.')
    .option('-d, --debug', 'Enable logging of debugging information.')
    .option('-t, --timeout <seconds>', 'Timeout for browser operations in seconds.', '30')
    .option('--only <bundles>', 'Comma-separated bundle names to generate (e.g. "cms" or "cms,category"). Runs all collectors if omitted.')
    .option('--merge', 'Merge generated bundles into existing magepack.config.js instead of replacing. Deduplicates modules already in existing vendor/common.')
    .option('--desktop', 'Use a desktop viewport (1920x1080) to capture desktop-specific scripts.')
    .option('--mobile', 'Use a mobile viewport (412x732) to capture mobile-specific scripts (default).')
    .action(async (config) => {
        if (config.debug) {
            logger.level = 5;
        }

        // Support env var fallback for credentials to avoid exposure in `ps aux`.
        // CLI flags take precedence; env vars are used only when flags are absent.
        if (!config.authUsername && process.env.MAGEPACK_AUTH_USER) {
            config.authUsername = process.env.MAGEPACK_AUTH_USER;
        }
        if (!config.authPassword && process.env.MAGEPACK_AUTH_PASS) {
            config.authPassword = process.env.MAGEPACK_AUTH_PASS;
        }

        // Validate URLs for collectors that will actually run.
        // --only restricts which collectors run; without it, all three are required.
        const onlySet = config.only
            ? new Set(config.only.split(',').map(s => s.trim().toLowerCase()))
            : null;

        const urlRequirements = [
            { bundle: 'cms',      flag: '--cms-url',      key: 'cmsUrl' },
            { bundle: 'category', flag: '--category-url', key: 'categoryUrl' },
            { bundle: 'product',  flag: '--product-url',  key: 'productUrl' },
        ];

        const missing = urlRequirements.filter(({ bundle, key }) => {
            const willRun = !onlySet || onlySet.has(bundle);
            return willRun && !config[key];
        });

        if (missing.length > 0) {
            missing.forEach(({ flag }) => logger.error(`Missing required option: ${flag}`));
            process.exit(1);
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
    .option('-c, --config <path>', 'Configuration file path.', 'magepack.config.js')
    .option('-g, --glob <path>', 'Glob pattern of themes to bundle.')
    .option('-t, --theme <vendor/theme>', 'Bundle only this theme (format: Vendor/Theme).')
    .option('-d, --debug', 'Enable logging of debugging information.')
    .option('-s, --sourcemap', 'Include sourcemaps with generated bundles')
    .option('-m, --minify', 'Minify bundle using terser irrespective of Magento 2 minification setting')
    .option('--minify-strategy <strategy>', 'Minification strategy: "aggressive" (best performance) or "safe" (best compatibility).', 'safe')
    .option('--fast-compression', 'Use lower Brotli/Zstd compression levels to speed up builds (Recommended for staging/dev CI/CD).')
    .option('--strict', 'Fail the build immediately if a mapped module is missing on the filesystem.')
    .option('--batch-size <number>', 'Number of module files read per I/O batch (default: 50). Increase on systems with high file descriptor limits.', '50')
    .action(async (options) => {
        if (options.debug) {
            logger.level = 5;
        }

        // Validate theme format early (fail fast)
        if (options.theme && !/^[^/]+\/[^/]+$/.test(options.theme)) {
            errorHandler(new Error(`Invalid --theme value "${options.theme}". Expected "Vendor/Theme".`));
            return;
        }

        // Dynamic Import: Loads lib/bundle.js only when this command is run
        try {
            const bundleModule = await import('./lib/bundle.js');
            // Support both default export and module.exports compatibility
            const bundle = bundleModule.default || bundleModule;
            
            await bundle(options);
        } catch (error) {
            errorHandler(error);
        }
    });

program
    .command('disable')
    .description('Disable Magepack by removing generated bundles and cleaning RequireJS configurations.')
    .action(async () => {
        try {
            const disableModule = await import('./lib/disable.js');
            const disable = disableModule.default || disableModule;
            await disable();
        } catch (error) {
            errorHandler(error);
        }
    });

program.parse(process.argv);
