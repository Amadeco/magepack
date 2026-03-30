/**
 * @file lib/bundle/service/mixinWeaver.js
 * @description Build-time mixin application for Magepack bundles.
 *
 * ## Problem
 *
 * Magento's `mixins!` RequireJS plugin intercepts `require.load()` to apply mixin
 * wrappers around target modules. When Magepack bundles a target module, RequireJS
 * resolves it directly from its internal registry — `require.load()` is never called,
 * and the mixins are silently skipped.
 *
 * ## Solution
 *
 * Instead of excluding mixin-affected modules from bundles (which defeats the purpose
 * of bundling), this service **weaves mixins at build-time** by injecting a synthetic
 * orchestrator module into the bundle output.
 *
 * The orchestrator:
 *   1. Requires the original target module.
 *   2. Requires each mixin factory in order.
 *   3. Applies the mixin chain: `result = mixinC(mixinB(mixinA(original)))`.
 *   4. Overwrites the RequireJS registry entry so subsequent `require()` calls
 *      get the fully-mixed version.
 *
 * This is functionally equivalent to what `mixins!` does at runtime, but happens
 * deterministically inside the bundle with zero extra HTTP requests.
 *
 * ## Key Design Decisions
 *
 * - **Registry overwrite, not re-define**: We use `require.s.contexts._.defined[target] = result`
 *   because `define()` with an already-registered name is silently ignored by RequireJS.
 *   The overwrite pattern is safe because:
 *   (a) It happens synchronously inside the bundle script, before any consumer runs.
 *   (b) Only the final mixed result is visible to consumers.
 *
 * - **Original target is renamed**: The original `define("target", ...)` is rewritten
 *   to `define("target__original", ...)`. This prevents RequireJS from resolving the
 *   unmixed version while the orchestrator references it by the `__original` suffix.
 *
 * - **Mixin modules are kept as-is**: Their `define()` calls remain unchanged in the
 *   bundle. The orchestrator simply requires them by name.
 *
 * - **Guard flag**: A `__magepackWoven` flag on the context prevents double-application
 *   if the bundle is loaded twice (e.g., fallback scenarios).
 *
 * @module bundle/service/mixinWeaver
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.1.0: Initial implementation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { FILES } from '../../utils/constants.js';

/**
 * Suffix appended to original target module IDs to prevent early resolution.
 * @type {string}
 */
const ORIGINAL_SUFFIX = '__original';

/**
 * Extracts all `config.mixins` declarations from a RequireJS configuration file.
 *
 * Uses a sandboxed `new Function()` evaluation with mocked `require.config` /
 * `requirejs.config` to capture mixin declarations across all config calls.
 *
 * @param {string} configContent - Raw content of `requirejs-config.js`.
 * @returns {Record<string, Record<string, boolean>>} Merged mixin map.
 */
const extractMixinsFromConfig = (configContent) => {
    /** @type {Record<string, Record<string, boolean>>} */
    const mergedMixins = {};

    const configCaptor = (cfg) => {
        if (!cfg || typeof cfg !== 'object') {
            return;
        }

        const mixinBlock = cfg.config?.mixins;

        if (!mixinBlock || typeof mixinBlock !== 'object') {
            return;
        }

        for (const [targetModule, mixinMap] of Object.entries(mixinBlock)) {
            if (!mixinMap || typeof mixinMap !== 'object') {
                continue;
            }

            if (!mergedMixins[targetModule]) {
                mergedMixins[targetModule] = {};
            }

            Object.assign(mergedMixins[targetModule], mixinMap);
        }
    };

    const mockFn = () => {};
    const mockRequire = Object.assign(mockFn, { config: configCaptor });
    const mockRequirejs = Object.assign(
        (...args) => {},
        { config: configCaptor }
    );
    const mockDefine = Object.assign(
        (...args) => {},
        { amd: true }
    );

    try {
        // eslint-disable-next-line no-new-func
        const sandbox = new Function(
            'require', 'requirejs', 'define', 'window', 'document',
            configContent
        );

        sandbox(mockRequire, mockRequirejs, mockDefine, {}, {});
    } catch (e) {
        consola.debug(`   ⚠️  Mixin config extraction: partial parse (${e.message}).`);
    }

    return mergedMixins;
};

