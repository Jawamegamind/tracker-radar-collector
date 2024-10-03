const fs = require('fs');
const path = require('path');

// Define the folder containing JSON files
const dataFolder = '/Users/jawadsaeed/Documents/SPROJ/tracker-radar-collector/data';

/**
 * @typedef {Object} UspObject
 * @property {number} version
 * @property {string} uspString
 * @property {boolean} isOathFirstParty
 * @property {string} gpp
 * @property {string} gppSid
 * @property {boolean} gdprApplies
 */

/**
 * @typedef {Object} GppObject
 * @property {string} gppVersion
 * @property {string} cmpStatus
 * @property {string} cmpDisplayStatus
 * @property {string} signalStatus
 * @property {string[]} supportedAPIs
 * @property {number} cmpId
 * @property {number[]} sectionList
 * @property {number[]} applicableSections
 * @property {string} gppString
 * @property {Object} parsedSections
 */

/**
 * @typedef {Object} CMP
 * @property {boolean} final
 * @property {string} name
 * @property {boolean} open
 * @property {boolean} started
 * @property {boolean} succeeded
 * @property {boolean} selfTestFail
 * @property {any[]} errors
 * @property {any[]} patterns
 * @property {any[]} snippets
 * @property {UspObject[]} uspObjects
 * @property {GppObject[]} gppObjects
 */

/**
 * @typedef {Object} CMPData
 * @property {CMP[]} cmps
 */

/**
 * @typedef {Object} InputData
 * @property {string} initialUrl
 * @property {string} finalUrl
 * @property {boolean} timeout
 * @property {number} testStarted
 * @property {number} testFinished
 * @property {CMPData} data
 */

/**
 * @typedef {Object} GlobalStats
 * @property {number} validFiles
 * @property {number} failingFiles
 * @property {number} timeouts
 * @property {number} totalTime
 * @property {number} avgTime
 */

/**
 * @typedef {Object} CMPStats
 * @property {number} totalEntries
 * @property {number} avgEntries
 * @property {Object<string, number>} topCMPs
 * @property {number} empty
 */

// Variables to hold aggregated results
/** @type {GlobalStats} */
let globalStats = {
  validFiles: 0,
  failingFiles: 0,
  timeouts: 0,
  totalTime: 0,
  avgTime: 0
};

/** @type {CMPStats} */
let cmpsStats = {
  totalEntries: 0,
  avgEntries: 0,
  topCMPs: {},
  empty: 0
};

// Arrays to store URLs with corresponding non-empty API values
/** @type {Array<{ url: string, uspString: string, gppString: string }>} */
let uspApiEntries = [];
/** @type {Array<{ url: string, gppString: string, supportedAPIs: string[] }>} */
let gppApiEntries = [];

/**
 * Processes a single JSON file, updating global and CMP statistics.
 * 
 * @param {string} filePath - The path to the JSON file
 */
function processFile(filePath) {
  try {
    /** @type {InputData} */
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const { finalUrl, timeout, testStarted, testFinished, data: cmpData } = data;

    // Update global stats
    if (!timeout) {
      globalStats.validFiles++;
      const duration = testFinished - testStarted;
      globalStats.totalTime += duration;
    } else {
      globalStats.timeouts++;
    }

    // Process CMP data
    if (cmpData && cmpData.cmps) {
      const cmpEntries = cmpData.cmps.length;
      cmpsStats.totalEntries += cmpEntries;

      cmpData.cmps.forEach(cmp => {
        // Track top CMP names
        const cmpName = cmp.name || 'Unknown CMP';
        cmpsStats.topCMPs[cmpName] = (cmpsStats.topCMPs[cmpName] || 0) + 1;

        if (!cmp.name) {
          cmpsStats.empty++;
        }

        // Process USP objects if not empty
        if (cmp.uspObjects && cmp.uspObjects.length > 0) {
          cmp.uspObjects.forEach(usp => {
            if (usp.uspString) {
              uspApiEntries.push({
                url: finalUrl,           // URL containing usp API
                uspString: usp.uspString, // USP string value
                gppString: usp.gpp        // GPP string from USP object
              });
            }
          });
        }

        // Process GPP objects if not empty
        if (cmp.gppObjects && cmp.gppObjects.length > 0) {
          cmp.gppObjects.forEach(gpp => {
            if (gpp.supportedAPIs && gpp.supportedAPIs.length > 0) {
              gppApiEntries.push({
                url: finalUrl,             // URL containing gpp API
                gppString: gpp.gppString,  // GPP string value
                supportedAPIs: gpp.supportedAPIs // Supported APIs in GPP
              });
            }
          });
        }
      });
    } else {
      globalStats.failingFiles++;
    }
  } catch (error) {
    console.error(`Failed to process file: ${filePath}`, error);
    globalStats.failingFiles++;
  }
}

// Read and process all files in the data folder
fs.readdirSync(dataFolder).forEach(file => {
  const filePath = path.join(dataFolder, file);
  processFile(filePath);
});

// Calculate averages
globalStats.avgTime = globalStats.totalTime / globalStats.validFiles || 0;
cmpsStats.avgEntries = cmpsStats.totalEntries / globalStats.validFiles || 0;

// Sort top CMPs by occurrence
let topCMPs = Object.entries(cmpsStats.topCMPs).sort((a, b) => b[1] - a[1]);

// Create final result object
const result = {
  global: globalStats,
  cmps: {
    totalEntries: cmpsStats.totalEntries,
    avgEntries: cmpsStats.avgEntries,
    topCMPs: topCMPs.slice(0, 5), // Get top 5 CMPs
    empty: cmpsStats.empty
  },
  uspApiEntries: uspApiEntries,
  gppApiEntries: gppApiEntries
};

// Write result to a new JSON file
fs.writeFileSync('/Users/jawadsaeed/Documents/SPROJ/tracker-radar-collector/summary/framework-summary.json', JSON.stringify(result, null, 2));

console.log('Processing completed. Results saved in result.json.');
