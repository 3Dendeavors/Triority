const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    args.set(arg, process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function requiredMatch(label, text, re) {
  const match = text.match(re);
  if (!match) throw new Error(`Could not read ${label}`);
  return match[1];
}

const gradle = read('android/app/build.gradle');
const app = read('App.tsx');

const gradleVersionCode = Number(requiredMatch('android versionCode', gradle, /versionCode\s+(\d+)/));
const gradleVersionName = requiredMatch('android versionName', gradle, /versionName\s+"([^"]+)"/);
const appVersionCode = Number(requiredMatch('App CURRENT_APP_VERSION_CODE', app, /CURRENT_APP_VERSION_CODE\s*=\s*(\d+)/));
const appVersionName = requiredMatch('App CURRENT_APP_VERSION_NAME', app, /CURRENT_APP_VERSION_NAME\s*=\s*['"]([^'"]+)['"]/);

if (gradleVersionCode !== appVersionCode) {
  throw new Error(`Version code mismatch: android=${gradleVersionCode}, App.tsx=${appVersionCode}`);
}

if (gradleVersionName !== appVersionName) {
  throw new Error(`Version name mismatch: android=${gradleVersionName}, App.tsx=${appVersionName}`);
}

const tag = args.get('--tag') || process.env.GITHUB_REF_NAME || '';
if (tag) {
  const tagVersion = tag.replace(/^v/, '');
  if (tagVersion !== gradleVersionName) {
    throw new Error(`Tag ${tag} does not match versionName ${gradleVersionName}`);
  }
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version_code=${gradleVersionCode}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version_name=${gradleVersionName}\n`);
}

console.log(`Release version OK: v${gradleVersionName} (${gradleVersionCode})`);
