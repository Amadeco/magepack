import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import collectModules from '../collectModules.js';
import configurePage from '../configurePage.js';

/**
 * Configuration template for the Product bundle.
 * @type {Object}
 */
const baseConfig = {
    url: [],
    name: 'product',
    modules: {},
};

/**
 * Collects RequireJS modules from a specific Product page (PDP).
 *
 * This collector focuses on Product Detail Pages, which often contain complex
 * JS for galleries, swatches, and "add to cart" logic. The mobile viewport
 * is particularly critical here to trigger mobile-specific gallery scripts (e.g., Fotorama).
 *
 * @param {import('puppeteer').BrowserContext} browserContext - The browser context instance.
 * @param {Object} config - The generation configuration object.
 * @param {string} config.productUrl - The target URL for the Product page.
 * @param {number} config.timeout - Global timeout in milliseconds.
 * @param {string} [config.authUsername] - HTTP Basic Auth username.
 * @param {string} [config.authPassword] - HTTP Basic Auth password.
 * @returns {Promise<Object>} The bundle configuration object containing collected modules.
 */
const product = async (browserContext, config) => {
    const bundleConfig = merge({}, baseConfig);
    const bundleName = bundleConfig.name;

    logger.info(`Collecting modules for bundle "${bundleName}".`);

    // Initialize the page using the centralized factory.
    const page = await configurePage(browserContext, config);

    try {
        // Navigate to the Product URL.
        await page.goto(config.productUrl, { 
            waitUntil: 'networkidle0',
            timeout: config.timeout 
        });

        // Extract the modules loaded by RequireJS.
        const collectedModules = await collectModules(page);
        merge(bundleConfig.modules, collectedModules);

    } catch (error) {
        if (page.magepackDirty) {
            logger.error(`\n\n❌ CRITICAL ERROR: YOUR SITE IS TRYING TO LOAD OLD BUNDLES!`);
            logger.error(`The page "${config.categoryUrl}" requested 'magepack/bundle-*' files.`);
            logger.error(`This caused a deadlock because Magepack blocked them to prevent pollution.`);
            logger.error(`👉 ACTION REQUIRED: Run the following commands to clean up before generating:\n`);
            logger.error(`   rm -rf pub/static/frontend/* var/view_preprocessed/*`);
            logger.error(`   bin/magento setup:static-content:deploy fr_FR -f\n`);
            
            throw new Error("Generation stopped due to dirty environment (existing bundles detected).");
        }
        
        logger.error(`Error collecting modules for "${bundleName}": ${error.message}`);
        throw error;
    } finally {
        // Ensure resources are released.
        await page.close();
    }

    logger.success(`Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

export default product;
