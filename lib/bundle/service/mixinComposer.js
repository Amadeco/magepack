/**
 * @file lib/bundle/service/mixinComposer.js
 * @description Build-time AMD mixin composition for Magepack bundles.
 *
 * ## Problem
 *
 * Magento's `mixins!` RequireJS plugin intercepts `require.load()` to wrap target
 * modules with mixin factories. When a target is bundled, `require.load()` is never
 * called — RequireJS resolves it from its internal registry, and mixins are silently
 * skipped. Excluding modules from bundles solves the mixin issue but defeats the
 * purpose of bundling.
 *
 * ## Solution
 *
 * This service composes a mixin target with its factories **at build-time** into a
 * single self-contained code block. The composed output:
 *
 *   1. Keeps each module's `define()` call intact (target + each mixin factory).
 *   2. Appends a synchronous orchestrator IIFE that:
 *      a) Retrieves the target from RequireJS's `defined` registry.
 *      b) Retrieves each mixin factory from the registry.
 *      c) Chains: `result = mixinC(mixinB(mixinA(target)))`.
 *      d) Overwrites the registry entry with the fully-composed result.
 *   3. Replaces the target entry in the bundle's `wrappedModules` map.
 *   4. Reports the mixin IDs as "absorbed" so the processor removes them from
 *      both the bundle output and the `require.config({bundles:...})` declaration.
 *
 * ## Why this works inside a bundle
 *
 * When RequireJS loads a bundle script, it executes all `define()` calls
 * synchronously. Each `define("name", deps, factory)` registers the module in
 * `require.s.contexts._.defined` immediately (for named modules with already-
 * resolved dependencies). The orchestrator IIFE at the end of the composed block
 * runs synchronously after all `define()`s, so every module is available in the
 * registry at that point.
 *
 * ## Why mixin modules are absorbed (not declared in bundles config)
 *
 * If a mixin factory were declared in `require.config({bundles: ...})`, RequireJS
 * would consider it "loaded" globally. On pages that load the target individually
 * (without the bundle), the `mixins!` plugin would find the mixin already
 * "provided" by the bundle and skip loading it — but the bundle isn't loaded on
 * that page, so the mixin silently disappears. By removing mixin factories from
 * the declaration, they remain invisible to RequireJS's bundle resolution,
 * allowing `mixins!` to load them individually on non-bundled pages.
 *
 * @module bundle/service/mixinComposer
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.1.0: Initial implementation.
 */

import consola from 'consola';

/**
 * Composes a mixin target with its mixin factories into a single code block.
 *
 * The composed output is a concatenation of:
 *   1. The original target `define()` — unchanged.
 *   2. Each mixin factory `define()` — unchanged.
 *   3. A synchronous orchestrator IIFE that chains the mixins.
 *
 * The orchestrator accesses RequireJS internals (`require.s.contexts._.defined`)
 * to retrieve and overwrite the target's registry entry. This is the same
 * mechanism Magento's own `mixins!` plugin uses at runtime.
 *
 * A guard flag (`__magepackComposed`) prevents double-application if the
 * bundle script is loaded more than once (e.g., async fallback scenarios).
 *
 * @param {string} targetId - The RequireJS module ID of the mixin target
 *   (e.g., `"Magento_Swatches/js/swatch-renderer"`).
 * @param {string} targetContent - The wrapped AMD source code of the target module.
 *   Must contain a `define("targetId", ...)` call.
 * @param {Array<{ mixinId: string, wrappedContent: string }>} mixinSources -
 *   Ordered array of mixin factories to apply. Each entry contains the mixin's
 *   RequireJS module ID and its wrapped AMD source code.
 * @returns {{ compositeContent: string, absorbedMixinIds: string[] }}
 *   - `compositeContent`: The full composed code block (target + mixins + orchestrator).
 *   - `absorbedMixinIds`: Array of mixin module IDs that were absorbed into the
 *     composite and should be removed from the bundle declaration.
 *
 * @example
 *   const { compositeContent, absorbedMixinIds } = composeMixinTarget(
 *     'Magento_Swatches/js/swatch-renderer',
 *     'define("Magento_Swatches/js/swatch-renderer", [...], function(...) { ... })',
 *     [
 *       { mixinId: 'Yireo_Webp2/js/swatch-renderer-mixin', wrappedContent: 'define(...)' },
 *       { mixinId: 'Amadeco_.../swatch-renderer-mixin', wrappedContent: 'define(...)' }
 *     ]
 *   );
 *   // compositeContent contains: target define + mixin defines + orchestrator IIFE
 *   // absorbedMixinIds = ['Yireo_Webp2/...', 'Amadeco_...']
 */
