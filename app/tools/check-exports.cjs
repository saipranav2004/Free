#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Import and export consistency check
// ---------------------------------------------------------------------------
// `vite build` did NOT catch a shared module losing five of its exports,
// because Rollup resolves a missing named export from a first-party module to
// undefined and warns rather than failing. The app built cleanly and every
// page that imported Card rendered a blank screen.
//
// This walks every relative import in src/ and asserts the named bindings it
// asks for are actually exported by the file it points at.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'src')
const files = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.(js|jsx)$/.test(entry.name)) files.push(p)
  }
})(ROOT)

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  if (/export\s+default/.test(src)) names.add('default')
  if (/export\s+\*/.test(src)) names.add('*')
  return names
}

function resolve(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const c of [base, base + '.js', base + '.jsx', path.join(base, 'index.js'), path.join(base, 'index.jsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

const cache = new Map()
const problems = []

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]*)['"]/g
  for (const m of src.matchAll(importRe)) {
    const [, defaultName, named, spec] = m
    const target = resolve(file, spec)
    if (!target) {
      problems.push(`${path.relative(ROOT, file)}: cannot resolve "${spec}"`)
      continue
    }
    if (!cache.has(target)) cache.set(target, exportsOf(target))
    const available = cache.get(target)
    if (available.has('*')) continue
    if (defaultName && !available.has('default')) {
      problems.push(`${path.relative(ROOT, file)}: "${spec}" has no default export`)
    }
    // An import list may carry a block comment, e.g. `{ a, /* b, */ c }`.
    // Strip comments before splitting, or the comment markers are read as
    // binding names.
    const cleanNamed = (named || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const raw of cleanNamed.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim()
      if (!name) continue
      if (!available.has(name)) {
        problems.push(`${path.relative(ROOT, file)}: "${spec}" does not export ${name}`)
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`imports check: ${files.length} files, every named import resolves`)
} else {
  problems.forEach((p) => console.log('  ' + p))
  console.log(`\n${problems.length} broken imports`)
  process.exitCode = 1
}
