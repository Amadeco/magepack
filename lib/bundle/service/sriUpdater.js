import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import consola from 'consola';

/**
 * Calculates the SRI hash (SHA-256) for a given file buffer.
 * @param {Buffer} buffer
 * @returns {string}
 */
const generateSriHash = (buffer) => {
    const hash = createHash('sha256').update(buffer).digest('base64');
    return `sha256-${hash}`;
};

/**
 * Updates the Magento 2.4.8+ sri-hashes.json file with new hashes for:
 * 1. The modified requirejs-config.js
 * 2. The newly generated Magepack bundles
 *
 * @param {Array<Object>} locales - List of processed locales.
 * @param {Array<Object>} bundles - List of generated bundles.
 */
export const updateSriHashes = async (locales, bundles) => {
    try {
        const rootPath = process.cwd();
        const sriPath = path.resolve(rootPath, 'pub/static/frontend/sri-hashes.json');

        // Fail fast if SRI file doesn't exist (Feature not active)
        try {
            await fs.access(sriPath);
        } catch {
            consola.debug('ℹ️ No sri-hashes.json found. Skipping SRI update.');
            return;
        }

        consola.start('🔐 Updating SRI hashes for Magento 2.4.8+...');

        const sriContent = await fs.readFile(sriPath, 'utf8');
        const sriData = JSON.parse(sriContent);
        let updateCount = 0;

        for (const locale of locales) {
            const localePathRelative = path.join(locale.vendor, locale.name, locale.code);
            const localePathAbsolute = path.join(rootPath, 'pub/static/frontend', localePathRelative);

            // 1. Update requirejs-config.js
            const configKey = `${localePathRelative}/requirejs-config.js`;
            try {
                const configBuffer = await fs.readFile(path.join(localePathAbsolute, 'requirejs-config.js'));
                sriData[configKey] = generateSriHash(configBuffer);
                updateCount++;
            } catch (e) { /* Warning handled silently for optional files */ }

            // 2. Add New Bundles
            for (const bundle of bundles) {
                // Check both standard and minified versions to ensure completeness
                const extensions = ['.js', '.min.js'];
                
                for (const ext of extensions) {
                    const filename = `bundle-${bundle.name}${ext}`;
                    const bundleKey = `${localePathRelative}/magepack/${filename}`;
                    const bundlePath = path.join(localePathAbsolute, 'magepack', filename);

                    try {
                        const bundleBuffer = await fs.readFile(bundlePath);
                        sriData[bundleKey] = generateSriHash(bundleBuffer);
                        updateCount++;
                    } catch (e) {
                        // File not found (e.g. .min.js doesn't exist because we only built .js)
                        // This is expected behavior, so we continue.
                    }
                }
            }
        }

        if (updateCount > 0) {
            await fs.writeFile(sriPath, JSON.stringify(sriData, null, 4));
            consola.success(`✅ Updated ${updateCount} hashes in sri-hashes.json`);
        } else {
            consola.info('   No relevant file changes detected for SRI.');
        }

    } catch (error) {
        // Log but don't crash the main process, as bundling itself was successful
        consola.error(`❌ Failed to update SRI hashes: ${error.message}`);
    }
};
