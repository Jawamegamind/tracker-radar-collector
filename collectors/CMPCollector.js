/* eslint-disable max-lines */
const fs = require('fs');
const createDeferred = require('../helpers/deferred');
const waitFor = require('../helpers/waitFor');
const BaseCollector = require('./BaseCollector');



/**
 * Scrolls to the bottom of the page in increments.
 *
 * @param {import('puppeteer').Page} page - The Puppeteer page instance.
 * @returns {Promise<void>} - A promise that resolves when the page has been scrolled to the bottom.
 */


async function scrollToBottom(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 200; // Scroll by 100 pixels at a time
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                console.log("trying to scroll to the bottom of the page");
                // Stop when totalHeight is greater than or equal to scrollHeight
                if (totalHeight >= document.body.scrollHeight) {
                    console.log("Done scrolling to the bottom of the page");
                    clearInterval(timer);
                    resolve();
                }
            }, 10); // Scroll every 100 milliseconds
        });
    });
}


/**
 * @typedef { import('./BaseCollector').CollectorInitOptions } CollectorInitOptions
 * @typedef { import('@duckduckgo/autoconsent/lib/types').AutoAction } AutoAction
 * @typedef { import('@duckduckgo/autoconsent/lib/messages').ContentScriptMessage } ContentScriptMessage
 * @typedef { import('@duckduckgo/autoconsent/lib/types').Config } AutoconsentConfig
 * @typedef { import('@duckduckgo/autoconsent/lib/messages').DetectedMessage } DetectedMessage
 * @typedef { import('@duckduckgo/autoconsent/lib/messages').SelfTestResultMessage } SelfTestResultMessage
 * @typedef { import('@duckduckgo/autoconsent/lib/messages').ErrorMessage } ErrorMessage
 * @typedef { import('@duckduckgo/autoconsent/lib/messages').OptOutResultMessage } OptOutResultMessage
 * @typedef { import('@duckduckgo/autoconsent/lib/messages').OptInResultMessage } OptInResultMessage
 * @typedef { import('@duckduckgo/autoconsent/lib/messages').DoneMessage } DoneMessage
 * @typedef { { snippets: string[], patterns: string[], uspObjects: string[], gppObjects: string[], hasSections: string[] } } ScanResult
 */

// @ts-ignore
const baseContentScript = fs.readFileSync(
    require.resolve('@duckduckgo/autoconsent/dist/autoconsent.playwright.js'),
    'utf8'
);

const contentScript = `
window.autoconsentSendMessage = (msg) => {
    window.cdpAutoconsentSendMessage(JSON.stringify(msg));
};
` + baseContentScript;

const worldName = 'cmpcollector';

/**
 * @param {String|Error} e
 */
function isIgnoredEvalError(e) {
    // ignore evaluation errors (sometimes frames reload too fast)
    const error = (typeof e === 'string') ? e : e.message;
    return (
        error.includes('No frame for given id found') ||
        error.includes('Target closed.') ||
        error.includes('Session closed.') ||
        error.includes('Cannot find context with specified id')
    );
}

// TODO: check for false positive detections per pattern
const DETECT_PATTERNS = [
    /accept cookies/ig,
    /accept all/ig,
    /reject all/ig,
    /only necessary cookies/ig, // "only necessary" is probably too broad
    /by clicking.*(accept|agree|allow)/ig,
    /by continuing/ig,
    /we (use|serve)( optional)? cookies/ig,
    /we are using cookies/ig,
    /use of cookies/ig,
    /(this|our) (web)?site.*cookies/ig,
    /cookies (and|or) .* technologies/ig,
    /such as cookies/ig,
    /read more about.*cookies/ig,
    /consent to.*cookies/ig,
    /we and our partners.*cookies/ig,
    /we.*store.*information.*such as.*cookies/ig,
    /store and\/or access information.*on a device/ig,
    /personalised ads and content, ad and content measurement/ig,

    // it might be tempting to add the patterns below, but they cause too many false positives. Don't do it :)
    // /cookies? settings/i,
    // /cookies? preferences/i,
];

class CMPCollector extends BaseCollector {
    id() {
        return 'cmps';
    }

