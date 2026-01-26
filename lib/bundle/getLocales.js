import { globSync } from 'glob';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Returns a list of deployed frontend locales paths excluding Magento blank theme.
 *
 * @returns {string[]}
 */
const getLocales = (localesGlobPattern = 'pub/static/frontend/*/*/*') => {
    // glob v10+ returns unix style paths by default
    const locales = globSync(localesGlobPattern)
        .filter((locale) => !locale.includes('Magento/blank'))
        .filter(
            (locale) =>
                fs.existsSync(path.join(locale, 'requirejs-config.min.js')) ||
                fs.existsSync(path.join(locale, 'requirejs-config.js'))
        );

    if (!locales.length) {
        throw new Error(
            'No locales found! Make sure magepack is running after static content is deployed.'
        );
    }

    return locales;
};

export default getLocales;
