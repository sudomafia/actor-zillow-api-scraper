const Apify = require('apify');
const got = require('got');
const {parseCSV} = require('csv-load-sync');
const HeaderGenerator = require('header-generator');
const _ = require('lodash');
const { LABELS, TYPES, INITIAL_URL } = require('./constants');
const fns = require('./functions');

const {
    createGetSimpleResult,
    createQueryZpid,
    proxyConfiguration,
    interceptQueryId,
    queryRegionHomes,
    splitQueryState,
    quickHash,
    getUrlData,
    extendFunction,
    translateQsToFilter,
} = fns;

const { log, puppeteer, sleep } = Apify.utils;

Apify.main(async () => {
    /**
     * @type {any}
     */
    const input = await Apify.getInput();

    if (input.debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    const isDebug = input.debugLog === true;

    // Check input
    if (!(input.search && input.search.trim().length > 0) && !input.startUrls && !input.zpids && !input.propertyUrls) {
        throw new Error('Either "search", "startUrls", "propertyUrls" or "zpids" attribute has to be set!');
    }

    const proxyConfig = await proxyConfiguration({
        proxyConfig: {
            ...input.proxyConfiguration,
        },
        hint: ['RESIDENTIAL'],
    });

    if (proxyConfig?.groups?.includes('RESIDENTIAL')) {
        proxyConfig.countryCode = 'US';
    }

    // Initialize minimum time
    const minMaxDate = fns.minMaxDates({
        min: input.minDate,
        max: input.maxDate,
    });

    // Toggle showing only a subset of result attributes

    const simpleResult = {
        address: true,
        bedrooms: true,
        bathrooms: true,
        price: true,
        yearBuilt: true,
        longitude: true,
        homeStatus: true,
        latitude: true,
        description: true,
        livingArea: true,
        currency: true,
        hdpUrl: true,
        hugePhotos: true,
    };

    const getSimpleResult = createGetSimpleResult(
        input.simple
            ? simpleResult
            : {
                ...simpleResult,
                datePosted: true,
                isZillowOwned: true,
                priceHistory: true,
                zpid: true,
                isPremierBuilder: true,
                primaryPublicVideo: true,
                tourViewCount: true,
                postingContact: true,
                unassistedShowing: true,
                homeType: true,
                comingSoonOnMarketDate: true,
                timeZone: true,
                newConstructionType: true,
                moveInReady: true,
                moveInCompletionDate: true,
                lastSoldPrice: true,
                contingentListingType: true,
                zestimate: true,
                zestimateLowPercent: true,
                zestimateHighPercent: true,
                rentZestimate: true,
                restimateLowPercent: true,
                restimateHighPercent: true,
                solarPotential: true,
                brokerId: true,
                parcelId: true,
                homeFacts: true,
                taxAssessedValue: true,
                taxAssessedYear: true,
                isPreforeclosureAuction: true,
                listingProvider: true,
                marketingName: true,
                building: true,
                priceChange: true,
                datePriceChanged: true,
                dateSold: true,
                lotSize: true,
                hoaFee: true,
                mortgageRates: true,
                propertyTaxRate: true,
                whatILove: true,
                isFeatured: true,
                isListedByOwner: true,
                isCommunityPillar: true,
                pageViewCount: true,
                favoriteCount: true,
                openHouseSchedule: true,
                brokerageName: true,
                taxHistory: true,
                abbreviatedAddress: true,
                ownerAccount: true,
                isRecentStatusChange: true,
                isNonOwnerOccupied: true,
                buildingId: true,
                daysOnZillow: true,
                rentalApplicationsAcceptedType: true,
                buildingPermits: true,
                highlights: true,
                tourEligibility: true,
            },
    );

    const zpids = new Set(await Apify.getValue('STATE'));

    Apify.events.on('migrating', async () => {
        await Apify.setValue('STATE', [...zpids.values()]);
    });

    const requestQueue = await Apify.openRequestQueue();

    /**
     * @type {Apify.RequestOptions[]}
     */
    const startUrls = [];

    if (input.search && input.search.trim()) {
        const term = input.search.trim();

        startUrls.push({
            url: 'https://www.zillow.com',
            uniqueKey: `${term}`,
            userData: {
                label: LABELS.SEARCH,
                term,
            },
        });
    }

    if (input.startUrls && input.startUrls.length) {
        if (input.type) {
            log.warning(`Input type "${input.type}" will be ignored as the value is derived from start url.
            Check if your start urls match the desired home status.`);
        }

        const parsingUrl = input.startUrls[0].requestsFromUrl;
        let records;
        if (parsingUrl){
            const { body: csv } = await got(parsingUrl);
            records = parseCSV(csv);

            let address = "";
            let url = "";
            input.startUrls = []

            records.forEach(function (row, index) {
                address = [row['STREET_NUMBER'] + row['STREET_NAME'], row['CITY'], row['STATE'],row['ZIP_CODE']].join(',')
                url = "https://www.zillow.com/homes/" + address.replace(' ', '-') + '_rb/'
                input.startUrls.push({
                    url: url,
                    id: row['ID'],
                    userData: {
                        eid: row['ID']
                    }
                });
            });
        }

        const requestList = await Apify.openRequestList('STARTURLS', input.startUrls);

        let req;
        while (req = await requestList.fetchNextRequest()) { // eslint-disable-line no-cond-assign
            if (!req.url.includes('zillow.com')) {
                throw new Error(`Invalid startUrl ${req.url}`);
            }

            const urlData = getUrlData(req.url);
            urlData.eid = req.id;
            startUrls.push({
                url: req.url,
                userData: urlData,
            });
        }
    }

    if (input.zpids && input.zpids.length) {
        startUrls.push({
            url: 'https://www.zillow.com/',
            uniqueKey: 'ZPIDS',
            userData: {
                label: LABELS.ZPIDS,
            },
        });
    }

    /**
     * @type {ReturnType<typeof createQueryZpid>}
     */
    let queryZpid = null;
    /**
     * @type {any}
     */
    const savedQueryId = await Apify.getValue('QUERY');

    if (savedQueryId?.queryId && savedQueryId?.clientVersion) {
        queryZpid = createQueryZpid(savedQueryId.queryId, savedQueryId.clientVersion);
    } else {
        await requestQueue.addRequest({
            url: INITIAL_URL,
            uniqueKey: `${Math.random()}`,
            userData: {
                label: LABELS.INITIAL,
            },
        }, { forefront: true });
    }

    const isOverItems = (extra = 0) => (typeof input.maxItems === 'number' && input.maxItems > 0
        ? (zpids.size + extra) >= input.maxItems
        : false);

    const extendOutputFunction = await extendFunction({
        map: async (data) => getSimpleResult(data),
        filter: async ({ data }) => {
            if (isOverItems()) {
                return false;
            }

            if (!_.get(data, 'zpid')) {
                return false;
            }

            if (!minMaxDate.compare(data.datePosted) || zpids.has(`${data.zpid}`)) {
                return false;
            }

            if (input.startUrls) {
                // ignore input.type when it is set in start url
                return true;
            }

            switch (input.type) {
                case 'sale':
                    return data.homeStatus === 'FOR_SALE';
                case 'fsbo':
                    return data.homeStatus === 'FOR_SALE' && data.keystoneHomeStatus === 'ForSaleByOwner';
                case 'rent':
                    return data.homeStatus === 'FOR_RENT';
                case 'sold':
                    return data.homeStatus?.includes('SOLD');
                case 'all':
                default:
                    return true;
            }
        },
        output: async (output, { data }) => {
            if (data.zpid && !isOverItems()) {
                zpids.add(`${data.zpid}`);
                await Apify.pushData(output);
            }
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            getUrlData,
            getSimpleResult,
            _,
            zpids,
            minMaxDate,
            TYPES,
            fns,
            LABELS,
        },
    });

    const extendScraperFunction = await extendFunction({
        output: async () => {}, // no-op
        input,
        key: 'extendScraperFunction',
        helpers: {
            proxyConfig,
            startUrls,
            getUrlData,
            requestQueue,
            get queryZpid() {
                // if we use the variable here won't change to the actual function
                // and will always get null
                return queryZpid;
            },
            getSimpleResult,
            zpids,
            _,
            fns,
            extendOutputFunction,
            minMaxDate,
        },
    });

    const dump = Apify.utils.log.LEVELS.DEBUG === Apify.utils.log.getLevel() ? async (zpid, data) => {
        if (zpid != +zpid) {
            await Apify.setValue(`DUMP-${Math.random()}`, data);
        }
    } : () => {};

    await extendScraperFunction(undefined, {
        label: 'SETUP',
    });

    const headerGenerator = new HeaderGenerator({
        browsers: [
            { name: 'chrome', minVersion: 87 },
        ],
        devices: [
            'desktop',
        ],
        operatingSystems: process.platform === 'win32'
            ? ['windows']
            : ['linux'],
    });

    let isFinishing = false;

    // Create crawler
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestRetries: input.maxRetries || 20,
        handlePageTimeoutSecs: !queryZpid
            ? 120
            : input.handlePageTimeoutSecs || 3600,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: {
                maxErrorScore: 0.5,
            },
        },
        proxyConfiguration: proxyConfig,
        preNavigationHooks: [async ({ request, page }, gotoOptions) => {
            const userAgent = headerGenerator.getHeaders()['user-agent'];
            log.debug(`User-agent: ${userAgent}`);

            await page.setUserAgent(userAgent);

            await puppeteer.blockRequests(page, {
                urlPatterns: [
                    '.gif',
                    '.webp',
                    '.jpeg',
                    '.jpg',
                    '.png',
                    '.ttf',
                    '.css.map',
                    'www.googletagmanager.com',
                    'www.googletagservices.com',
                    'www.googleadservices.com',
                    'www.google-analytics.com',
                    'sb.scorecardresearch.com',
                    'cdn.ampproject.org',
                    'doubleclick.net',
                    'pagead2.googlesyndication.com',
                    'amazon-adsystem.com',
                    'tpc.googlesyndication.com',
                    'googleads.g.doubleclick.net',
                    'pxl.jivox.com',
                    'ib.adnxs.com',
                    'static.ads-twitter.com',
                    'bat.bing.com',
                    'px-cloud.net',
                    'fonts.gstatic.com',
                    'tiqcdn.com',
                    'fonts.googleapis.com',
                    'photos.zillowstatic.com',
                    'survata.com',
                    'zg-api.com',
                    'accounts.google.com',
                    'casalemedia.com',
                    'adsystem.com',
                    '/collector',
                    'tapad.com',
                    'cdn.pdst.fm',
                    'pdst-events-prod-sink',
                    'doubleclick.net',
                    'ct.pinterest.com',
                    'sync.ipredictive.com',
                    'adservice.google.com',
                    'adsrvr.org',
                    'pubmatic.com',
                    'sentry-cdn.com',
                    'api.rlcdn.com',
                ].concat(request.userData.label === LABELS.DETAIL ? [
                    'maps.googleapis.com',
                    '.js',
                ] : []),
            });

            await extendScraperFunction(undefined, {
                page,
                request,
                label: 'GOTO',
            });

            const { label } = request.userData;

            gotoOptions.timeout = 60000;
            gotoOptions.waitUntil = label === LABELS.DETAIL
                ? 'domcontentloaded'
                : 'load';
        }],
        postNavigationHooks: [async () => {
            if (isOverItems() && !isFinishing) {
                isFinishing = true;
                log.info('Reached maximum items, waiting for finish');
                await Promise.all([
                    crawler.autoscaledPool.pause(),
                    crawler.autoscaledPool.resolve(),
                ]);
            }
        }],
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
            preLaunchHooks: [async (pageId, launchContext) => {
                launchContext.launchOptions = {
                    ...launchContext.launchOptions,
                    bypassCSP: true,
                    ignoreHTTPSErrors: true,
                    devtools: input.debugLog,
                    headless: false,
                };

                if (queryZpid !== null) {
                    fns.changeHandlePageTimeout(crawler, input.handlePageTimeoutSecs || 3600);
                }
            }],
            postPageCloseHooks: [async (pageId, browserController) => {
                if (!browserController?.launchContext?.session?.isUsable()) {
                    log.debug('Session is not usable');
                    await browserController.close();
                }
            }],
        },
        maxConcurrency: !queryZpid ? 1 : 10,
        handlePageFunction: async ({ page, request, crawler: { autoscaledPool }, session, response, proxyInfo }) => {
            if (!response || isOverItems()) {
                await page.close();
                if (!response) {
                    throw new Error('No response from page');
                }
                return;
            }

            // Retire browser if captcha is found
            if (await page.$('.captcha-container')) {
                session.retire();
                throw new Error('Captcha found, retrying...');
            }

            let anyErrors = false;

            /**
             * Extract home data by ZPID
             * @param {string} zpid
             * @param {string} detailUrl
             */
            const processZpid = async (zpid, detailUrl, eid) => {
                if (isOverItems()) {
                    return;
                }

                try {
                    if (!zpid) {
                        throw new Error(`Zpid not string or number`);
                    }

                    if (+zpid != zpid) {
                        throw new Error('Invalid non-numeric zpid');
                    }

                    if (zpids.has(`${zpid}`)) {
                        return;
                    }

                    if (!session.isUsable()) {
                        throw new Error('Not trying to retrieve data');
                    }

                    log.debug(`Extracting ${zpid}`);

                    await extendOutputFunction(
                        JSON.parse(await queryZpid(page, zpid)).data.property,
                        {
                            request,
                            page,
                            zpid,
                            eid,
                        },
                    );
                } catch (e) {
                    anyErrors = true;
                    session.markBad();
                    log.debug('processZpid', { error: e });

                    if (isOverItems()) {
                        return;
                    }

                    // add as a separate detail for retrying
                    await requestQueue.addRequest({
                        url: new URL(detailUrl || `/homedetails/${zpid}_zpid/`, 'https://www.zillow.com').toString(),
                        userData: {
                            label: LABELS.DETAIL,
                            zpid: +zpid,
                            eid: eid
                        },
                    }, { forefront: true });
                } finally {
                    await sleep(100);
                }
            };

            const { label } = request.userData;

            if (label === LABELS.INITIAL || !queryZpid) {
                try {
                    log.info('Trying to get queryId ...');

                    const { queryId, clientVersion } = await interceptQueryId(page, proxyInfo);

                    if (!queryId || !clientVersion) {
                        throw new Error('queryId unavailable');
                    }

                    if (!queryZpid) {
                        // avoid a racing condition here because of interceptQueryId being stuck forever or for a long time
                        log.debug('Intercepted queryId', { queryId, clientVersion });

                        queryZpid = createQueryZpid(queryId, clientVersion);

                        await Apify.setValue('QUERY', { queryId, clientVersion });

                        autoscaledPool.maxConcurrency = 10;

                        // now that we initialized, we can add the requests
                        for (const req of startUrls) {
                            await requestQueue.addRequest(req);
                        }

                        log.info('Got queryId, continuing...');
                    }
                } catch (e) {
                    session.retire();
                    throw e;
                }
            } else if (label === LABELS.DETAIL) {
                if (isOverItems()) {
                    return;
                }

                log.debug(`Scraping ${page.url()}`);

                if (request.url.startsWith('/b/') || !+request.userData.zpid) {
                    const nextData = await page.$eval('[id="__NEXT_DATA__"]', (s) => JSON.parse(s.innerHTML));

                    if (!nextData) {
                        throw new Error('Missing data');
                    }

                    // legacy layout, need re-enqueue
                    const zpid = _.get(nextData, 'props.initialData.building.zpid');

                    if (zpid) {
                        const url = `https://www.zillow.com/homedetails/${zpid}_zpid/`;

                        const rq = await requestQueue.addRequest({
                            url,
                            userData: {
                                label: LABELS.DETAIL,
                                zpid: +zpid,
                            },
                        }, { forefront: true });

                        if (!rq.wasAlreadyPresent) {
                            log.info(`Re-enqueueing ${url}`);
                        }

                        return;
                    }

                    throw new Error('ZPID not found in page');
                }

                const scripts = await page.$x('//script[contains(., "RenderQuery") and contains(., "apiCache")]');

                // await Apify.setValue(`${request.userData.zpid}--${Math.random()}`, await page.content(), { contentType: 'text/html' });

                if (!scripts.length) {
                    session.retire();
                    throw new Error('Failed to load preloaded data scripts');
                }

                log.info(`LABELS.DETAIL Extracting data from ${request.url}`);
                let noScriptsFound = true;

                for (const script of scripts) {
                    try {
                        const loaded = JSON.parse(JSON.parse(await script.evaluate((s) => s.innerHTML)).apiCache);

                        for (const key in loaded) { // eslint-disable-line
                            if (key.includes('RenderQuery') && loaded[key].property) {
                                await extendOutputFunction(loaded[key].property, {
                                    request,
                                    page,
                                    zpid: request.userData.zpid,
                                    eid: request.userData.eid,
                                });

                                noScriptsFound = false;
                                break;
                            }
                        }
                    } catch (e) {
                        if (e.message.includes('Cannot read property')) {
                            // this is a faulty extend output function
                            log.error(`Your Extend Output Function errored:\n\n    ${e}\n\n`, { url: page.url() });
                        }
                        log.debug(e);
                    }
                }

                if (noScriptsFound) {
                    throw new Error('Failed to load preloaded data from page');
                }
            } else if (label === LABELS.ZPIDS) {
                // Extract all homes by input ZPIDs
                log.info(`Scraping ${input.zpids.length} zpids`);

                for (const zpid of input.zpids) {
                    await processZpid(zpid, '', '');

                    if (isOverItems()) {
                        break;
                    }
                }
            } else if ((label === LABELS.QUERY || label === LABELS.SEARCH) && request.userData.term) {
                if (label === LABELS.SEARCH) {
                    log.info(`Searching for "${request.userData.term}"`);

                    const text = '#search-box-input';
                    const btn = 'button#search-icon';

                    await page.waitForRequest((req) => req.url().includes('/login'));

                    await Promise.all([
                        page.waitForSelector(text),
                        page.waitForSelector(btn),
                    ]);

                    await page.focus(text);
                    await Promise.all([
                        page.waitForResponse((res) => res.url().includes('suggestions')),
                        page.type(text, request.userData.term, { delay: 150 }),
                    ]);

                    try {
                        await Promise.all([
                            page.waitForNavigation({ timeout: 10000 }),
                            page.tap(btn),
                        ]);
                    } catch (e) {
                        log.debug(e.message);

                        const interstitial = await page.$$('#interstitial-title');
                        if (!interstitial.length) {
                            session.retire();
                            throw new Error('Search didn\'t redirect, retrying...');
                        } else {
                            const skip = await page.$x('//button[contains(., "Skip")]');

                            try {
                                await Promise.all([
                                    page.waitForNavigation({ timeout: 25000 }),
                                    skip[0].click(),
                                ]);
                            } catch (e) {
                                log.debug(`Insterstitial`, { message: e.message });
                                throw new Error('Search page didn\'t redirect in time');
                            }
                        }
                    }

                    if ((!/(\/homes\/|_rb)/.test(page.url()) || page.url().includes('/_rb/') || page.url().includes('_zpid')) && !page.url().includes('searchQueryState')) {
                        session.retire();
                        throw new Error(`Unexpected page address ${page.url()}, use a better keyword for searching or proper state or city name. Will retry...`);
                    }

                    if (await page.$('.captcha-container')) {
                        session.retire();
                        throw new Error('Captcha found when searching, retrying...');
                    }
                }

                // Get initial searchState
                const queryStates = [];
                let totalCount = 0;
                let totalResults = 0;
                let shouldContinue = true;

                try {
                    const pageQs = await page.evaluate(() => {
                        try {
                            return JSON.parse(
                                document.querySelector(
                                    'script[data-zrr-shared-data-key="mobileSearchPageStore"]',
                                ).innerHTML.slice(4, -3),
                            );
                        } catch (e) {
                            return {};
                        }
                    });

                    const results = [
                        ..._.get(pageQs, 'cat1.searchResults.listResults', []),
                        ..._.get(pageQs, 'cat1.searchResults.mapResults', []),
                        ..._.get(pageQs, 'cat2.searchResults.listResults', []),
                        ..._.get(pageQs, 'cat2.searchResults.mapResults', []),
                    ];

                    for (const { zpid, detailUrl } of results) {
                        await dump(zpid, results);

                        if (zpid) {
                            if (isOverItems()) {
                                shouldContinue = false;
                                break;
                            }
                            await processZpid(zpid, detailUrl);
                        }
                    }

                    if (shouldContinue) {
                        const listingTypes = ['cat1', 'cat2']; // cat1 are agents listings, cat2 are other listings
                        for (const cat of listingTypes) {
                            const result = await page.evaluate(
                                queryRegionHomes,
                                {
                                    qs: translateQsToFilter(request.userData.searchQueryState || pageQs.queryState),
                                    // use a special type so the query state that comes from the url
                                    // doesn't get erased
                                    type: request.userData.searchQueryState ? 'qs' : input.type,
                                    cat,
                                },
                            );

                            log.debug('query', result.qs);

                            const searchState = JSON.parse(result.body);

                            queryStates.push({
                                qs: result.qs,
                                searchState,
                            });

                            totalCount += searchState?.categoryTotals?.[cat]?.totalResultCount ?? 0;
                        }
                    }
                } catch (e) {
                    log.debug(e);
                }

                log.debug('searchState', { queryStates });

                if (shouldContinue && queryStates?.length) {
                    // Check mapResults
                    const results = queryStates.flatMap(({ searchState }) => [
                        ..._.get(
                            searchState,
                            'cat1.searchResults.mapResults',
                            [],
                        ),
                        ..._.get(
                            searchState,
                            'cat1.searchResults.listResults',
                            [],
                        ),
                        ..._.get(
                            searchState,
                            'cat2.searchResults.mapResults',
                            [],
                        ),
                        ..._.get(
                            searchState,
                            'cat2.searchResults.listResults',
                            [],
                        ),
                    ]);

                    totalResults = Math.max(results.length, totalResults);

                    if (!results?.length) {
                        session.retire();
                        if (totalCount > 0) {
                            await Apify.setValue(`SEARCHSTATE-${Math.random()}`, queryStates);
                            throw new Error(`No map results but result count is ${totalCount}`);
                        } else {
                            log.debug('Really zero results');
                            throw new Error(`Zero results found. Retry request.`);
                        }
                    }

                    for (const { qs } of queryStates) {
                        log.info(`Searching homes at ${JSON.stringify(qs.mapBounds)}`, {
                            url: page.url(),
                        });

                        log.info(`Found ${results.length} results in current area`, qs.mapBounds);

                        // Extract home data from mapResults
                        if (zpids.size < totalResults) {
                            if (input.maxLevel && (request.userData.splitCount || 0) >= input.maxLevel) {
                                log.info('Over max level');
                            } else {
                                // Split map and enqueue sub-rectangles
                                const splitCount = (request.userData.splitCount || 0) + 1;
                                const splits = splitQueryState(qs);

                                for (const searchQueryState of splits) {
                                    if (isOverItems()) {
                                        break;
                                    }

                                    const uniqueKey = quickHash(`${request.url}${splitCount}${JSON.stringify(searchQueryState)}`);
                                    log.debug('queryState', { searchQueryState, uniqueKey });
                                    const url = new URL(request.url);

                                    url.searchParams.set('searchQueryState', JSON.stringify(searchQueryState));

                                    await requestQueue.addRequest({
                                        url: url.toString(),
                                        userData: {
                                            searchQueryState,
                                            label: LABELS.QUERY,
                                            splitCount,
                                        },
                                        uniqueKey,
                                    });
                                }
                            }
                        }

                        if (results.length > 0) {
                            const extracted = () => {
                                log.info(`Extracted total ${zpids.size}`);
                            };
                            const interval = setInterval(extracted, 10000);

                            try {
                                for (const { zpid, detailUrl } of results) {
                                    await dump(zpid, results);

                                    if (zpid) {
                                        await processZpid(zpid, detailUrl);

                                        if (isOverItems()) {
                                            break; // optimize runtime
                                        }
                                    }
                                }
                            } finally {
                                if (!anyErrors) {
                                    extracted();
                                }
                                clearInterval(interval);
                            }
                        }
                    }
                }
            } else {
                log.info(`LABELS Extracting data from ${page.url()}`);

                await page.waitForFunction('document.location.href.includes("zpid")', { timeout: 20000 });

                const splitUrl = page.url().split('_rb/')[1];

                if (splitUrl) {
                    const zpid = splitUrl.split('_z')[0];

                    if (zpid) {
                        log.info(`zpid from ${zpid}`);
                        await processZpid(zpid, '', request.userData.eid);
                    } else {
                        const totalAmount = await page.evaluate(() => document.querySelectorAll(".unit-card-grid.unit-card").length )
                        if (totalAmount > 0) {
                            const zpidQuery = await page.evaluate(() => document.querySelectorAll(".unit-card-grid.unit-card")[0].getAttribute("data-test-id") )
                            if (zpidQuery) {
                                log.info(`zpid from ${zpidQuery}`);
                                await processZpid(zpidQuery, '', request.userData.eid);
                            } else {
                                throw new Error('zpid could not be retrieved');
                            }
                        } else {
                            throw new Error('zpid could not be retrieved');
                        }
                    }
                } else {
                    let zpid;

                    const totalAmount = await page.evaluate(() => document.querySelectorAll(".unit-card-grid.unit-card").length )
                    if (totalAmount > 0) {
                        zpid = await page.evaluate(() => document.querySelectorAll(".unit-card-grid.unit-card")[0].getAttribute("data-test-id") )
                        if (zpid) {
                            log.info(`zpid from ${zpid}`);
                            await processZpid(zpid, '', request.userData.eid);
                        } else {
                            throw new Error('zpid could not be retrieved');
                        }
                    } else {
                        throw new Error('zpid could not be retrieved');
                    }
                }
            }

            await extendScraperFunction(undefined, {
                page,
                request,
                session,
                processZpid,
                queryZpid,
                label: 'HANDLE',
            });

            if (anyErrors) {
                session.retire();
                throw new Error('Retiring session and browser...');
            }
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            // This function is called when the crawling of a request failed too many times
            log.exception(error, `\n\nRequest ${request.url} failed too many times.\n\n`);
            await Apify.pushData({id: request.userData.eid, error: 'It was not possible to get a ZPID and their data for given address'});
        },
    });

    if (!isDebug) {
        fns.patchLog(crawler);
    }
    // Start crawling
    await crawler.run();

    await extendScraperFunction(undefined, {
        label: 'FINISH',
        crawler,
    });

    if (!queryZpid) {
        // this usually means the proxy is busted, we need to fail
        throw new Error('The selected proxy group seems to be blocked, try a different one or contact Apify on Intercom');
    }

    log.info(`Done with ${zpids.size} listings!`);
});