    /**
     * @param {CollectorInitOptions} options
     */
    init(options) {
        this.log = options.log;
        this.shortTimeouts = options.collectorFlags.shortTimeouts; // used to speed up unit tests
        this.autoAction = /** @type {AutoAction} */ (options.collectorFlags.autoconsentAction);
        /** @type {ContentScriptMessage[]} */
        this.receivedMsgs = [];
        this.selfTestFrame = null;
        this.isolated2pageworld = new Map();
        this.pendingScan = createDeferred();
        this.context = options.context;
        /** @type {ScanResult} */
        this.scanResult = {
            snippets: [],
            patterns: [],
            uspObjects: [],
            gppObjects: [],
            hasSections: []
        };
    }

    /**
     * @param {Partial<ContentScriptMessage>} msg
     * @returns {ContentScriptMessage | null}
     */
    findMessage(msg, partial = true) {
        for (const m of this.receivedMsgs) {
            const keysMatch = partial || Object.keys(m).length === Object.keys(msg).length;
            // @ts-ignore
            if (keysMatch && Object.keys(msg).every(k => m[k] === msg[k])) {
                return m;
            }
        }
        return null;
    }

    /**
     * @param {Partial<ContentScriptMessage>} msg
     * @returns {ContentScriptMessage[]}
     */
    findAllMessages(msg, partial = true) {
        return this.receivedMsgs.filter(m => {
            const keysMatch = partial || Object.keys(m).length === Object.keys(msg).length;
            // @ts-ignore
            return keysMatch && Object.keys(msg).every(k => m[k] === msg[k]);
        });
    }

    /**
     * @param {{cdpClient: import('puppeteer').CDPSession, url: string, type: import('./TargetCollector').TargetType}} targetInfo
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async addTarget(targetInfo) {
        if (targetInfo.type === 'page') {
            this._cdpClient = targetInfo.cdpClient;
            await this._cdpClient.send('Page.enable');
            await this._cdpClient.send('Runtime.enable');

            this._cdpClient.on('Runtime.executionContextCreated', async ({context}) => {
                // ignore context created by puppeteer / our crawler
                if (!context.origin || context.origin === '://' || context.auxData.type === 'isolated') {
                    return;
                }
                try {
                    const {executionContextId} = await this._cdpClient.send('Page.createIsolatedWorld', {
                        frameId: context.auxData.frameId,
                        worldName
                    });
                    this.isolated2pageworld.set(executionContextId, context.id);
                    await this._cdpClient.send('Runtime.evaluate', {
                        expression: contentScript,
                        contextId: executionContextId,
                    });
                } catch (e) {
                    if (!isIgnoredEvalError(e)) {
                        this.log(`Error evaluating content script: ${e}`);
                    }
                }
            });

            this._cdpClient.on('Runtime.bindingCalled', async ({name, payload, executionContextId}) => {
                if (name === 'cdpAutoconsentSendMessage') {
                    try {
                        const msg = JSON.parse(payload);
                        await this.handleMessage(msg, executionContextId);
                    } catch (e) {
                        if (!isIgnoredEvalError(e)) {
                            this.log(`Could not handle autoconsent message ${payload}`, e);
                        }
                    }
                }
            });
            await this._cdpClient.send('Runtime.addBinding', {
                name: 'cdpAutoconsentSendMessage',
                executionContextName: worldName,
            });
        }
    }

    /**
     * Implements autoconsent messaging protocol
     *
     * @param {ContentScriptMessage} msg
     * @param {any} executionContextId
     * @returns {Promise<void>}
     */
    async handleMessage(msg, executionContextId) {
        this.receivedMsgs.push(msg);
        switch (msg.type) {
        case 'init': {
            /** @type {Partial<AutoconsentConfig>} */
            const autoconsentConfig = {
                enabled: true,
                autoAction: null, // we request action explicitly later
                disabledCmps: [],
                enablePrehide: false,
                enableCosmeticRules: true,
                detectRetries: 20,
                isMainWorld: false
            };
            await this._cdpClient.send('Runtime.evaluate', {
                expression: `autoconsentReceiveMessage({ type: "initResp", config: ${JSON.stringify(autoconsentConfig)} })`,
                contextId: executionContextId,
            });
            break;
        }
        case 'popupFound':
            if (this.autoAction) {
                await this.pendingScan.promise; // wait for the pattern detection first
                await this._cdpClient.send('Runtime.evaluate', {
                    expression: `autoconsentReceiveMessage({ type: "${this.autoAction}" })`,
                    contextId: executionContextId,
                });
            }
            break;
        case 'optInResult':
        case 'optOutResult': {
            if (msg.scheduleSelfTest) {
                this.selfTestFrame = executionContextId;
            }
            break;
        }
        case 'autoconsentDone': {
            if (this.selfTestFrame) {
                await this._cdpClient.send('Runtime.evaluate', {
                    expression: `autoconsentReceiveMessage({ type: "selfTest" })`,
                    allowUnsafeEvalBlockedByCSP: true,
                    contextId: this.selfTestFrame,
                });
            }
            break;
        }
        case 'eval': {
            let evalResult = false;
            const result = await this._cdpClient.send('Runtime.evaluate', {
                expression: msg.code,
                returnByValue: true,
                allowUnsafeEvalBlockedByCSP: true,
                contextId: this.isolated2pageworld.get(executionContextId), // this must be done in page world
            });
            if (!result.exceptionDetails) {
                evalResult = Boolean(result.result.value);
            }

            await this._cdpClient.send('Runtime.evaluate', {
                expression: `autoconsentReceiveMessage({ id: "${msg.id}", type: "evalResp", result: ${JSON.stringify(evalResult)} })`,
                allowUnsafeEvalBlockedByCSP: true,
                contextId: executionContextId,
            });
            break;
        }
        case 'autoconsentError': {
            this.log(`autoconsent error: ${msg.details}`);
            break;
        }
        default:
        }
    }

