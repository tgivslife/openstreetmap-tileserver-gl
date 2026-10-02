'use strict'

// Keep every place that names the image version in step with package.json, the single source of truth.
//
//   npm run version:sync                     # write the version into the dev compose files
//   node scripts/version-sync.js --check     # change nothing; exit 1 listing whatever disagrees (run by npm test)
//
// package.json holds the fork's own semver "version", which tags the images (<version>, <version>-light and
// <version>-light-s3), and "upstreamVersion", the tileserver-gl release the code is based on.
//
// Checked: the version is semver; the root CHANGELOG.md has a "## [<version>]" section naming
// "Upstream: tileserver-gl <upstreamVersion>"; and every stsdockerhub/tileserver-gl image in tileserver-gl-dev/compose*.yml
// is written ${TILESERVER_VERSION:-<version>}.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(appDir, '..')
const devDir = path.join(repoDir, 'tileserver-gl-dev')
const check = process.argv.includes('--check')

const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
const { version, upstreamVersion } = pkg
const problems = []

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  problems.push(`package.json: version "${version}" is not semver (MAJOR.MINOR.PATCH)`)
}
if (!upstreamVersion) {
  problems.push('package.json: no "upstreamVersion" naming the tileserver-gl release this is based on')
}

// The release's section runs from its heading to the next "## [" heading.
const changelog = fs.readFileSync(path.join(repoDir, 'CHANGELOG.md'), 'utf8')
const start = changelog.indexOf(`## [${version}]`)
if (start === -1) {
  problems.push(`CHANGELOG.md: no "## [${version}]" section`)
} else {
  const next = changelog.indexOf('\n## [', start + 1)
  const section = changelog.slice(start, next === -1 ? undefined : next)
  if (!section.includes(`Upstream: tileserver-gl ${upstreamVersion}`)) {
    problems.push(`CHANGELOG.md: the ${version} section does not say "Upstream: tileserver-gl ${upstreamVersion}"`)
  }
}

// The image reference as the compose files write it; the default after ":-" is what this script maintains.
const imagePattern = /(stsdockerhub\/tileserver-gl:\$\{TILESERVER_VERSION:-)([^}]*)(\})/g
const composeFiles = fs.readdirSync(devDir).filter((f) => /^compose.*\.ya?ml$/.test(f))
for (const file of composeFiles) {
  const fullPath = path.join(devDir, file)
  const text = fs.readFileSync(fullPath, 'utf8')
  if (/^\s*image:\s*stsdockerhub\/tileserver-gl:(?!\$\{TILESERVER_VERSION:-)/m.test(text)) {
    problems.push(`tileserver-gl-dev/${file}: an image tag is hard-coded instead of \${TILESERVER_VERSION:-…}`)
  }
  const stale = [...text.matchAll(imagePattern)].filter((m) => m[2] !== version).map((m) => m[2])
  if (!stale.length) continue
  if (check) {
    problems.push(`tileserver-gl-dev/${file}: image default ${[...new Set(stale)].join(', ')} instead of ${version}`)
  } else {
    fs.writeFileSync(fullPath, text.replace(imagePattern, `$1${version}$3`))
    console.log(`updated tileserver-gl-dev/${file} -> ${version}`)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  if (check) console.error('Fix with `npm run version:sync` and a CHANGELOG.md section for this version.')
  process.exit(1)
}
if (check) console.log(`version ${version} (upstream ${upstreamVersion}) is consistent`)
