const puppeteer = require('puppeteer');
// async function main() {
async function zoomIn(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => {
      const zoomInButton = document.querySelector(
        '.esri-widget--button.esri-widget.esri-interactive[title="Zoom In"]'
      );
      if (zoomInButton) {
        zoomInButton.click();
        // console.log('Zoom in button clicked');
      } else {
        console.log('Zoom in button not found');
      }
    });
    // Wait for the map to update after zooming
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
async function zoomOut(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => {
      const zoomOutButton = document.querySelector(
        '.esri-widget--button.esri-widget.esri-interactive[title="Zoom Out"]'
      );
      if (zoomOutButton) {
        zoomOutButton.click();
        // console.log('Zoom in button clicked');
      } else {
        console.log('Zoom in button not found');
      }
    });
    // Wait for the map to update after zooming
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function clickMapElement(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  console.log(`Clicked at coordinates (${x}, ${y})`);
  // Wait for any potential updates after clicking
  await new Promise((resolve) => setTimeout(resolve, 2000));
};

// const scanArea = { x1: 425, y1: 535, x2: 1100, y2: 700 };
const scanArea = { x1: 425, y1: 400, x2: 1100, y2: 700 };

const searchAndClick = async (page) => {
  // for (let x = scanArea.x1; x < scanArea.x2; x += 20) {
  //   for (let y = scanArea.y1; y < scanArea.y2; y += 20) {
  for (let x = scanArea.x1; x < scanArea.x2; x += 20) {
    for (let y = scanArea.y1; y < scanArea.y2; y += 20) {
      // await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log('clicking', x, y);
      await clickMapElement(page, x, y);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const data = await scrapeTableData(page);
      if (data) {
        console.log(`Data from coordinates (${x}, ${y}):`, data);
      }
      // Close the info window if it's open
      // await page.keyboard.press('Escape');
      await page.click('.closebtn');
      await new Promise((resolve) => setTimeout(resolve, 4000));
      console.log('zooming out');
      await zoomOut(page, 3);
      console.log('waiting');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
};

async function scrapeTableData(page) {
  try {
    await page.waitForSelector('.tableWrap', { timeout: 2000 });

    const landValuation = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tabletht tr'));
      for (const row of rows) {
        const columns = Array.from(row.querySelectorAll('td'));
        if (
          columns.length >= 2 &&
          columns[0].innerText.trim() === 'Land Valuation'
        ) {
          return columns[1].innerText.trim();
        }
      }
      return null;
    });

    return landValuation;
  } catch (error) {
    console.log('Table not found after clicking.');
    // await searchAndClick();
    return null;
  }
}

async function dragMap(page, startX, startY, endX, endY) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 10 }); // Move in steps for smoother drag
  await page.mouse.up();
  console.log(`Dragged map from (${startX}, ${startY}) to (${endX}, ${endY})`);
  // Wait for the map to settle after dragging
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    dumpio: true,
    args: ['--enable-logging', '--v=1'],
  });

  const page = await browser.newPage();

  page.on('console', (message) =>
    console.log(`Console-message: ${message.text()}`)
  );
  await page.setViewport({ width: 1920, height: 1080 });

  await page.goto(
    'https://elandjamaica.nla.gov.jm/elandjamaica/interactivemap.aspx',
    { waitUntil: 'networkidle0' }
  );

  // Wait for the map to load
  // await page.waitForSelector('#myNav_content');
  // await page.screenshot({path: 'interactivemap.png'});
  await page.waitForSelector('.overlay-content');
  // Wait for the map to update after zooming
  await new Promise((resolve) => setTimeout(resolve, 2000));

  await page.click('#acceptBtn');

  await page.waitForSelector(
    '.esri-widget--button.esri-widget.esri-interactive[title="Zoom In"]'
  );

  // await clickMapElement(page, 960, 540);
  //page, startX, startY, endX, endY
  await dragMap(page, 960, 540, 1020, 540);
  await dragMap(page, 960, 540, 960, 490);
  // 425, 535
  await zoomIn(page, 7);

  const clickableElements = [
    { x: 500, y: 300 },
    { x: 700, y: 400 },
    // Add more coordinates as needed
  ];
  
  await searchAndClick(page);

  await browser.close();
}

main().catch((error) => console.error('An error occurred:', error));