    /**
     * @param {Partial<ContentScriptMessage>} msg
     * @returns {Promise<ContentScriptMessage>}
     */
    async waitForMessage(msg, maxTimes = 20, interval = 100) {
        if (this.shortTimeouts) {
            // eslint-disable-next-line no-param-reassign
            maxTimes = 1;
        }
        await waitFor(() => Boolean(this.findMessage(msg)), maxTimes, interval);
        return this.findMessage(msg);
    }

    /**
     * @returns {Promise<void>}
     */
    async waitForFinish() {
        // check if anything was detected at all
        const detectedMsg = /** @type {DetectedMessage} */ (await this.waitForMessage({type: 'cmpDetected'}));
        if (!detectedMsg) {
            return;
        }

        // was there a popup?
        const found = await this.waitForMessage({type: 'popupFound'});
        if (!found) {
            return;
        }

        if (!this.autoAction) {
            return;
        }

        // did we opt-out?
        const resultType = this.autoAction === 'optOut' ? 'optOutResult' : 'optInResult';
        const autoActionDone = /** @type {OptOutResultMessage|OptInResultMessage} */ (await this.waitForMessage({
            type: resultType,
            cmp: detectedMsg.cmp
        }));
        if (autoActionDone) {
            if (!autoActionDone.result) {
                return;
            }
        }
        const doneMsg = /** @type {DoneMessage} */ (await this.waitForMessage({
            type: 'autoconsentDone'
        }));
        if (!doneMsg) {
            return;
        }

        // the final name might be different than the detected name, in case of intermediate rules
        if (this.selfTestFrame) {
            // did self-test succeed?
            await this.waitForMessage({
                type: 'selfTestResult'
            });
        }
    }

