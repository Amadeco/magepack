import { createPageCollector } from './factory.js';

/**
 * Collects RequireJS modules from a specific CMS page (e.g., Homepage, About Us).
 */
export default createPageCollector('cms', 'cmsUrl');
