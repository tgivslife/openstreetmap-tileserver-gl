'use strict'

// Cut a release as a single commit, and tag it.
//
//   npm run release -- 1.1.0                 # on a clean main: commit "build(release): 1.1.0", tag v1.1.0, push nothing
//   node scripts/release.js --check          # change nothing; exit 1 unless HEAD is the release commit for package.json's
//                                            # version (run by the Docker images workflow on a version tag)
//
// The release commit changes only the release files: CHANGELOG.md, whose Unreleased entries move under
// "## [<version>] - <today>"; package.json and package-lock.json, which take the version (npm version); and the dev
// compose files, whose image default ${TILESERVER_VERSION:-<version>} becomes the new version. The tag is annotated with
// the release's changelog section. If anything fails before the commit, the release files are restored.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(appDir, '..')
const devDir = path.join(repoDir, 'tileserver-gl-dev')
const changelogPath = path.join(repoDir, 'CHANGELOG.md')

// The image reference as the dev compose files write it; the default after ":-" is the released version.
const imagePattern = /(stsdockerhub\/tileserver-gl:\$\{TILESERVER_VERSION:-)[^}]*(\})/g

// Relative to the repository root: the only files a release commit may change.
const releaseFiles = /^(CHANGELOG\.md|tileserver-gl\/package(-lock)?\.json|tileserver-gl-dev\/compose[^/]*\.ya?ml)$/
const restorePaths = ['CHANGELOG.md', 'tileserver-gl/package.json', 'tileserver-gl/package-lock.json', 'tileserver-gl-dev']

const releaseSubject = (version) => `build(release): ${version}`
const readPackage = () => JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))

/**
 * Run a command and return its trimmed stdout, throwing with its output if it exits non-zero.
 * @param {string} command - Executable to run.
 * @param {string[]} args - Its arguments.
 * @param {{cwd?: string, input?: string}} [options] - Working directory (default: the repository root) and stdin.
 * @returns {string} Trimmed stdout.
 */
function run(command, args, { cwd = repoDir, input } = {}) {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
  }
  return result.stdout.trim()
}

/**
 * Print the message and exit 1.
 * @param {string} message - What went wrong.
 * @returns {never} Does not return.
 */
function fail(message) {
  console.error(message)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  const { version } = readPackage()
  const subject = run('git', ['log', '-1', '--format=%s'])
  const changed = run('git', ['diff', '--name-only', 'HEAD^', 'HEAD']).split('\n').filter(Boolean)
  const others = changed.filter((file) => !releaseFiles.test(file))
  const problems = []
  if (subject !== releaseSubject(version)) {
    problems.push(`HEAD is "${subject}", not the release commit "${releaseSubject(version)}"`)
  }
  if (others.length) {
    problems.push(`HEAD changes more than the release files: ${others.join(', ')}`)
  }
  if (problems.length) fail(`${problems.join('\n')}\nCut a release with \`npm run release -- <version>\`.`)
  console.log(`HEAD is the release commit for ${version}`)
  process.exit(0)
}

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  fail('Usage: npm run release -- <MAJOR.MINOR.PATCH>')
}
const { version: current } = readPackage()
if (version === current) fail(`package.json is already at ${version}`)
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('Releases are cut on main')
if (run('git', ['status', '--porcelain', '--untracked-files=no'])) fail('Commit or stash your changes first')
if (run('git', ['tag', '--list', `v${version}`])) fail(`Tag v${version} already exists`)

// Unreleased runs from its heading to the previous release's "## [" heading.
const changelog = fs.readFileSync(changelogPath, 'utf8')
const unreleasedHeading = '## [Unreleased]\n'
const start = changelog.indexOf(unreleasedHeading)
if (start === -1) fail('CHANGELOG.md: no "## [Unreleased]" section')
if (changelog.includes(`## [${version}]`)) fail(`CHANGELOG.md: a "## [${version}]" section already exists`)
const bodyStart = start + unreleasedHeading.length
const previousStart = changelog.indexOf('\n## [', bodyStart)
if (previousStart === -1) fail('CHANGELOG.md: no previous release after Unreleased')
const notes = changelog.slice(bodyStart, previousStart).trim()
if (!/^- /m.test(notes)) fail('CHANGELOG.md: Unreleased has no entries to release')

const now = new Date()
const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-')
const section = `## [${version}] - ${date}\n\n${notes}\n`

try {
  fs.writeFileSync(changelogPath, `${changelog.slice(0, bodyStart)}\n${section}${changelog.slice(previousStart)}`)
  run('npm', ['version', version, '--no-git-tag-version'], { cwd: appDir })
  let images = 0
  for (const file of fs.readdirSync(devDir).filter((f) => /^compose.*\.ya?ml$/.test(f))) {
    const fullPath = path.join(devDir, file)
    const text = fs.readFileSync(fullPath, 'utf8')
    images += [...text.matchAll(imagePattern)].length
    fs.writeFileSync(fullPath, text.replace(imagePattern, `$1${version}$2`))
  }
  if (!images) throw new Error('no ${TILESERVER_VERSION:-…} image default found in tileserver-gl-dev/compose*.yml')
  const changed = run('git', ['diff', '--name-only']).split('\n').filter(Boolean)
  const others = changed.filter((file) => !releaseFiles.test(file))
  if (others.length) throw new Error(`the release changed more than the release files: ${others.join(', ')}`)
  run('git', ['add', '--', ...changed])
  run('git', ['commit', '--quiet', '--cleanup=whitespace', '-F', '-'], {
    input: `${releaseSubject(version)}\n\n${notes}\n`
  })
} catch (error) {
  run('git', ['checkout', 'HEAD', '--', ...restorePaths])
  fail(`${error.message}\nNo release was made; the release files are back as they were.`)
}

run('git', ['tag', '--annotate', '--cleanup=whitespace', '-F', '-', `v${version}`], { input: `${version} - ${date}\n\n${notes}\n` })
const commit = run('git', ['rev-parse', '--short', 'HEAD'])
console.log(`Released ${version}: commit ${commit}, tag v${version}. Nothing is pushed; publish with:`)
console.log(`  git push github main v${version}`)