    async postLoad() {
        /**
         * @type {string[]}
         */
        const foundPatterns = [];
        const foundSnippets = [];
        const uspStrings = [];
        const gppObjects = [];
        const hasSections = [];
    
        const pages = await this.context.pages();


        if (pages.length > 0) {
            const page = pages[0];
            
            // Scroll to the bottom of the page to load all the content
            // await page.waitForTimeout(2000);
            await scrollToBottom(page);
          

            /**
             * @type {Promise<string>[]}
             */
            const promises = [];
            page.frames().forEach(frame => {
                // eslint-disable-next-line no-undef
                promises.push(frame.evaluate(() => document.documentElement.innerText).catch(reason => {
                    this.log(`error retrieving text: ${reason}`);
                    // ignore exceptions
                    return '';
                }));
            });
            const texts = await Promise.all(promises);
            const allTexts = texts.join('\n');
            for (const p of DETECT_PATTERNS) {
                const matches = allTexts.match(p);
                if (matches) {
                    foundPatterns.push(p.toString());
                    foundSnippets.push(...matches.map(m => m.substring(0, 200)));
                }
            }

            // Need to basically call the __uspapi function on the page
            // to get the USP strings
            console.log('Attempting to retrieve USP string...');
            const uspString = await page.evaluate(() => {
                // eslint-disable-next-line no-undef
                return new Promise(resolve => {
                    // eslint-disable-next-line no-undef
                    // @ts-ignore
                    window.__uspapi('getUSPData', 1, (/** @type {any} */ uspData, /** @type {any} */ success) => {
                        if (success) {
                            resolve(uspData);
                        } else {
                            resolve('');
                        }
                    });
                });
            });

            if (uspString) {
                console.log('USP string retrieved:', uspString);
                uspStrings.push(uspString);
                console.log('USP string retrieved in the array:', uspStrings);
            } else {
                console.log('No USP string retrieved.');
            }
            // let gppObject  = [""]
            console.log('Attempting to retrieve GPP objects...');
            try {
                const gppObject = await page.evaluate(() => {
                    return new Promise(resolve => {
                        // Check if __gpp function exists on the window object
                        // @ts-ignore
                        if (typeof window.__gpp !== 'function') {
                            resolve(null); // Resolve with null if __gpp doesn't exist
                            return;
                        }
                        // Call the __gpp function if it exists
                        // @ts-ignore
                        window.__gpp('ping', (/** @type {any} */ gppData, /** @type {any} */ success) => {
                            if (success) {
                                resolve(gppData);
                            } else {
                                resolve(null);
                            }
                        });
                    });
                });
            
                if (gppObject) {
                    console.log('GPP object retrieved:', gppObject);
                    gppObjects.push(gppObject);
                    console.log('GPP object retrieved in the array:', gppObjects);
                } else {
                    console.log('No GPP object retrieved or __gpp function does not exist.');
                }
            } catch (error) {
                console.log('Error retrieving GPP object:', error);
            }

            // Now we need to run the hasSections api to see if CMP has generated section of a certrain specification
            // For this we need to basically call hasSection function below
            console.log('The supported APIs are:', gppObjects.length > 0 ? gppObjects[0].supportedAPIs : 'No GPP objects found');
            console.log('Attempting to check for sections...');

            try {
                // Extract supported APIs from the gppObject
                const supportedAPIs = gppObjects.length > 0 ? gppObjects[0].supportedAPIs : [];
                // const hasSections = [];

                // Loop through each supported API and call hasSection
                for (const api of supportedAPIs) {
                    // Extract the part after the colon (e.g., 'tcfcav1' from '5:tcfcav1')
                    const apiIdentifier = api.split(':')[1];

                    // Check if we have a valid apiIdentifier
                    if (apiIdentifier) {
                        const hasSection = await page.evaluate((apiId) => {
                            return new Promise(resolve => {
                                // Check if __gpp function exists on the window object
                                // @ts-ignore
                                if (typeof window.__gpp !== 'function') {
                                    resolve(null); // Resolve with null if __gpp doesn't exist
                                    return;
                                }
                                // Call the __gpp function with the apiId
                                // @ts-ignore
                                window.__gpp('hasSection', (/** @type {Boolean} */ data, /** @type {Boolean} */ success) => {
                                    if (success) {
                                        resolve(data);
                                    } else {
                                        resolve(null);
                                    }
                                }, apiId); // Pass the dynamic apiId (e.g., 'tcfcav1')
                            });
                        }, apiIdentifier);

                        // Add the result (true/false/null) to the hasSections array
                        hasSections.push({ api: apiIdentifier, hasSection });
                    }
                }
                console.log('Sections found:', hasSections);
            } catch (error) {
                console.log('Error checking for sections:', error);
            }

        }
        this.pendingScan.resolve();
        this.scanResult = {
            patterns: foundPatterns,
            snippets: Array.from(new Set(foundSnippets)),
            uspObjects: uspStrings,
            gppObjects: gppObjects,
            hasSections: hasSections
        };
        console.log('Scan result:', this.scanResult);
    }

