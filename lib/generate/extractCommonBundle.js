/**
 * @file lib/generate/extractCommonBundle.js
 * @description Splits modules into Vendor, Common, and Page-Specific bundles
 * ensuring strict exclusivity and performance safety.
 *
 * This module implements the "Smart Splitting" algorithm that categorizes collected
 * RequireJS modules into three tiers:
 *   1. **Vendor**: Core infrastructure (jQuery, KnockoutJS, RequireJS internals, Fotorama).
 *   2. **Common**: Business logic shared across 2+ non-transactional page types.
 *   3. **Page-specific**: Modules unique to CMS, Category, Product, or Checkout.
 *
 * The algorithm preserves the original module execution order captured by Puppeteer
 * during the `generate` phase, ensuring RequireJS dependency chains remain intact.
 *
 * @module generate/extractCommonBundle
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.0.1: Fixed dead regex patterns in `CRITICAL_PATTERN_MODULES`. The patterns
 *     for `jquery/jquery` and `jquery/jquery-migrate` required a `.js` suffix
 *     (e.g., `/^jquery\/jquery(\.min)?\.js$/`), but `cleanModuleName()` strips `.js`
 *     before the regex test, so they never matched. Removed the `.js` requirement
 *     from all affected patterns.
 *   - v3.0.1: Added `fotorama/` to `CRITICAL_PATTERN_MODULES` as a defense-in-depth
 *     measure. If Fotorama is ever re-included in collection (removed from
 *     `excludedModules.js`), this ensures it lands in the Vendor bundle alongside
 *     jQuery, preserving correct `$.fn` initialization order.
 */

/**
 * ============================================================================
 * CONSTANTS & CONFIGURATION
 * ============================================================================
 */

/**
 * MIN_USAGE_THRESHOLD
 * Determines the promotion strategy for shared modules.
 *
 * @type {number}
 * @default 2
 *
 * Strategy:
 * - 2: Aggressive. Modules used on >= 2 distinct page types move to 'common'.
 * (e.g., Category + Product).
 * *Note:* Protected by Transactional Isolation logic below.
 */
const MIN_USAGE_THRESHOLD = 2;

/**
 * TRANSACTIONAL_BUNDLES
 * List of bundles considered "Transactional" or "Private".
 * Modules shared *only* between these bundles should NOT be promoted to global common,
 * as they would unnecessarily bloat the Homepage/Landing pages.
 *
 * @type {Set<string>}
 */
const TRANSACTIONAL_BUNDLES = new Set(['checkout', 'cart']);

/**
 * MIN_BUNDLE_MODULES
 * Minimum number of modules a page-specific bundle must contain to be emitted.
 *
 * Page-specific bundles below this threshold are dropped from the output.
 * Their modules are NOT moved to common (that would bloat every page). Instead
 * they simply load individually via RequireJS — under HTTP/2 the cost of a few
 * individual requests is negligible, while a dedicated bundle file adds a full
 * roundtrip for minimal JS payload.
 *
 * vendor and common are always emitted regardless of this threshold.
 *
 * @type {number}
 * @default 5
 */
const MIN_BUNDLE_MODULES = 1;

/**
 * MANUAL_COMMON_MODULES
 * List of modules that are explicitly forced into the 'common' bundle,
 * regardless of their usage count.
 * Useful for business logic that you always want available.
 *
 * @type {string[]}
 */
const MANUAL_COMMON_MODULES = [
    // 'Magento_Customer/js/customer-data' // Example: Force customer data logic globally
];

/**
 * CRITICAL_EXACT_MODULES (Vendor Forced)
 * List of critical module paths (exact match) that MUST be included in the Vendor bundle.
 * These files are requested early and must be present to prevent 404/MIME errors.
 *
 * @type {Set<string>}
 */
const CRITICAL_EXACT_MODULES = new Set([
    'Magento_PageCache/js/form-key-provider',
    'Magento_Theme/js/responsive',
    'Magento_Theme/js/theme',
    'Magento_Translation/js/mage-translation-dictionary',
    'Magento_Ui/js/core/app',
    'Magento_Ui/js/modal/modal',
    'mage/requirejs/resolver'
]);

