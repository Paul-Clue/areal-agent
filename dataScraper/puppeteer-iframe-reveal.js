const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    dumpio: true,
    args: ['--enable-logging', '--v=1'],
  }); // Set to true for headless mode
  const page = await browser.newPage();

  page.on('console', (message) =>
    console.log(`Console-message: ${message.text()}`)
  );

  // Navigate to the page containing the property tax query system
  await page.goto('https://ptsqueryonline.fsl.org.jm/PTSOnlineWeb/ptsquery.jsp');

  // Wait for any dynamic content to load
  // await page.waitForTimeout(5000);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Find all iframes, including hidden ones
  const iframes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe')).map(iframe => ({
      id: iframe.id,
      name: iframe.name,
      src: iframe.src,
      visible: iframe.offsetParent !== null
    }));
  });

  console.log('Iframes found:', iframes);

  // Optionally, take a screenshot
  await page.screenshot({path: 'page-with-iframes.png', fullPage: true});

  // For each iframe, we can also inspect its content
  for (let i = 0; i < iframes.length; i++) {
    const frame = iframes[i];
    const contentFrame = await page.frames().find(f => f.url() === frame.src);
    if (contentFrame) {
      const content = await contentFrame.content();
      console.log(`Content of iframe ${i}:`, content.substring(0, 500) + '...'); // First 500 chars
    }
  }

  await browser.close();
})();