    /**
     * @returns {CMPResult[]}
     */
    collectResults() {
        /**
         * @type {CMPResult[]}
         */
        const results = [];

        const doneMsg = /** @type {DoneMessage} */ (this.findMessage({
            type: 'autoconsentDone'
        }));

        const selfTestResult = /** @type {SelfTestResultMessage} */ (this.findMessage({
            type: 'selfTestResult'
        }));

        const errorMsgs = /** @type {ErrorMessage[]} */ (this.findAllMessages({
            type: 'autoconsentError',
        }));
        const errors = errorMsgs.map(e => JSON.stringify(e.details));

        const detectedRules = /** @type {DetectedMessage[]} */ (this.findAllMessages({type: 'cmpDetected'}));
        /** @type {string[]} */
        const processedCmps = [];
        for (const msg of detectedRules) {
            if (processedCmps.includes(msg.cmp)) { // prevent duplicates
                continue;
            }
            processedCmps.push(msg.cmp);
            /**
             * @type {CMPResult}
             */
            const result = {
                final: Boolean(doneMsg && doneMsg.cmp === msg.cmp),
                name: msg.cmp,
                open: false,
                started: false,
                succeeded: false,
                selfTestFail: Boolean(selfTestResult && !selfTestResult.result),
                errors,
                patterns: [],
                snippets: [],
                uspObjects: [],
                gppObjects: [],
                hasSections: []
            };

            const found = this.findMessage({type: 'popupFound', cmp: msg.cmp});
            if (found) {
                result.open = true;
                if (this.autoAction) {
                    const resultType = this.autoAction === 'optOut' ? 'optOutResult' : 'optInResult';
                    result.started = true;
                    const autoActionResult = /** @type {OptOutResultMessage|OptInResultMessage} */ (this.findMessage({
                        type: resultType,
                        cmp: msg.cmp,
                    }));
                    if (autoActionResult) {
                        result.succeeded = autoActionResult.result;
                    }
                }
            }
            results.push(result);
        }

        return results;
    }

    /**
     * Called after the crawl to retrieve the data. Can be async, can throw errors.
     *
     * @returns {Promise<CMPResult[]>}
     */
    async getData() {
        await this.waitForFinish();
        const results = this.collectResults();
        if (this.scanResult.patterns.length > 0 || this.scanResult.snippets.length > 0 || this.scanResult.uspObjects.length > 0 || this.scanResult.gppObjects.length > 0 || this.scanResult.hasSections.length > 0) {
            if (results.length > 0) {
                results.forEach(r => {
                    r.patterns = this.scanResult.patterns;
                    r.snippets = this.scanResult.snippets;
                    r.uspObjects = this.scanResult.uspObjects;
                    r.gppObjects = this.scanResult.gppObjects;
                    r.hasSections = this.scanResult.hasSections;
                });
            } else {
                results.push({
                    final: false,
                    name: '',
                    open: false,
                    started: false,
                    succeeded: false,
                    selfTestFail: false,
                    errors: [],
                    patterns: this.scanResult.patterns,
                    snippets: this.scanResult.snippets,
                    uspObjects: this.scanResult.uspObjects,
                    gppObjects: this.scanResult.gppObjects,
                    hasSections: this.scanResult.hasSections
                });
            }
        }
        console.log("The results are:", results);
        return results;
    }
}

/**
 * @typedef CMPResult
 * @property {string} name
 * @property {boolean} final
 * @property {boolean} open
 * @property {boolean} started
 * @property {boolean} succeeded
 * @property {boolean} selfTestFail
 * @property {string[]} errors
 * @property {string[]} patterns
 * @property {string[]} snippets
 * @property {string[]} uspObjects
 * @property {string[]} gppObjects
 * @property {string[]} hasSections
 */

module.exports = CMPCollector;