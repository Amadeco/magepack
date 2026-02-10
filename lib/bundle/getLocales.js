import fs from 'fs/promises';
import path from 'path';
import consola from 'consola';
import { STATIC_FRONTEND_PATH } from '../utils/constants.js';

/**
 * Helper to get subdirectories of a given path.
 * @param {string} source - The path to scan.
 * @returns {Promise<string[]>} List of directory names.
 */
async function getDirectories(source) {
    try {
        const entries = await fs.readdir(source, { withFileTypes: true });
        return entries
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    } catch (e) {
        return [];
    }
}

/**
 * Scans the Magento directory structure to find deployed locales.
 * Structure expected: pub/static/frontend/<Vendor>/<Theme>/<Locale>
 *
 * @param {string} rootPath - The root directory of the Magento installation.
 * @returns {Promise<Array<{vendor: string, name: string, code: string}>>}
 */
export default async (rootPath) => {
    // Construct the path to frontend static assets
    const frontendPath = path.join(rootPath, STATIC_FRONTEND_PATH);
    const locales = [];

    // 1. Verify that the base directory exists
    try {
        await fs.access(frontendPath);
    } catch (e) {
        throw new Error(
            `Could not find static directory at: ${frontendPath}\n` +
            `Make sure you are running this command from the Magento Root directory ` +
            `and that you have run 'bin/magento setup:static-content:deploy'.`
        );
    }

    // 2. Iterate over Vendors (e.g., Magento, Amadeco)
    const vendors = await getDirectories(frontendPath);

    for (const vendor of vendors) {
        const vendorPath = path.join(frontendPath, vendor);
        
        // 3. Iterate over Themes (e.g., luma, future)
        const themes = await getDirectories(vendorPath);

        for (const theme of themes) {
            const themePath = path.join(vendorPath, theme);

            // 4. Iterate over Locales (e.g., en_US, fr_FR)
            const potentialLocales = await getDirectories(themePath);

            for (const code of potentialLocales) {
                // Basic validation: a locale usually has an underscore (fr_FR) 
                // and is not a technical directory.
                if (code.includes('_')) {
                    locales.push({
                        vendor,
                        name: theme,
                        code
                    });
                }
            }
        }
    }

    if (locales.length === 0) {
        throw new Error(`No locales found in ${frontendPath}. Please check your generated static content.`);
    }

    return locales;
};
