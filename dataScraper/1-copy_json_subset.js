const fs = require('fs');
const JSONStream = require('JSONStream');
const es = require('event-stream');

const inputFile = 'land-valuation-numbers.json';
const chunkSize = 10000;
let currentChunk = [];
let fileCounter = 1;

function writeChunkToFile(chunk, callback) {
  const outputFile = `${fileCounter}-land-valuation.json`;
  fs.writeFile(outputFile, JSON.stringify(chunk, null, 2), (err) => {
    if (err) {
      console.error(`Error writing file ${outputFile}:`, err);
    } else {
      console.log(`Wrote ${chunk.length} objects to ${outputFile}`);
    }
    fileCounter++;
    callback();
  });
}

fs.createReadStream(inputFile)
  .pipe(JSONStream.parse('*'))
  .pipe(es.through(
    function write(data) {
      currentChunk.push(data);
      if (currentChunk.length === chunkSize) {
        this.pause();
        writeChunkToFile(currentChunk, () => {
          currentChunk = [];
          this.resume();
        });
      }
    },
    function end() {
      if (currentChunk.length > 0) {
        writeChunkToFile(currentChunk, () => {
          console.log('Finished processing all chunks.');
        });
      } else {
        console.log('Finished processing all chunks.');
      }
    }
  ));