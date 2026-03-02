import fs from 'node:fs/promises';
import consola from 'consola';
import path from 'node:path';
import chalk from 'chalk';

/**
 * Format bytes into a human-readable string.
 *
 * @param {number} bytes
 * @returns {string}
 */
const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
    const units = ['B', 'KB', 'MB'];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    const precision = i === 0 ? 0 : i === 1 ? 1 : 2;
    return `${value.toFixed(precision)} ${units[i]}`;
};

/**
 * Safe stat.size reader. Returns 0 on failure.
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
const statSize = async (p) => (await fs.stat(p).catch(() => ({ size: 0 }))).size;

/**
 * Displays the size report for a generated bundle.
 * @param {string} filePath
 */
export const reportBundleSize = async (filePath) => {
    const [raw, gz, br, zst] = await Promise.all([
        statSize(filePath),
        statSize(`${filePath}.gz`),
        statSize(`${filePath}.br`),
        statSize(`${filePath}.zst`), // Nouveau
    ]);

    const saveGz = ((1 - gz / raw) * 100).toFixed(1);
    const saveBr = ((1 - br / raw) * 100).toFixed(1);
    const saveZst = ((1 - zst / raw) * 100).toFixed(1); // Nouveau

    const report = `raw: ${formatBytes(raw)} - gzip: ${formatBytes(gz)} (-${saveGz}%), br: ${formatBytes(br)} (-${saveBr}%), zstd: ${formatBytes(zst)} (-${saveZst}%)`;
    consola.info(report);
    
    // Format path for better readability
    const parts = path.normalize(filePath).split(path.sep);
    const shortPath = parts.length > 4 ? `.../${parts.slice(-3).join('/')}` : filePath;
    consola.info(`📍 Location: ${shortPath}`);
};
