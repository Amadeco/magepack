import authenticate from './authenticate.js';
import blockMagepack from './blockMagepack.js';

/**
 * Configures and initializes a new Puppeteer page instance with standardized settings.
 *
 * This factory function ensures that every page used by the collectors adheres to
 * the global configuration, including:
 * - Strict timeouts for navigation and selectors.
 * - Blocking of existing Magepack bundles to prevent double-bundling pollution.
 * - HTTP Basic Authentication (if credentials are provided).
 *
 * @param {import('puppeteer').BrowserContext} browserContext - The isolated browser context to create the page in.
 * @param {Object} config - The generation configuration object.
 * @param {string|number} config.timeout - Global timeout in milliseconds.
 * @param {string} [config.authUsername] - HTTP Basic Auth username.
 * @param {string} [config.authPassword] - HTTP Basic Auth password.
 * @returns {Promise<import('puppeteer').Page>} A promise that resolves to the fully configured Puppeteer Page instance.
 */
export default async (browserContext, config) => {
    const page = await browserContext.newPage();

    // Set strict default timeouts for all subsequent operations on this page.
    // This overrides the Puppeteer default (usually 30s) with the user-provided value.
    page.setDefaultTimeout(config.timeout);
    page.setDefaultNavigationTimeout(config.timeout);

    // Prevent infinite loops or pollution by blocking requests to existing Magepack bundles.
    await blockMagepack(page);

    // Perform authentication if credentials are provided in the config.
    await authenticate(page, config.authUsername, config.authPassword);

    return page;
};
