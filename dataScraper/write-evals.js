const fs = require('fs').promises;

const getEvals = async () => {
const valuationData = JSON.parse(
  await fs.readFile('land_valuation_numbers.json', 'utf-8')
);
const EVALUATION_NUMBERS = valuationData.map((item) => item.lvNumber);

  await fs.writeFile('evals.json', JSON.stringify(EVALUATION_NUMBERS, null, 2));
};

getEvals();
