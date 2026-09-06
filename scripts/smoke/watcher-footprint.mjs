import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const usage = `Usage: node scripts/smoke/watcher-footprint.mjs [options]

Options:
  --url <url>         Perf endpoint (default: http://localhost:4000/api/perf)
  --pid <pid>         Explicit server PID; must match /api/perf.runtime.pid
  --max <count>       Maximum physical inotify watch entries (default: 1000)
  --tolerance <count> Allowed direct/API sampling difference (default: 4)
  --help              Show this help`;

function readValue(flag, index) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value\n\n${usage}`);
  return value;
}

function positiveInteger(flag, value, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return number;
}

let explicitPid = null;
let max = 1000;
let tolerance = 4;
let url = 'http://localhost:4000/api/perf';
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (flag === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (flag === '--pid') {
    explicitPid = positiveInteger(flag, readValue(flag, index));
    index++;
  } else if (flag === '--max') {
    max = positiveInteger(flag, readValue(flag, index), { allowZero: true });
    index++;
  } else if (flag === '--tolerance') {
    tolerance = positiveInteger(flag, readValue(flag, index), { allowZero: true });
    index++;
  } else if (flag === '--url') {
    url = readValue(flag, index);
    index++;
  } else {
    throw new Error(`Unknown argument: ${flag}\n\n${usage}`);
  }
}

if (process.platform !== 'linux') {
  console.log(`watcher footprint skipped: ${process.platform} does not expose Linux fdinfo`);
  process.exit(0);
}

function readProcWatchers(targetPid) {
  const fdInfoDir = `/proc/${targetPid}/fdinfo`;
  let inotifyFds = 0;
  let watchEntries = 0;
  for (const fd of fs.readdirSync(fdInfoDir)) {
    let content;
    try {
      content = fs.readFileSync(path.join(fdInfoDir, fd), 'utf8');
    } catch {
      continue;
    }
    const entries = content.match(/^inotify wd:/gm)?.length || 0;
    if (entries > 0) inotifyFds++;
    watchEntries += entries;
  }
  return { pid: targetPid, inotifyFds, watchEntries };
}

function getJson(targetUrl) {
  return new Promise((resolve, reject) => {
    http.get(targetUrl, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

let perf;
try {
  perf = await getJson(url);
} catch (err) {
  throw new Error(`Unable to read ${url}: ${err.message}`);
}

const apiPid = Number(perf?.runtime?.pid);
if (!Number.isInteger(apiPid) || apiPid <= 0) {
  throw new Error(`${url} did not report a valid runtime.pid`);
}
if (explicitPid !== null && explicitPid !== apiPid) {
  throw new Error(`--pid ${explicitPid} does not match ${url} runtime.pid ${apiPid}`);
}

const pid = explicitPid ?? apiPid;
const apiLinux = perf?.watchers?.linux;
if (apiLinux?.supported !== true || !Number.isInteger(apiLinux.watchEntries) || apiLinux.watchEntries < 0) {
  throw new Error(`${url} did not report a valid watchers.linux.watchEntries count`);
}
if (apiLinux.error) throw new Error(`${url} watcher sample failed: ${apiLinux.error}`);

const direct = readProcWatchers(pid);
const difference = Math.abs(direct.watchEntries - apiLinux.watchEntries);
const api = {
  pid: apiPid,
  websocketClients: perf.websocketClients,
  topology: perf.watchers,
  difference,
  tolerance,
};

console.log(JSON.stringify({ direct, api }, null, 2));
if (difference > tolerance) {
  throw new Error(
    `direct watcher count ${direct.watchEntries} differs from API count ${apiLinux.watchEntries} `
    + `by ${difference} (tolerance ${tolerance})`,
  );
}
if (direct.watchEntries > max || apiLinux.watchEntries > max) {
  throw new Error(
    `watch entry count exceeds limit ${max} (direct=${direct.watchEntries}, api=${apiLinux.watchEntries})`,
  );
}
