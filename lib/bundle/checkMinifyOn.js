import fs from 'node:fs';
import path from 'node:path';

/**
 * Checks if minification is enabled by looking for minified requirejs config.
 *
 * @param {string[]} locales List of locale paths.
 * @returns {boolean}
 */
const checkMinifyOn = (locales) => {
    return locales.some((locale) =>
        fs.existsSync(path.join(locale, 'requirejs-config.min.js'))
    );
};

export default checkMinifyOn;