export const composeMixinTarget = (targetId, targetContent, mixinSources) => {
    if (!mixinSources || mixinSources.length === 0) {
        return {
            compositeContent: targetContent,
            absorbedMixinIds: [],
        };
    }

    const absorbedMixinIds = mixinSources.map((s) => s.mixinId);

    // Escape the target ID for safe embedding in generated JS strings
    const escapedTargetId = targetId
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');

    // ---------------------------------------------------------------
    // Build the orchestrator IIFE
    //
    // How it works:
    //   1. Access RequireJS default context's `defined` registry.
    //   2. Retrieve the target module's exported value.
    //   3. Retrieve each mixin factory function.
    //   4. Chain: result = factory_N(...(factory_1(factory_0(target))))
    //   5. Overwrite the registry entry so all future require() calls
    //      get the fully-composed version.
    //
    // All modules are already in `defined` at this point because their
    // `define()` calls ran synchronously earlier in this same bundle
    // script execution.
    // ---------------------------------------------------------------

    const mixinRetrievals = mixinSources.map((s, i) => {
        const escapedMixinId = s.mixinId
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"');

        return `        var __mixin${i}__ = ctx.defined["${escapedMixinId}"];`;
    });

    // Build the chaining expression: __mixin2__(__mixin1__(__mixin0__(__target__)))
    let chainExpr = '__target__';
    mixinSources.forEach((_, i) => {
        chainExpr = `__mixin${i}__(${chainExpr})`;
    });

    // Build mixin availability checks
    const mixinChecks = mixinSources.map((_, i) =>
        `        if (typeof __mixin${i}__ !== "function") return;`
    );

    const orchestratorLines = [
        '',
        `/* MAGEPACK MIXIN COMPOSER: ${targetId} (${mixinSources.length} mixin(s)) */`,
        `(function() {`,
        `    var ctx = require.s.contexts._;`,
        `    var key = "${escapedTargetId}";`,
        ``,
        `    /* Guard: prevent double-application */`,
        `    if (ctx.__magepackComposed && ctx.__magepackComposed[key]) return;`,
        ``,
        `    var __target__ = ctx.defined[key];`,
        ``,
        `    /* Verify target is resolved */`,
        `    if (typeof __target__ === "undefined") return;`,
        ``,
        ...mixinRetrievals,
        ``,
        `    /* Verify all mixin factories are available */`,
        ...mixinChecks,
        ``,
        `    /* Apply mixin chain */`,
        `    ctx.defined[key] = ${chainExpr};`,
        ``,
        `    /* Mark as composed to prevent re-application */`,
        `    ctx.__magepackComposed = ctx.__magepackComposed || {};`,
        `    ctx.__magepackComposed[key] = true;`,
        `})();`,
    ];

    // ---------------------------------------------------------------
    // Assemble the composite
    //
    // Order matters:
    //   1. Original target define() — registers the unmixed value
    //   2. Each mixin factory define() — registers the wrapper functions
    //   3. Orchestrator IIFE — reads all, chains, overwrites target
    //
    // This order is guaranteed because all three blocks are concatenated
    // into a single string that executes top-to-bottom when the bundle
    // script loads.
    // ---------------------------------------------------------------

    const parts = [
        targetContent,
        ...mixinSources.map((s) => s.wrappedContent),
        orchestratorLines.join('\n'),
    ];

    const compositeContent = parts.join('\n');

    consola.debug(
        `   🧬 Composed "${targetId}" with ${mixinSources.length} mixin(s): ` +
        absorbedMixinIds.map((id) => id.split('/').pop()).join(', ')
    );

    return {
        compositeContent,
        absorbedMixinIds,
    };
};
