const puppeteer = require('puppeteer');
const fs = require('fs').promises;

const IFRAME_URL =
  'https://ptsqueryonline.fsl.org.jm/PTSOnlineWeb/ptsquery.jsp'; // Replace with actual URL

async function scrapePropertyInfo(page, evaluationNumber) {
  // await page.goto(IFRAME_URL, { waitUntil: 'networkidle0' });
  // await page.goto(IFRAME_URL, {
  //   waitUntil: 'networkidle0',
  //   timeout: 5000
  // });

  // // Fill the form
  // // await page.type('.table.table-striped.table-bordered', evaluationNumber);
  // await page.waitForSelector('#valno', { timeout: 10000 });
  // await page.type('#valno', evaluationNumber);
  // await page.click('input[type="submit"]');

  // Wait for results to load
  // await page.waitForSelector('#results', { timeout: 1000 });

  // Add page timeout of 30 seconds for navigation
  await page.goto(IFRAME_URL, {
    waitUntil: 'networkidle0',
    timeout: 30000,
  });

  // Fill the form
  await page.waitForSelector('#valno', { timeout: 10000 });
  await page.type('#valno', evaluationNumber);

  // Wait for submit button and click
  await page.waitForSelector('input[type="submit"]', { timeout: 10000 });
  await page.click('input[type="submit"]');

  // Wait for results table with timeout
  await page.waitForSelector('.table', { timeout: 15000 });

  // Extract information (adjust selectors as needed)
  const info = await page.evaluate(() => {
    const getTableData = (selector) => {
      const table = document.querySelector(selector);
      return Array.from(table.querySelectorAll('tr'))
        .map((row) => {
          const cells = Array.from(row.querySelectorAll('td'));
          return cells.length === 2
            ? { [cells[0].innerText.trim()]: cells[1].innerText.trim() }
            : null;
        })
        .filter(Boolean)
        .reduce((acc, curr) => ({ ...acc, ...curr }), {});
    };

    return {
      propertyInfo: getTableData('.table'),
      // Add more data extraction as needed
    };
  });

  // Wait for back button and click
  await page.waitForSelector('#back', { timeout: 10000 });
  await page.click('#back');
  // Wait for the input page to load again

  // await new Promise((resolve) => setTimeout(resolve, 1000));

  // Add small delay to ensure page is ready
  //  await page.waitForTimeout(1000);

  return info;
}

async function main() {
  // Read valuation numbers from JSON file
  const valuationData = JSON.parse(
    await fs.readFile('land_valuation_numbers.json', 'utf-8')
  );
  const EVALUATION_NUMBERS = valuationData.map((item) => item.lvNumber);

  const browser = await puppeteer.launch({
    headless: true,
    dumpio: true,
    args: ['--enable-logging', '--v=1'],
  });
  const page = await browser.newPage();
  page.on('console', (message) =>
    console.log(`Console-message: ${message.text()}`)
  );
  const results = [];

  // Read and parse used evaluation numbers
  let usedNumbers = new Set();
  try {
    const usedData = await fs.readFile('used-evals.txt', 'utf-8');
    // console.log('USED DATA', usedData);
    // Split by newlines and filter empty strings
    usedNumbers = new Set(usedData.split('\n').filter(Boolean));
  } catch (error) {
    // File doesn't exist yet, continue with empty Set
    console.log('No existing used-evals.json file found, creating new one');
  }

  for (const number of EVALUATION_NUMBERS) {
    if (usedNumbers.has(number)) {
      console.log(`Skipping already used evaluation number: ${number}`);
      continue;
    }

    try {
      console.log(`Scraping info for evaluation number: ${number}`);
      const info = await scrapePropertyInfo(page, number);
      // results.push(info);
      await fs.appendFile('used-evals.txt', number + '\n');
      await fs.appendFile('property_info.json', JSON.stringify(info, null, 2));
    } catch (error) {
      console.error(`Error scraping ${number}:`, error.message);
    }
  }

  await browser.close();

  // Save results to a JSON file
  // await fs.writeFile('property_info.json', JSON.stringify(results, null, 2));
  console.log('Scraping completed. Results saved to property_info.json');
}

main().catch(console.error);
