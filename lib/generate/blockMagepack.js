import logger from '../utils/logger.js';

/**
 * Blocks Magepack generation script to prevent infinite loops/recursion
 * when visiting pages that might already have Magepack bundles active.
 */
const blockMagepack = async (page) => {
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
        if (request.url().includes('magepack/bundle-')) {
            page.magepackDirty = true;
            
            logger.warn(`🛑 DETECTED: Existing bundle: ${request.url()}`);
            request.abort();
        } else {
            request.continue();
        }
    });
};

export default blockMagepack;
