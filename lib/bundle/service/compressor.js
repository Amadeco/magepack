/**
 * @file lib/bundle/service/compressor.js
 * @description File Compression Service for Magepack.
 *
 * Handles the concurrent generation of three static compression formats:
 *   - **Gzip** (`.gz`): Universal fallback, supported by all browsers and CDNs.
 *   - **Brotli** (`.br`): Modern compression with superior ratios for text/JS payloads.
 *   - **Zstandard** (`.zst`): Next-generation compression via the host OS's native CLI binary.
 *
 * All three formats are generated concurrently using `Promise.all` to minimize
 * total compression time during the build pipeline.
 *
 * @module bundle/service/compressor
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.0.1: Fixed race condition in Zstd availability check. Replaced the mutable
 *     `isZstdInstalled` flag (which was mutated to three different types: null, boolean,
 *     string) with a shared Promise singleton pattern. This ensures the shell check runs
 *     exactly once regardless of how many concurrent locale builds invoke it, and the
 *     warning is emitted only once using a dedicated flag.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import consola from 'consola';

/** @type {(file: string, args: string[]) => Promise<{stdout: string, stderr: string}>} */
const execFileAsync = promisify(execFile);

/**
 * Shared Promise singleton for the Zstd availability check.
 *
 * This ensures the shell command (`zstd --version`) is executed exactly once,
 * even when multiple locale builds call `checkZstdAvailability` concurrently
 * via `Promise.allSettled` in the main bundling orchestrator.
 *
 * @type {Promise<boolean>|null}
 */
let zstdCheckPromise = null;

/**
 * Flag to ensure the "zstd not found" warning is logged only once per build.
 * Separate from the availability check to avoid type confusion.
 *
 * @type {boolean}
 */
let zstdWarningEmitted = false;

/**
 * Checks if the `zstd` CLI tool is installed on the host operating system.
 *
 * Uses a singleton Promise pattern to guarantee:
 *   1. The shell command runs exactly once (no duplicate executions).
 *   2. Concurrent callers share the same result (no race conditions).
 *   3. The return type is always `boolean` (no type confusion).
 *
 * @returns {Promise<boolean>} Resolves to `true` if `zstd` is available, `false` otherwise.
 */
const checkZstdAvailability = () => {
    if (!zstdCheckPromise) {
        zstdCheckPromise = execFileAsync('zstd', ['--version'])
            .then(() => true)
            .catch(() => false);
    }
    return zstdCheckPromise;
};

/**
 * Compresses a target file using Gzip, Brotli, and native Zstandard (Zstd) concurrently.
 *
 * Compression levels adapt based on the `fastCompression` flag:
 *   - **Production** (default): Gzip Max, Brotli Level 11, Zstd Level 22 `--ultra`.
 *   - **CI/CD Fast** (`--fast-compression`): Gzip Max, Brotli Level 4, Zstd Level 3.
 *
 * If the native `zstd` binary is not found on the host, the function gracefully
 * skips `.zst` generation with a single warning and continues without error.
 *
 * @async
 * @param {string} filePath - The absolute path to the generated JavaScript bundle file.
 * @param {Object} [options={}] - Configuration options for the compression process.
 * @param {boolean} [options.fastCompression=false] - If true, uses lower compression levels
 *   optimized for build speed rather than maximum compression ratio.
 * @returns {Promise<void>} Resolves when all compression jobs have completed.
 *
 * @example
 *   await compressFile('/var/www/pub/static/.../magepack/bundle-common.min.js', { fastCompression: false });
 *   // Generates: bundle-common.min.js.gz, bundle-common.min.js.br, bundle-common.min.js.zst
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

    // 3. Zstandard Job (Native OS CLI via child_process)
    const zstdJob = async () => {
        // Step A: Check availability using the singleton Promise
        const hasZstd = await checkZstdAvailability();

        if (!hasZstd) {
            // Emit the warning only once per build process, not per file
            if (!zstdWarningEmitted) {
                zstdWarningEmitted = true;
                consola.warn(
                    '⚠️ Native "zstd" CLI not found. Skipping .zst generation. ' +
                    'To enable, install it on your server (e.g., "sudo apt-get install zstd").'
                );
            }
            return;
        }

        // Step B: Build arguments for compression
        // Production: Level 22 with --ultra flag for maximum compression
        // Fast mode: Level 3 for quick CI/CD builds
        const zstdArgs = options.fastCompression
            ? ['-3', '--force', '--quiet', filePath, '-o', `${filePath}.zst`]
            : ['-22', '--ultra', '--force', '--quiet', filePath, '-o', `${filePath}.zst`];

        try {
            await execFileAsync('zstd', zstdArgs);
        } catch (error) {
            consola.error(`❌ Native Zstd compression failed for ${filePath}: ${error.message}`);
        }
    };

    // Execute all three compression tasks concurrently
    await Promise.all([gzipJob, brotliJob, zstdJob()]);
};
