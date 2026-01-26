/* global BASE_URL */
import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import authenticate from '../authenticate.js';
import blockMagepack from '../blockMagepack.js';
import collectModules from '../collectModules.js';

const baseConfig = {
    url: {},
    name: 'checkout',
    modules: {},
};

const checkout = async (
    browserContext,
    { productUrl, authUsername, authPassword }
) => {
    const bundleConfig = merge({}, baseConfig);
    const bundleName = bundleConfig.name;

    logger.info(`Collecting modules for bundle "${bundleName}".`);

    const page = await browserContext.newPage();
    await blockMagepack(page);
    await authenticate(page, authUsername, authPassword);

    // 1. Go to product page to add item to cart
    await page.goto(productUrl, { waitUntil: 'networkidle0' });

    // Handle Swatches & Options (Browser Context)
    await page.evaluate(() => {
        const swatches = document.querySelectorAll(
            '.product-options-wrapper .swatch-attribute'
        );
        Array.from(swatches).forEach((swatch) => {
            const swatchOption = swatch.querySelector(
                '.swatch-option:not([disabled])'
            );
            if (swatchOption) {
                const input = swatch.querySelector('.swatch-input');
                if (input) {
                    input.value =
                        swatchOption.getAttribute('option-id') ||
                        swatchOption.getAttribute('data-option-id');
                }
            }
        });

        if (swatches.length) return;

        Array.from(
            document.querySelectorAll(
                '.product-options-wrapper .super-attribute-select'
            )
        ).forEach((select) => {
            select.value = Array.from(select.options).reduce(
                (val, opt) => val || (opt.value ? opt.value : val),
                null
            );
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    // Add to Cart
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.evaluate(() =>
            document.querySelector('#product_addtocart_form').submit()
        ),
    ]);

    const baseUrl = await page.evaluate(() => BASE_URL);

    // 2. Visit Cart
    await page.goto(`${baseUrl}checkout/cart`, { waitUntil: 'networkidle0' });
    const cartModules = await collectModules(page);

    // 3. Visit Checkout
    await page.goto(`${baseUrl}checkout`, { waitUntil: 'networkidle0' });
    const checkoutModules = await collectModules(page);

    merge(bundleConfig.modules, cartModules, checkoutModules);

    await page.close();

    logger.success(`Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

export default checkout;
