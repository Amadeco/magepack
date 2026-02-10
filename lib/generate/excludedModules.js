/**
 * List of modules that should be ignored during bundling.
 * These are typically dynamic or environment-specific.
 */
export default [
    /**
     * Loaded and defined synchronously, should be skipped.
     */
    'mixins',
    
    /**
     * Build-in RequireJS modules.
     */
    'require',
    'module',
    'exports',
    
    /**
     * Also known as legacyBuild.min.js, still used by some extensions.
     * Overwrites native objects sometimes causing bugs so it's safer to exclude it.
     */
    'prototype'
];
