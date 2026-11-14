// Preloaded into install.js by the tests (node --require). It serves every
// download from a fixture directory, so no test touches the network, and
// lets a test pretend to be another platform.

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

if (process.env.PF_TEST_PLATFORM) {
  os.platform = () => process.env.PF_TEST_PLATFORM;
}
if (process.env.PF_TEST_ARCH) {
  os.arch = () => process.env.PF_TEST_ARCH;
}

https.get = (target, options, callback) => {
  const respond = typeof options === 'function' ? options : callback;
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => {};
  setImmediate(() => {
    const name = path.basename(new URL(target).pathname);
    if (process.env.PF_TEST_LOG) {
      fs.appendFileSync(process.env.PF_TEST_LOG, `${name}\n`);
    }
    if (process.env.PF_TEST_OFFLINE) {
      request.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
      return;
    }
    const file = path.join(process.env.PF_TEST_FIXTURES, name);
    const response = new PassThrough();
    response.headers = {};
    if (!fs.existsSync(file)) {
      response.statusCode = 404;
      respond(response);
      response.end();
      return;
    }
    response.statusCode = 200;
    respond(response);
    fs.createReadStream(file).pipe(response);
  });
  return request;
};
