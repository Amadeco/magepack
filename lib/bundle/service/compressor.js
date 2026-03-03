/**
 * @fileoverview File Compression Service for Magepack.
 * Handles the concurrent generation of Gzip (.gz), Brotli (.br), and Zstandard (.zst) 
 * compressed assets to optimize frontend delivery.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Promisify execFile to use it with async/await
const execFileAsync = promisify(execFile);

/**
 * Compresses a target file using Gzip, Brotli, and native Zstandard (Zstd).
 *
 * @async
 * @param {string} filePath - The absolute path to the generated JavaScript bundle file.
 * @param {Object} [options={}] - Configuration options for the compression process.
 * @param {boolean} [options.fastCompression=false] - If true, uses lower compression levels.
 * @returns {Promise<void>} 
 */
export const compressFile = async (filePath, options = {}) => {
    // 1. Gzip Pipeline (Native Node.js Stream)
    const gzipJob = pipeline(
        createReadStream(filePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );
    
    // 2. Brotli Pipeline (Native Node.js Stream)
    const brotliQuality = options.fastCompression 
        ? constants.BROTLI_DEFAULT_QUALITY
        : constants.BROTLI_MAX_QUALITY;
  
    const brotliJob = pipeline(
        createReadStream(filePath),
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                [constants.BROTLI_PARAM_LGWIN]: 24, 
            },
        }),
        createWriteStream(`${filePath}.br`)
    );

    // 3. Zstandard Job (Native OS CLI)
    // Uses the system's zstd binary instead of WASM to prevent U+0000 memory padding issues.
    const zstdJob = async () => {
        const zstdLevel = options.fastCompression ? '3' : '19';
        
        try {
            // Executes: zstd -{level} --force --quiet {filePath} -o {filePath}.zst
            await execFileAsync('zstd', [
                `-${zstdLevel}`,
                '--force', // Overwrite if exists
                '--quiet', // Do not output logs
                filePath,
                '-o',
                `${filePath}.zst`
            ]);
        } catch (error) {
            throw new Error(`Native Zstd compression failed for ${filePath}: ${error.message}`);
        }
    };
  
    // Execute all three tasks concurrently
    await Promise.all([gzipJob, brotliJob, zstdJob()]);
};
