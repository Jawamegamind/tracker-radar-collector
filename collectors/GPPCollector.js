/* eslint-disable no-await-in-loop */
const BaseCollector = require('./BaseCollector');
const createDeferred = require('../helpers/deferred');
const tld = require('tldts');
const { URL } = require('url');
const fs = require('fs');

/**
 * @typedef { {gppObjects: string[], hasSections: { api: any; hasSection: any; }[] } } ScanResult
 */

/**
 * Scrolls to the bottom of the page in increments.
 *
 * @param {import('puppeteer').Page} page - The Puppeteer page instance.
 * @returns {Promise<void>} - A promise that resolves when the page has been scrolled to the bottom.
 */
// Function for scrolling to the top of the page
async function scrollToTop(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = document.body.scrollHeight;
            const distance = 200; // Scroll by 200 pixels at a time
            const timer = setInterval(() => {
                window.scrollBy(0, -distance); // Scroll upwards by reducing the y-position
                totalHeight -= distance;

                // Stop when totalHeight is less than or equal to 0 (top of the page)
                if (window.scrollY === 0) {
                    console.log("Done scrolling to the top of the page");
                    clearInterval(timer);
                    resolve();
                }
            }, 10); // Scroll every 10 milliseconds
        });
    });
}

class GPPCollector extends BaseCollector {
    id() {
        return 'gpp';
    }

    /**
     * @param {import('./BaseCollector').CollectorInitOptions} options
     */
    init(options) {
        this._log = options.log;
        this.context = options.context;
        this.pendingScan = createDeferred();
        /** @type {ScanResult} */
        this.scanResult = {
            gppObjects: [],
            hasSections: []
        };
    }

    // @ts-ignore
    async addTarget({ page, type }) {
        if (page && type === 'page') {
            try {
                // Need to add something over here
                // page.evaluateOnNewDocument(linkHelperSrc);
            } catch (error) {
                this._log(`AdCollector: Error while adding target: ${error}`);
            }
        }
    }

    /**
     * @param {import('puppeteer').Page} page - The Puppeteer page instance.
     */
    async callGPPPing(page) {
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
                    window.__gpp('ping', (gppData, success) => {
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
                return gppObject; // Return the retrieved object
            } else {
                console.log('No GPP object retrieved or __gpp function does not exist.');
                return null;
            }
        } catch (error) {
            console.error('Error calling GPP function:', error);
            return null;
        }
    }

    /**
     * @param {import('puppeteer').Page} page - The Puppeteer page instance.
     */
    async callGPPhasSections(page, gppObject) {
        try {
            // Extract supported APIs from the gppObject
            const supportedAPIs = gppObject.supportedAPIs;
            const hasSections = [];

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
            return hasSections; // Return the array of sections
        } catch (error) {
            console.error('Error checking for sections:', error);
            return null;
        }
        
    }

    async postLoad() {
        /**
         * @type {string[]}
         */
        const gppObjects = [];
        const hasSections = [];
    
        const pages = await this.context.pages();


        if (pages.length > 0) {
            const page = pages[0];
            
            // Scroll to the bottom of the page to load all the content
            // await page.waitForTimeout(2000);
            // await scrollToBottom(page);
          
            // let gppObject  = [""]
            console.log('Attempting to retrieve GPP objects...');
            const gppObject = await this.callGPPPing(page);

            if (gppObject) {
                gppObjects.push(gppObject);
                console.log('GPP object retrieved:', gppObject);
            }
            else {
                console.log('No GPP object retrieved.');
            }

            console.log('Attempting to check for sections...');
            const hasSection = await this.callGPPhasSections(page, gppObject);

            if (hasSection) {
                hasSections.push(hasSection);
                console.log('Sections found:', hasSection);
            }
            else {
                console.log('No sections found.');
            }

        }
        this.pendingScan.resolve();
        this.scanResult = {
            gppObjects: gppObjects,
            hasSections: hasSections
        };
        console.log('Scan result:', this.scanResult);
    }

    /**
     * @param {{ finalUrl?: string; urlFilter?: any; page?: any; }} [options]
     */
    async getData(options) {
        // await options.page.waitForTimeout(5000);
        // scroll to the top of the page
        // await scrollToTop(options.page);
        console.log("Scrolling to the top of the page");
        // await options.page.evaluate(() => {
        //     window.scrollTo(0, 0);
        // });
        const page = options.page;


        // const gppObjects = [];
        // console.log('Attempting to retrieve GPP objects...');
        // const gppObject = await this.callGPPFunction(page);

        // if (gppObject) {
        //     gppObjects.push(gppObject);
        //     console.log('GPP object retrieved:', gppObject);
        // }
        // else {
        //     console.log('No GPP object retrieved.');
        // }
        
        return this.scanResult;
    }
 }

module.exports = GPPCollector;