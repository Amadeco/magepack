/* global BASE_URL */

import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import authenticate from '../authenticate.js';
import blockMagepack from '../blockMagepack.js';
import collectModules from '../collectModules.js';

/**
 * Default CSS selectors for interacting with the Magento storefront.
 * Includes support for native Luma and MageWorx custom options.
 * @type {Object}
 */
const DEFAULT_SELECTORS = {
    /** @type {string} ID of the primary Add to Cart button */
    addToCartButton: '#product-addtocart-button',
    /** @type {Array<{container: string, option: string}>} Array of swatch configuration paths */
    swatchClickers: [
        // Native Magento Swatches (Configurable products)
        { 
            container: '.product-options-wrapper .swatch-attribute', 
            option: '.swatch-option:not([disabled])' 
        },
        // MageWorx Custom Option Swatches
        { 
            container: '.swatch-attribute-options', 
            option: '.mageworx-swatch-option:not(.disabled)' 
        }
    ],
    /** @type {string[]} Array of selectors for standard HTML dropdown options */
    dropdownSelects: [
        '.product-options-wrapper .super-attribute-select',
        '.product-options-wrapper select.product-custom-option'
    ]
};

const baseConfig = {
    url: {},
    name: 'checkout',
    modules: {},
};

/**
 * Prepares a bundle configuration for all modules loaded on cart and checkout pages.
 *
 * @param {import('puppeteer').BrowserContext} browserContext Puppeteer's BrowserContext object.
 * @param {Object} configuration Generation configuration object.
 * @param {string} configuration.productUrl URL to the reference product page.
 * @param {string} [configuration.authUsername] Basic auth username.
 * @param {string} [configuration.authPassword] Basic auth password.
 * @param {Object} [configuration.selectors] Custom selectors to override/extend defaults.
 * @param {number} [configuration.timeout=30000] Global navigation timeout.
 * @returns {Promise<Object>} The collected module configuration for the checkout bundle.
 */
const checkout = async (
    browserContext,
    { productUrl, authUsername, authPassword, selectors: userSelectors = {}, timeout = 30000 }
) => {
    const bundleConfig = merge({}, baseConfig);
    const bundleName = bundleConfig.name;

    // Merge logic: userSelectors.addToCartButton replaces default, others are concatenated.
    const selectors = {
        addToCartButton: userSelectors.addToCartButton || DEFAULT_SELECTORS.addToCartButton,
        swatchClickers: [
            ...DEFAULT_SELECTORS.swatchClickers,
            ...(Array.isArray(userSelectors.swatchClickers) ? userSelectors.swatchClickers : [])
        ],
        dropdownSelects: [
            ...DEFAULT_SELECTORS.dropdownSelects,
            ...(Array.isArray(userSelectors.dropdownSelects) ? userSelectors.dropdownSelects : [])
        ]
    };

    logger.info(`Collecting modules for bundle "${bundleName}".`);

    const page = await browserContext.newPage();

    blockMagepack(page);
    await authenticate(page, authUsername, authPassword);

    // --- STEP 1: Product Page ---
    logger.info(`🌐 Navigating to Product Page: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: 'networkidle0', timeout });

    // --- STEP 2: Handle Required Options ---
    logger.info('⚙️ Detecting & Configuring product options to enable "Add to Cart"...');
    await page.evaluate((sel) => {
        // --- Swatch options (configurable products) ---
        // Guard: swatchClickers may be empty or contain selectors that don't match
        // anything on simple product pages.
        if (Array.isArray(sel.swatchClickers)) {
            sel.swatchClickers.forEach(function (entry) {
                if (!entry || !entry.container || !entry.option) return;

                var containers = document.querySelectorAll(entry.container);

                if (!containers || !containers.length) return;

                Array.from(containers).forEach(function (cont) {
                    var opt = cont.querySelector(entry.option);

                    if (opt) opt.click();
                });
            });
        }

        // --- Dropdown selects (super attributes & custom options) ---
        // Guard: each matched element must be a real <select> with an .options property.
        // Non-<select> elements (e.g., <input>, <div>) that happen to match the CSS
        // selector do not have an .options HTMLCollection, causing Array.from(undefined)
        // to throw "undefined is not iterable".
        if (Array.isArray(sel.dropdownSelects)) {
            sel.dropdownSelects.forEach(function (dropdownSelector) {
                if (!dropdownSelector) return;

                var selects = document.querySelectorAll(dropdownSelector);

                if (!selects || !selects.length) return;

                Array.from(selects).forEach(function (select) {
                    // Only process actual <select> elements
                    if (!select.options || !select.options.length) return;

                    select.value = Array.from(select.options).reduce(
                        function (selectedValue, opt) {
                            return selectedValue || (opt.value ? opt.value : selectedValue);
                        },
                        null
                    );

                    select.dispatchEvent(new Event('input', { bubbles: true }));
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });
        }
    }, selectors);

    await new Promise(r => setTimeout(r, 1500));

    // --- STEP 3: Add to Cart interaction ---
    logger.info('🛒 Adding product to cart...');
    try {
        await page.waitForSelector(selectors.addToCartButton, { visible: true, timeout: 5000 });

        await Promise.all([
            Promise.race([
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout }).catch(() => {}),
                page.waitForSelector('.message-success', { timeout }).catch(() => {
                    logger.warn('⚠️ AJAX Success message did not appear. Verification may fail.');
                })
            ]),
            page.evaluate((btnId) => {
                const btn = document.querySelector(btnId);
                if (btn && !btn.disabled) {
                    btn.click();
                } else if (btn && btn.disabled) {
                    throw new Error('Button found but it is disabled. Ensure all required options were selected.');
                }
            }, selectors.addToCartButton)
        ]);

        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
        logger.error(`❌ Add to cart interaction failed: ${e.message}`);
        throw new Error('Failed to populate cart. generation cannot proceed for checkout bundle.');
    }

    const baseUrl = await page.evaluate(() => BASE_URL);

    // --- STEP 4: Cart Page ---
    logger.info(`🌐 Navigating to Cart: ${baseUrl}checkout/cart`);
    await page.goto(`${baseUrl}checkout/cart`, { waitUntil: 'networkidle0', timeout });
    const cartModules = await collectModules(page);
    logger.info(`📦 Collected ${Object.keys(cartModules).length} modules from Cart.`);

    // --- STEP 5: Checkout Page ---
    logger.info(`🌐 Navigating to Checkout: ${baseUrl}checkout`);
    await page.goto(`${baseUrl}checkout`, { waitUntil: 'networkidle0', timeout });
    
    if (page.url().includes('cart')) {
        logger.warn('⚠️ REDIRECT DETECTED: Magento sent the browser back to the Cart. The checkout page was not reached.');
    }
    
    const checkoutModules = await collectModules(page);
    logger.info(`📦 Collected ${Object.keys(checkoutModules).length} modules from Checkout.`);

    merge(bundleConfig.modules, cartModules, checkoutModules);

    await page.close();

    logger.success(`✨ Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

export default checkout;
