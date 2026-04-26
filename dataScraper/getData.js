
// const API_BASE_URL = "https://elandjamaica.nla.gov.jm/elandjamaica/eLandWebService.asmx";

// function getDocInfo(docId, lvNo) {
//   return fetch(`${API_BASE_URL}/GetLinkedDocs`, {
//       method: 'POST',
//       headers: {
//           'Content-Type': 'application/json',
//       },
//       body: JSON.stringify({ docID: docId, lvNo: lvNo }),
//   })
//   .then(response => {
//       if (!response.ok) {
//           throw new Error('Network response was not ok');
//       }
//       return response.json();
//   })
//   .then(data => {
//       doc_info = data.d;
//       return doc_info;
//   })
//   .catch(error => {
//       console.log("Get Info Error:", error);
//       throw error;
//   });
// }

var qTask = new QueryTask({
    url: "https://gisportal.nla.gov.jm/nlagis/rest/services/ElandjamaicaAug162024/MapServer/16"
});

var query = new Query();

// query.geometry = geometry;
// query.geometryType = GeometryType.POLYGON;
// query.spatialRel = SpatialRelationship.INTERSECTS;
// query.outFields = ["*"];
// query.returnGeometry = true;

query.where = "1=1";  // This will select all features
query.outFields = ["OBJECTID", "LV_NUMBER"];  // Specify the fields you want to retrieve
query.returnGeometry = false;  // Set to true if you need geometric data

var pageSize = 1000;
var pageIndex = 0;

function fetchPage() {
    query.start = pageIndex * pageSize;
    query.num = pageSize;

    qTask.execute(query).then(function(result) {
        if (result.features && result.features.length > 0) {
            var lvNumbers = result.features.map(function(feature) {
                return {
                    objectId: feature.attributes.OBJECTID,
                    lvNumber: feature.attributes.LV_NUMBER
                };
            });
            console.log("Retrieved page", pageIndex + 1, "with", lvNumbers.length, "parcels");
            
            // Process this page of results
            processResults(lvNumbers);

            // Check if there are more results
            if (result.features.length === pageSize) {
                pageIndex++;
                fetchPage();  // Fetch the next page
            } else {
                console.log("All pages retrieved");
            }
        } else {
            console.log("No more features to retrieve");
        }
    }).catch(function(error) {
        console.error("Error executing query:", error);
    });
}

function processResults(lvNumbers) {
    // Here you can process each page of results
    // For example, you could store them in a database or write to a file
    console.log("Processing", lvNumbers.length, "LV numbers");
}

// Start the fetching process
fetchPage();