/**
 * CRITICAL_PATTERN_MODULES (Vendor Forced via Regex)
 * Regular expressions identifying Core Infrastructure modules (Kernel).
 *
 * IMPORTANT: These patterns are tested against the output of `cleanModuleName()`,
 * which strips the `.js` extension and plugin prefixes. Patterns must NOT require
 * a `.js` suffix — it will never be present at test time.
 *
 * @type {RegExp[]}
 *
 * @changelog
 *   - v3.0.1: Removed `.js` suffix requirement from `jquery/jquery` and
 *     `jquery/jquery-migrate` patterns. After `cleanModuleName()` strips extensions,
 *     these regexes never matched, causing jQuery to only reach vendor via the
 *     shared-module threshold (fragile) instead of the guaranteed critical path.
 *   - v3.0.1: Added `fotorama/` pattern. Fotorama is a jQuery plugin that extends
 *     `$.fn.fotorama` and must load in the same bundle as jQuery to ensure correct
 *     prototype registration order. This is a defense-in-depth measure — the primary
 *     fix excludes Fotorama from collection entirely (see `excludedModules.js`).
 */
const CRITICAL_PATTERN_MODULES = [
    /^mage\/(?!calendar|gallery)/,  // Magento Core Libs (excluding heavy UI)
    /^requirejs\//,                 // RequireJS internals
    /^text$/,                       // RequireJS Text Plugin
    /^domReady$/,                   // RequireJS DomReady Plugin
    /^jquery\/jquery$/,             // jQuery Core (exact, after .js is stripped)
    /^jquery\/jquery-migrate/,      // jQuery Migrate (prefix match)
    /^jquery\/jquery-storageapi/,   // jQuery Storage API
    /^underscore$/,                 // Underscore.js
    /^knockoutjs\/knockout$/,       // Knockout JS
    /^fotorama\//                   // Fotorama jQuery Plugin (defense-in-depth)
];

/**
 * MAGENTO_MODULE_REGEX
 * Identifies standard Magento 2 module naming convention (Vendor_Module).
 * Used to distinguish "Business Logic" (Common) from "Libraries" (Vendor).
 *
 * @type {RegExp}
 */
const MAGENTO_MODULE_REGEX = /^[A-Z][a-zA-Z0-9]+_[A-Z][a-zA-Z0-9]+\//;

/**
 * ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * Normalizes a RequireJS module name by stripping plugin prefixes and file extensions.
 *
 * Examples:
 *   - `text!Magento_Theme/template/header.html` → `Magento_Theme/template/header.html`
 *   - `Magento_Catalog/js/price-box.js` → `Magento_Catalog/js/price-box`
 *   - `jquery/jquery.min.js` → `jquery/jquery.min` (only strips final `.js`)
 *
 * @param {string} moduleName - The raw RequireJS module ID.
 * @returns {string} The cleaned module name without plugin prefix or `.js` extension.
 */
const cleanModuleName = (moduleName) => {
    return moduleName
        .replace(/^[^!]+!/, '') // Remove plugin prefix (e.g., "text!")
        .replace(/\.js$/, '');  // Remove trailing .js extension
};

/**
 * Checks if a module is strictly required in the Vendor bundle.
 *
 * Tests against both the exact match set and the pattern list.
 *
 * @param {string} cleanName - The cleaned module name (output of `cleanModuleName`).
 * @returns {boolean} True if the module is critical infrastructure.
 */
const isCriticalInfrastructure = (cleanName) => {
    if (CRITICAL_EXACT_MODULES.has(cleanName)) return true;
    return CRITICAL_PATTERN_MODULES.some((pattern) => pattern.test(cleanName));
};

/**
 * Determines the destination bundle type based on module naming conventions.
 *
 * Routing logic:
 *   - HTML/JSON templates → Common (Magento UI component templates)
 *   - Critical infrastructure → Vendor (jQuery, KnockoutJS, RequireJS, Fotorama)
 *   - Magento modules (`Vendor_Module/...`) → Common (business logic)
 *   - Everything else → Vendor (third-party libraries)
 *
 * @param {string} cleanName - The cleaned module name.
 * @returns {'vendor'|'common'} The target bundle type.
 */
const getTargetBundleType = (cleanName) => {
    if (/\.(html|json)$/i.test(cleanName)) return 'common';
    if (isCriticalInfrastructure(cleanName)) return 'vendor';
    if (MAGENTO_MODULE_REGEX.test(cleanName)) return 'common';
    return 'vendor';
};

/**
 * Checks if a module is explicitly configured as common.
 *
 * @param {string} moduleName - The raw module name.
 * @returns {boolean} True if the module is in the `MANUAL_COMMON_MODULES` list.
 */
const isExplicitlyCommon = (moduleName) => {
    return MANUAL_COMMON_MODULES.includes(cleanModuleName(moduleName));
};

/**
 * ============================================================================
 * MAIN LOGIC
 * ============================================================================
 */

