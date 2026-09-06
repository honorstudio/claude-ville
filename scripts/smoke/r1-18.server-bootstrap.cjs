'use strict';

// The production server intentionally owns port 4000. The replay harness
// loads this bootstrap in a child and redirects only that child's listen call
// to port 0, allowing the operating system to choose an isolated port.
const http = require('node:http');

const serverModulePath = process.argv[2];
if (!serverModulePath) {
  console.error('R1-18 server bootstrap requires an absolute server module path');
  process.exit(2);
}

const originalListen = http.Server.prototype.listen;
let listenRedirected = false;

http.Server.prototype.listen = function redirectReplayListen(...args) {
  if (listenRedirected) return originalListen.apply(this, args);
  listenRedirected = true;

  const listenArgs = args.slice();
  const callback = typeof listenArgs.at(-1) === 'function' ? listenArgs.pop() : null;

  if (typeof listenArgs[0] === 'number') {
    listenArgs[0] = 0;
  } else if (listenArgs[0] && typeof listenArgs[0] === 'object') {
    listenArgs[0] = { ...listenArgs[0], port: 0 };
  } else if (typeof listenArgs[0] === 'string' && /^\d+$/.test(listenArgs[0])) {
    listenArgs[0] = '0';
  }

  const target = this;
  listenArgs.push(function onReplayListening(...callbackArgs) {
    if (callback) callback.apply(target, callbackArgs);
    const address = target.address();
    if (address && typeof address === 'object') {
      process.stdout.write(`R1_18_READY ${address.port}\n`);
    }
  });

  return originalListen.apply(target, listenArgs);
};

let serverModule;
let shutdownRequested = false;

function requestShutdown() {
  if (shutdownRequested || !serverModule) return;
  shutdownRequested = true;
  serverModule.shutdownRuntime({
    reason: 'r1-18-harness',
    exitCode: 0,
    exitProcess: true,
  });
}

try {
  serverModule = require(serverModulePath);
  serverModule._watcherTest?.installProcessHandlers?.();
  const server = serverModule.startServer();
  server.once('error', (error) => {
    const message = String(error?.message || error).replace(/[\r\n]+/g, ' ');
    process.stdout.write(`R1_18_SERVER_ERROR ${message}\n`);
    requestShutdown();
  });
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('shutdown')) requestShutdown();
});
process.stdin.on('end', requestShutdown);
