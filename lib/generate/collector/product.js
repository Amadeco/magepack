import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import authenticate from '../authenticate.js';
import blockMagepack from '../blockMagepack.js';
import collectModules from '../collectModules.js';

const baseConfig = {
    url: [],
    name: 'product',
    modules: {},
};

const product = async (
    browserContext,
    { productUrl, authUsername, authPassword }
) => {
    const bundleConfig = merge({}, baseConfig);
    const bundleName = bundleConfig.name;

    logger.info(`Collecting modules for bundle "${bundleName}".`);

    const page = await browserContext.newPage();
    await blockMagepack(page);
    await authenticate(page, authUsername, authPassword);

    await page.goto(productUrl, { waitUntil: 'networkidle0' });

    merge(bundleConfig.modules, await collectModules(page));

    await page.close();

    logger.success(`Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

export default product;
