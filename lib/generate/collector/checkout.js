/* global BASE_URL */

const merge = require('lodash.merge');
const logger = require('../../utils/logger');
const authenticate = require('../authenticate');
const blockMagepack = require('../blockMagepack');
const collectModules = require('../collectModules');

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
 * * This collector simulates a full user journey:
 * 1. Visits a Product Page (PDP).
 * 2. Automatically selects required options (Swatches/Selects) to enable the Cart button.
 * 3. Adds the product to the cart via AJAX or Form Submit.
 * 4. Scrapes JS modules from the Cart page.
 * 5. Scrapes JS modules from the Checkout page.
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

    // Prevent Magepack from loading itself during generation to avoid recursion issues.
    blockMagepack(page);

    // Handle environment authentication if required.
    await authenticate(page, authUsername, authPassword);

    // --- STEP 1: Product Page ---
    logger.info(`🌐 Navigating to Product Page: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: 'networkidle0', timeout });

    // --- STEP 2: Handle Required Options ---
    logger.info('⚙️ Configuring product options to enable "Add to Cart"...');
    await page.evaluate((sel) => {
        // Handle Visual Swatches (Native + Mageworx)
        sel.swatchClickers.forEach(({ container, option }) => {
            const containers = document.querySelectorAll(container);
            Array.from(containers).forEach((cont) => {
                const opt = cont.querySelector(option);
                if (opt) opt.click();
            });
        });

        // Handle Standard Select Dropdowns
        sel.dropdownSelects.forEach((dropdownSelector) => {
            const selects = document.querySelectorAll(dropdownSelector);
            Array.from(selects).forEach((select) => {
                // Select the first valid option (index 1 usually, index 0 is "Choose...")
                select.value = Array.from(select.options).reduce(
                    (selectedValue, opt) => selectedValue || (opt.value ? opt.value : selectedValue),
                    null
                );
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
    }, selectors);

    // Grace period for Magento UI components to update the 'disabled' state of the button.
    await new Promise(r => setTimeout(r, 1500));

    // --- STEP 3: Add to Cart interaction ---
    logger.info('🛒 Adding product to cart...');
    try {
        await page.waitForSelector(selectors.addToCartButton, { visible: true, timeout: 5000 });

        await Promise.all([
            // Race: Page may reload (Standard redirect) or show success message (AJAX mode).
            Promise.race([
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout }).catch(() => {}),
                page.waitForSelector('.message-success', { timeout }).catch(() => {
                    logger.warn('⚠️ AJAX Success message did not appear. Verification may fail.');
                })
            ]),
            // Use evaluate click to bypass potential cookie banner overlays.
            page.evaluate((btnId) => {
                const btn = document.querySelector(btnId);
                if (btn && !btn.disabled) {
                    btn.click();
                } else if (btn && btn.disabled) {
                    throw new Error('Button found but it is disabled. Ensure all required options were selected.');
                }
            }, selectors.addToCartButton)
        ]);

        // Extra buffer to ensure the session/quote is persisted in Magento's DB.
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
    
    // Integrity check: If redirected back to cart, the session is empty.
    if (page.url().includes('cart')) {
        logger.warn('⚠️ REDIRECT DETECTED: Magento sent the browser back to the Cart. The checkout page was not reached.');
    }
    
    const checkoutModules = await collectModules(page);
    logger.info(`📦 Collected ${Object.keys(checkoutModules).length} modules from Checkout.`);

    // Merge all collected modules into the checkout bundle config.
    merge(bundleConfig.modules, cartModules, checkoutModules);

    await page.close();

    logger.success(`✨ Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

module.exports = checkout;
