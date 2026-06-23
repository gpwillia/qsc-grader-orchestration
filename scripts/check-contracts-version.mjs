import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = '/Users/glennwilliamson/workspace';

const contractsPkgPath = resolve(root, 'packages/contracts/package.json');
const contractsPkg = JSON.parse(readFileSync(contractsPkgPath, 'utf8'));
const expectedVersion = contractsPkg.version;

const appPackages = [
  'apps/mock-intellum/package.json',
  'apps/orchestration/package.json',
  'apps/mock-qsc-ui/package.json'
];

let failed = false;

for (const pkgRelPath of appPackages) {
  const pkgPath = resolve(root, pkgRelPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const dependencyVersion = pkg.dependencies?.['@qsc/contracts'];

  if (dependencyVersion !== expectedVersion) {
    failed = true;
    console.error(
      `[contracts-version] ${pkg.name} depends on @qsc/contracts=${dependencyVersion ?? 'MISSING'}, expected ${expectedVersion}`
    );
  }
}

if (failed) {
  process.exit(1);
}

console.log(`[contracts-version] OK. All apps pinned to @qsc/contracts=${expectedVersion}`);
