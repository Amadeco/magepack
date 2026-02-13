import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import consola from 'consola';
import { PATHS, FILES } from '../../utils/constants.js';

/**
 * Calculates the SRI hash (SHA-256) for a given file buffer.
 *
 * @param {Buffer} buffer - The file content buffer.
 * @returns {string} The formatted SRI hash string (e.g., "sha256-xxx...").
 */
const generateSriHash = (buffer) => {
    const hash = createHash('sha256').update(buffer).digest('base64');
    return `sha256-${hash}`;
};

/**
 * Processes a single file: reads it, generates the hash, and updates the SRI data object if necessary.
 * This helper function enforces the DRY principle.
 *
 * @param {string} filePath - The absolute file system path to the file.
 * @param {string} cacheKey - The key used in the SRI JSON object (frontend/Vendor/Theme/Locale/...).
 * @param {Object} sriData - The mutable SRI data object loaded from sri-hashes.json.
 * @returns {Promise<boolean>} Returns true if the hash was updated or added, false otherwise.
 */
const processFileHash = async (filePath, cacheKey, sriData) => {
    try {
        const buffer = await fs.readFile(filePath);
        const newHash = generateSriHash(buffer);

        if (sriData[cacheKey] !== newHash) {
            sriData[cacheKey] = newHash;
            return true;
        }
    } catch (error) {
        // Silently fail if file does not exist (e.g. .min.js in dev mode), consistent with previous logic.
        return false;
    }
    return false;
};

/**
 * Updates the Magento 2.4.8+ sri-hashes.json file with new hashes.
 * It handles both RequireJS configuration files and generated Magepack bundles.
 *
 * @param {Array<Object>} locales - List of processed locales.
 * @param {Array<Object>} bundles - List of generated bundles.
 * @returns {Promise<void>}
 */
export const updateSriHashes = async (locales, bundles) => {
    try {
        const rootPath = process.cwd();
        const sriPath = path.resolve(rootPath, PATHS.STATIC_FRONTEND, FILES.SRI_HASHES);

        // Fail fast if SRI file doesn't exist (Feature not active in Magento)
        try {
            await fs.access(sriPath);
        } catch {
            consola.debug(`ℹ️ No ${FILES.SRI_HASHES} found. Skipping SRI update.`);
            return;
        }

        consola.start('🔐 Updating SRI hashes for Magento 2.4.8+...');

        const sriContent = await fs.readFile(sriPath, 'utf8');
        const sriData = JSON.parse(sriContent);
        let updateCount = 0;

        for (const locale of locales) {
            // 1. Construct File System Path (OS Dependent)
            // e.g., pub/static/frontend/Vendor/Theme/Locale
            const localePathRelativeFS = path.join(locale.vendor, locale.name, locale.code);
            const localePathAbsolute = path.join(rootPath, PATHS.STATIC_FRONTEND, localePathRelativeFS);

            // 2. Construct JSON Key Prefix (Standardized with forward slashes)
            // e.g., "frontend/Vendor/Theme/Locale"
            // We use the constant PATHS.FRONTEND instead of hardcoding 'frontend'
            const localeKey = [PATHS.FRONTEND, locale.vendor, locale.name, locale.code].join('/');

            // --- Phase A: Update RequireJS Configs (.js and .min.js) ---
            const configFiles = [FILES.REQUIREJS_CONFIG, FILES.REQUIREJS_CONFIG_MIN];

            for (const configFile of configFiles) {
                const updated = await processFileHash(
                    path.join(localePathAbsolute, configFile),
                    `${localeKey}/${configFile}`,
                    sriData
                );
                if (updated) updateCount++;
            }

            // --- Phase B: Update Magepack Bundles ---
            const extensions = ['.js', '.min.js'];

            for (const bundle of bundles) {
                for (const ext of extensions) {
                    const filename = `bundle-${bundle.name}${ext}`;
                    
                    const bundleKey = `${localeKey}/${PATHS.MAGEPACK_DIR}/${filename}`;
                    const bundlePath = path.join(localePathAbsolute, PATHS.MAGEPACK_DIR, filename);

                    const updated = await processFileHash(bundlePath, bundleKey, sriData);
                    if (updated) updateCount++;
                }
            }
        }

        if (updateCount > 0) {
            await fs.writeFile(sriPath, JSON.stringify(sriData, null, 4));
            consola.success(`✅ Updated ${updateCount} hashes in ${FILES.SRI_HASHES}`);
        } else {
            consola.info('   No relevant file changes detected for SRI.');
        }

    } catch (error) {
        // Log error but allow the process to finish successfully (non-blocking)
        consola.error(`❌ Failed to update SRI hashes: ${error.message}`);
    }
};
