const fs = require('fs');
const path = require('path');
const program = require('commander');

program
  .option('--input <path>', 'Input directory for data files')
  .option('--output <path>', 'Output file for summary data')
  .parse(process.argv);

const stats = {
  global: {
    validFiles: 0,
    failingFiles: 0,
    timeouts: 0,
    totalTime: 0,
    avgTime: 0,
  },
  cmps: {
    totalEntries: 0,
    avgEntries: 0,
    topCMPs: /** @type {Array<[string, number]>} */ ([]),
    empty: 0,
  },
};

const topCMPs = new Map();

/**
 * @typedef {Object} CMPData
 * @property {string} [name]
 */

/**
 * @typedef {Object} FileData
 * @property {Object} data
 * @property {CMPData[]} data.cmps
 */

/**
 * @param {string} inputDir
 */
const processFiles = inputDir => {
  const files = fs.readdirSync(inputDir);

  files.forEach(file => {
    const filePath = path.join(inputDir, file);
    let data;

    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error(`Failed to parse JSON from file ${file}: ${error.message}`);
      stats.global.failingFiles++;
      return; // Skip to the next file
    }

    if (data && data.data && Array.isArray(data.data.cmps)) {
      const cmpsData = data.data.cmps;
      const cmpCount = cmpsData.length;

      if (cmpCount === 0) {
        stats.cmps.empty++;
      } else {
        stats.cmps.totalEntries += cmpCount;
        cmpsData.forEach((/** @type {{ name: string; }} */ cmp) => {
          const cmpName = cmp.name || 'Unknown CMP';
          if (!topCMPs.has(cmpName)) {
            topCMPs.set(cmpName, 0);
          }
          topCMPs.set(cmpName, topCMPs.get(cmpName) + 1);
        });
      }
      stats.global.validFiles++;
    } else {
      console.warn(`No valid CMP data found in ${file}.`);
      stats.global.failingFiles++;
    }
  });

  if (stats.cmps.totalEntries > 0) {
    stats.cmps.topCMPs = Array.from(topCMPs)
      .sort(([, aCount], [, bCount]) => bCount - aCount)
      .slice(0, 50);
    stats.cmps.avgEntries = stats.cmps.totalEntries / stats.global.validFiles;
  } else {
    console.warn('No CMP data to process.');
  }
};

const main = () => {
  const outputDir = path.dirname(program.output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  processFiles(program.input);
  fs.writeFileSync(program.output, JSON.stringify(stats, null, 2));
};

main();