/**
 * Extracts common and vendor modules from page-specific bundles while preserving
 * execution order.
 *
 * Algorithm:
 *   1. **Discovery**: Single-pass scan to build a `Map<moduleName, Set<bundleName>>`
 *      tracking which bundles use each module, plus a global order set.
 *   2. **Classification**: Each module is routed to vendor, common, or left in its
 *      page-specific bundle based on usage count, transactional isolation, and
 *      critical infrastructure patterns.
 *   3. **Cleanup**: Promoted modules are removed from their original bundles to
 *      enforce strict exclusivity (no module appears in more than one bundle).
 *   4. **Assembly**: Vendor and Common bundles are prepended to the output array,
 *      followed by the (now cleaned) page-specific bundles.
 *
 * @param {Array<{name: string, modules: Object.<string, string>}>} bundles - The collected
 *   page-specific bundles from the `generate` phase.
 * @returns {Array<{name: string, modules: Object.<string, string>}>} The final bundle array
 *   with Vendor and Common prepended.
 */
export default function (bundles) {
    const vendorModules = new Map();
    const commonModules = new Map();

    /**
     * Module presence map: tracks which bundles contain each module.
     * Built in a single pass to avoid the O(modules × bundles) re-scan
     * that the previous two-pass approach required.
     *
     * @type {Map<string, Set<string>>}
     */
    const modulePresence = new Map();

    // Global insertion order set — captures the FIRST time each module appears
    // to establish a safe dependency loading order.
    const globalOrder = new Set();

    // 1. Discovery: Single-pass usage analysis
    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            // Track which bundles contain this module
            if (!modulePresence.has(moduleName)) {
                modulePresence.set(moduleName, new Set());
            }
            modulePresence.get(moduleName).add(bundle.name);

            // Record strict insertion order
            globalOrder.add(moduleName);
        });
    });

    // 2. Classification & Routing (following Global Order)
    globalOrder.forEach((moduleName) => {
        const cleanName = cleanModuleName(moduleName);
        const presence = modulePresence.get(moduleName);
        const count = presence.size;

        const isForcedVendor = isCriticalInfrastructure(cleanName);
        const isConfigured = isExplicitlyCommon(moduleName);

        // --- TRANSACTIONAL ISOLATION ---
        // Check if the module is isolated to Transactional pages (Cart/Checkout).
        // Modules shared only between transactional bundles should NOT be promoted
        // to global common, as they would unnecessarily bloat the Homepage/Landing pages.
        const isJustTransactional = [...presence].every(bundleName =>
            TRANSACTIONAL_BUNDLES.has(bundleName)
        );

        // A module is "Shared" if:
        // 1. Usage count meets threshold (e.g., 2+)
        // 2. AND it is NOT strictly isolated to transactional flows (Cart+Checkout)
        const isShared = count >= MIN_USAGE_THRESHOLD && !isJustTransactional;

        if (isForcedVendor || isShared || isConfigured) {
            // Find the physical path from the first bundle that has it
            const sourceBundle = bundles.find(b => b.modules[moduleName]);
            if (!sourceBundle) return;

            const modulePath = sourceBundle.modules[moduleName];
            const targetType = getTargetBundleType(cleanName);

            // Routing Logic:
            // - Forced vendor OR (vendor-typed AND shared/configured) → Vendor
            // - Everything else → Common
            if (isForcedVendor || (targetType === 'vendor' && (isShared || isConfigured))) {
                vendorModules.set(moduleName, modulePath);
            } else {
                commonModules.set(moduleName, modulePath);
            }
        }
    });

    // 3. Cleanup Original Bundles
    // Remove promoted modules from their original location to enforce exclusivity.
    // No module should appear in more than one bundle.
    const keysToRemove = new Set([...vendorModules.keys(), ...commonModules.keys()]);

    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((key) => {
            if (keysToRemove.has(key)) {
                delete bundle.modules[key];
            }
        });
    });

    // 4. Assembly: Vendor and Common are always first (loaded before page-specific).
    //    Page-specific bundles below MIN_BUNDLE_MODULES are dropped — their modules
    //    load individually via RequireJS (HTTP/2 makes this cheap for tiny sets).
    const pageSpecific = bundles.filter((bundle) => {
        const count = Object.keys(bundle.modules).length;
        if (count < MIN_BUNDLE_MODULES) {
            // eslint-disable-next-line no-console
            console.info(
                `[magepack] Dropping bundle "${bundle.name}" (${count} module(s) < threshold ${MIN_BUNDLE_MODULES}). ` +
                `Modules will load individually via RequireJS.`
            );
            return false;
        }
        return true;
    });

    return [
        {
            name: 'vendor',
            modules: Object.fromEntries(vendorModules)
        },
        {
            name: 'common',
            modules: Object.fromEntries(commonModules)
        },
        ...pageSpecific
    ];
}
