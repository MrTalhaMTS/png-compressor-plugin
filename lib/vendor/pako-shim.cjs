// Minimal stand-in for the two pako functions that UPNG uses, backed by Node's zlib.
"use strict";
const zlib = require("node:zlib");

module.exports = {
  inflate(data) {
    return new Uint8Array(zlib.inflateSync(data));
  },
  deflate(data) {
    return new Uint8Array(zlib.deflateSync(data, { level: 9 }));
  },
};
