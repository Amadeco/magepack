/* global BASE_URL */
import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import collectModules from '../collectModules.js';
import configurePage from '../configurePage.js';

/**
 * Configuration template for the Checkout bundle.
 * @type {Object}
 */
const baseConfig = {
    url: {},
    name: 'checkout',
    modules: {},
};

/**
 * Collects RequireJS modules for the Checkout flow.
 *
 * This represents a full user journey simulation:
 * 1. Visits a Configurable Product page.
 * 2. Selects required options (Swatches or Dropdowns).
 * 3. Adds the product to the cart (handling both AJAX and Redirect modes).
 * 4. Visits the Cart page.
 * 5. Visits the Checkout page.
 *
 * @param {import('puppeteer').BrowserContext} browserContext - The browser context instance.
 * @param {Object} config - The generation configuration object.
 * @param {string} config.productUrl - The Product page URL to start the flow.
 * @param {number} config.timeout - Global timeout in milliseconds.
 * @param {string} [config.authUsername] - HTTP Basic Auth username.
 * @param {string} [config.authPassword] - HTTP Basic Auth password.
 * @returns {Promise<Object>} The bundle configuration object containing collected modules.
 */
const checkout = async (browserContext, config) => {
    const bundleConfig = merge({}, baseConfig);
    const bundleName = bundleConfig.name;

    logger.info(`Collecting modules for bundle "${bundleName}".`);

    // Initialize the page using the centralized factory.
    const page = await configurePage(browserContext, config);

    try {
        // --- STEP 1: Product Page ---
        logger.debug('Step 1/3: Navigating to Product Page...');
        await page.goto(config.productUrl, { 
            waitUntil: 'networkidle0',
            timeout: config.timeout 
        });

        // --- STEP 2: Option Selection (Swatches & Selects) ---
        // Critical for adding configurable products to cart.
        logger.debug('Selecting product options...');
        
        await page.evaluate(() => {
            // Handle Visual/Text Swatches
            const swatches = document.querySelectorAll('.product-options-wrapper .swatch-attribute');
            swatches.forEach((swatch) => {
                // Select the first available option that is not disabled
                const option = swatch.querySelector('.swatch-option:not([disabled])');
                if (option) {
                    option.click(); // Mobile-friendly interaction
                }
            });

            // Handle Legacy Dropdowns (Super Attributes)
            const selects = document.querySelectorAll('.product-options-wrapper .super-attribute-select');
            selects.forEach((select) => {
                if (select.options.length > 1) {
                    // Index 0 is usually "Choose an option...", so we pick Index 1
                    select.value = select.options[1].value;
                    // Dispatch events to trigger Magento validation/price update scripts
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    select.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
        });

        // --- STEP 3: Add to Cart ---
        logger.debug('Adding product to cart...');
        
        // We attempt to click the button and wait for *either* navigation OR network idle.
        // This makes it compatible with both standard redirects and AJAX add-to-cart.
        try {
            await Promise.all([
                // We race networkidle0 (AJAX case) vs navigation (Redirect case).
                // Using a shorter timeout for navigation check to avoid hanging if it's AJAX.
                Promise.race([
                    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {}),
                    new Promise(r => setTimeout(r, 5000)) // Fallback wait for AJAX
                ]),
                page.click('#product-addtocart-button')
            ]);
        } catch (e) {
            logger.warn('Add to cart interaction had a hiccup, attempting to proceed anyway.');
        }

        // Retrieve BASE_URL dynamically from the page context to ensure correct paths
        const baseUrl = await page.evaluate(() => window.BASE_URL);

        // --- STEP 4: Cart Page ---
        logger.debug('Step 2/3: Navigating to Cart Page...');
        await page.goto(`${baseUrl}checkout/cart`, { 
            waitUntil: 'networkidle0',
            timeout: config.timeout
        });
        
        const cartModules = await collectModules(page);

        // --- STEP 5: Checkout Page ---
        logger.debug('Step 3/3: Navigating to Checkout Page...');
        await page.goto(`${baseUrl}checkout`, { 
            waitUntil: 'networkidle0',
            timeout: config.timeout
        });
        
        const checkoutModules = await collectModules(page);

        // Merge modules from both Cart and Checkout steps
        merge(bundleConfig.modules, cartModules, checkoutModules);

    } catch (error) {
        logger.error(`Error collecting modules for "${bundleName}": ${error.message}`);
        throw error;
    } finally {
        await page.close();
    }

    logger.success(`Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

export default checkout;
