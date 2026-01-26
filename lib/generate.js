import puppeteer from 'puppeteer';
import { stringify } from 'javascript-stringify';
import fs from 'node:fs';
import path from 'node:path';

import logger from './utils/logger.js';
import * as collectors from './generate/collector/index.js';
import extractCommonBundle from './generate/extractCommonBundle.js';

export default async (generationConfig) => {
    const browser = await puppeteer.launch({
        headless: !generationConfig.debug ? 'new' : false,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 412, height: 732 },
        ignoreHTTPSErrors: true,
    });
    const browserContext = await browser.createIncognitoBrowserContext();

    // Create a mutable copy of collectors to allow deletion
    const activeCollectors = { ...collectors };

    if (generationConfig.skipCheckout) {
        delete activeCollectors['checkout'];
    }

    logger.info('Collecting bundle modules in the browser.');

    let bundles = [];
    for (const collectorName in activeCollectors) {
        // Ensure we only execute actual functions (filter out default exports if any)
        if (typeof activeCollectors[collectorName] === 'function') {
            bundles.push(
                await activeCollectors[collectorName](
                    browserContext,
                    generationConfig
                )
            );
        }
    }

    logger.debug('Finished, closing the browser.');

    await browser.close();

    logger.debug('Extracting common module...');

    bundles = extractCommonBundle(bundles);

    logger.success('Done, outputting following modules:');

    bundles.forEach((bundle) => {
        logger.success(
            `${bundle.name} - ${Object.keys(bundle.modules).length} items.`
        );
    });

    fs.writeFileSync(
        path.resolve('magepack.config.js'),
        `module.exports = ${stringify(bundles, null, '  ')}`
    );
};