/**
 * Builds a map of targets → active mixin module IDs, filtered to only include
 * modules that are actually present in the current bundle.
 *
 * @param {Record<string, Record<string, boolean>>} mixinConfig - Full mixin map from config.
 * @param {Set<string>} bundledModules - Set of module IDs present in the bundle.
 * @returns {Map<string, string[]>} Map of target module ID → array of mixin module IDs.
 *   Only includes targets where both the target AND at least one mixin are in the bundle.
 */
const buildWeavingPlan = (mixinConfig, bundledModules) => {
    /** @type {Map<string, string[]>} */
    const plan = new Map();

    for (const [targetModule, mixinMap] of Object.entries(mixinConfig)) {
        // Target must be in this bundle
        if (!bundledModules.has(targetModule)) {
            continue;
        }

        const activeMixins = Object.entries(mixinMap)
            .filter(([mixinId, enabled]) => enabled === true && bundledModules.has(mixinId))
            .map(([mixinId]) => mixinId);

        if (activeMixins.length > 0) {
            plan.set(targetModule, activeMixins);
        }
    }

    return plan;
};

/**
 * Renames the original target module's `define()` call in the bundle sources.
 *
 * Replaces `define("Magento_Swatches/js/swatch-renderer", ...)`
 * with    `define("Magento_Swatches/js/swatch-renderer__original", ...)`
 *
 * This prevents RequireJS from resolving the unmixed version when the bundle loads.
 * The orchestrator will `require()` the `__original` and apply mixins before
 * writing the result to the original module ID in the registry.
 *
 * @param {Record<string, string>} sources - The bundle sources map (relative path → content).
 *   **Mutated in place.**
 * @param {string} targetModuleId - The original module ID to rename.
 * @returns {boolean} True if the rename was successful, false if the target was not found.
 */
const renameOriginalDefine = (sources, targetModuleId) => {
    const escapedId = targetModuleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const definePattern = new RegExp(
        `define\\(["']${escapedId}["']`,
        'g'
    );

    let found = false;

    for (const [sourcePath, content] of Object.entries(sources)) {
        if (definePattern.test(content)) {
            sources[sourcePath] = content.replace(
                definePattern,
                `define("${targetModuleId}${ORIGINAL_SUFFIX}"`
            );
            found = true;
            break; // A module should only be defined once in a bundle
        }
    }

    return found;
};

/**
 * Generates the JavaScript code for the mixin orchestrator module.
 *
 * The orchestrator is a self-executing `require()` block that:
 *   1. Loads the renamed original target (`target__original`).
 *   2. Loads all mixin factories.
 *   3. Chains the factories: `result = mixinC(mixinB(mixinA(original)))`.
 *   4. Writes the result into RequireJS's `defined` registry under the original target name.
 *   5. Defines a proper AMD module under the original name so future `require()` calls resolve.
 *
 * @param {string} targetModuleId - The original module ID.
 * @param {string[]} mixinModuleIds - Ordered array of mixin module IDs.
 * @returns {string} The generated JavaScript code.
 *
 * @example
 *   generateOrchestrator('Magento_Swatches/js/swatch-renderer', [
 *     'Yireo_Webp2/js/swatch-renderer-mixin',
 *     'Amadeco_AdvancedAvailability/js/mixin/swatch-renderer-mixin'
 *   ]);
 */
const generateOrchestrator = (targetModuleId, mixinModuleIds) => {
    const originalId = `${targetModuleId}${ORIGINAL_SUFFIX}`;

    // Build the dependency array for the require() call
    const deps = [
        `"${originalId}"`,
        ...mixinModuleIds.map((id) => `"${id}"`)
    ];

    // Build the factory parameter names
    const params = [
        '__original__',
        ...mixinModuleIds.map((_, i) => `__mixin${i}__`)
    ];

    // Build the chain: result = mixin2(mixin1(mixin0(original)))
    let chainExpr = '__original__';
    mixinModuleIds.forEach((_, i) => {
        chainExpr = `__mixin${i}__(${chainExpr})`;
    });

    return [
        `/* MAGEPACK MIXIN WEAVER: ${targetModuleId} */`,
        `(function() {`,
        `    var ctx = require.s.contexts._;`,
        `    var key = "${targetModuleId}";`,
        `    if (ctx.__magepackWoven && ctx.__magepackWoven[key]) return;`,
        `    require([${deps.join(', ')}], function(${params.join(', ')}) {`,
        `        var __woven__ = ${chainExpr};`,
        `        ctx.defined[key] = __woven__;`,
        `        define(key, function() { return ctx.defined[key]; });`,
        `        ctx.__magepackWoven = ctx.__magepackWoven || {};`,
        `        ctx.__magepackWoven[key] = true;`,
        `    });`,
        `})();`,
    ].join('\n');
};

