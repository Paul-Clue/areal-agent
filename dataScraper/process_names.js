const fs = require('fs').promises;
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

function splitName(fullName) {
    // Remove "ET AL", "ET UX", "EST" and other suffixes
    const name = fullName.replace(/\s+ET\s+AL|\s+ET\s+UX|\s+EST/gi, '');
    
    // Split the name into parts
    const parts = name.trim().split(/\s+/);
    
    // Handle empty names
    if (parts.length === 0) {
        return { firstName: '', lastName: '' };
    }
    
    // If only one name exists
    if (parts.length === 1) {
        return { firstName: parts[0], lastName: '' };
    }
    
    // Return first name and last name
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    
    return { firstName, lastName };
}

async function processPropertyInfo() {
    // Read and parse the JSON file
    const data = JSON.parse(await fs.readFile('property_info.json', 'utf-8'));
    
    // Configure CSV writer
    const csvWriter = createCsvWriter({
        path: 'owner_names.csv',
        header: [
            { id: 'firstName', title: 'First Name' },
            { id: 'lastName', title: 'Last Name' }
        ]
    });
    
    // Process names
    const records = data.map(record => {
        const ownerName = record.propertyInfo['Owner Name'];
        return splitName(ownerName);
    });
    
    // Write to CSV
    await csvWriter.writeRecords(records);
    console.log('CSV file has been created successfully!');
}

processPropertyInfo().catch(console.error); 