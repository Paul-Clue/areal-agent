const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({headless: false});
  const page = await browser.newPage();
  
  await page.goto('https://elandjamaica.nla.gov.jm/elandjamaica/interactivemap.aspx'); // Replace with your target URL
  
  await page.evaluate(() => {
    document.addEventListener('mousemove', (event) => {
      console.log(`Mouse X: ${event.clientX}, Mouse Y: ${event.clientY}`);
    });
  });

  // Other Puppeteer actions...
  await new Promise(resolve => setTimeout(resolve, 1000*60*5));
  await browser.close();
})();