/**
 * Resolves mixin configuration for a locale by reading its `requirejs-config.js`.
 *
 * @async
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @param {boolean} isMinifyOn - Whether to read the minified config variant.
 * @returns {Promise<Record<string, Record<string, boolean>>>} The merged mixin config.
 *   Returns an empty object if the config file is missing or unparseable.
 */
const loadMixinConfig = async (localePath, isMinifyOn) => {
    const configFileName = isMinifyOn
        ? FILES.REQUIREJS_CONFIG_MIN
        : FILES.REQUIREJS_CONFIG;

    const configPath = path.join(localePath, configFileName);

    try {
        await fs.access(configPath);
        const content = await fs.readFile(configPath, 'utf8');
        return extractMixinsFromConfig(content);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            consola.warn(`   ⚠️  Failed to read mixin config: ${e.message}`);
        }
        return {};
    }
};

/**
 * Applies build-time mixin weaving to bundle sources.
 *
 * This is the main entry point called by the bundle processor after all modules
 * have been read, wrapped, and collected into the `sources` map.
 *
 * For each target module that has active mixins **and** is present in the bundle:
 *   1. The original `define("target", ...)` is renamed to `define("target__original", ...)`.
 *   2. A synthetic orchestrator module is appended to the sources.
 *   3. The orchestrator applies the mixin chain and overwrites the RequireJS registry.
 *
 * Additionally, updates the bundle's module map to:
 *   - Remove mixin module entries (they are consumed internally by the orchestrator).
 *   - Remove `mixins!` plugin entries from `configInjector`'s bundle declaration, so
 *     RequireJS doesn't try to intercept modules that are already fully mixed.
 *
 * @async
 * @param {Record<string, string>} sources - The bundle sources map. **Mutated in place.**
 * @param {Set<string>} includedModules - Set of module IDs successfully included.
 * @param {Object} bundle - The bundle configuration object. **Mutated in place** to
 *   remove mixin module entries from `bundle.modules`.
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @param {boolean} isMinifyOn - Whether minification is active.
 * @returns {Promise<void>}
 */
export const weaveMixins = async (sources, includedModules, bundle, localePath, isMinifyOn) => {
    const mixinConfig = await loadMixinConfig(localePath, isMinifyOn);

    if (Object.keys(mixinConfig).length === 0) {
        return;
    }

    const plan = buildWeavingPlan(mixinConfig, includedModules);

    if (plan.size === 0) {
        return;
    }

    let wovenCount = 0;

    for (const [targetId, mixinIds] of plan) {
        // Step 1: Rename the original define()
        const renamed = renameOriginalDefine(sources, targetId);

        if (!renamed) {
            consola.debug(
                `   ⚠️  [${bundle.name}] Could not find define() for "${targetId}" — skipping weave.`
            );
            continue;
        }

        // Step 2: Generate and append the orchestrator
        const orchestratorCode = generateOrchestrator(targetId, mixinIds);
        const orchestratorKey = `__magepack_weaver_${targetId.replace(/[^a-zA-Z0-9]/g, '_')}`;
        sources[orchestratorKey] = orchestratorCode;

        // Step 3: Remove mixin modules from the bundle declaration
        // They should NOT appear in require.config({bundles:...}) because:
        // - They are consumed internally by the orchestrator.
        // - If declared, RequireJS would consider them "loaded" and the mixins! plugin
        //   would skip them — but they need to NOT be in the bundle declaration so
        //   mixins! doesn't try to apply them AGAIN on top of the already-woven result.
        for (const mixinId of mixinIds) {
            delete bundle.modules[mixinId];
        }

        wovenCount++;

        consola.debug(
            `   🧬 [${bundle.name}] Woven "${targetId}" with ${mixinIds.length} mixin(s): ` +
            mixinIds.map((m) => m.split('/').pop()).join(', ')
        );
    }

    if (wovenCount > 0) {
        consola.info(
            `   🧬 [${bundle.name}] Woven ${wovenCount} target(s) with build-time mixin application.`
        );
    }
};
