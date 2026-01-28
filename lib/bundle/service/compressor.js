import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

/**
 * Compresses a file using Gzip and Brotli in parallel via Streams.
 * This ensures low memory usage even for large bundles.
 *
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<void>}
 */
export const compressFile = async (filePath) => {
    const gzipJob = pipeline(
        createReadStream(filePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );
  
    const brotliJob = pipeline(
        createReadStream(filePath),
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                [constants.BROTLI_PARAM_LGWIN]: 24,
            },
        }),
        createWriteStream(`${filePath}.br`)
    );
  
    await Promise.all([gzipJob, brotliJob]);
};
