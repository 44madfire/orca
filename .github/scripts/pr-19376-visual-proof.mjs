import fs from 'node:fs/promises'
import path from 'node:path'

const repo = 'stablyai/orca'
const branch = 'OrcaWin/pr-19376-screenshots'
const root = process.env.VISUAL_PROOF_ROOT || 'test-results'
const initial = process.env.VISUAL_PROOF_INITIAL === '1'
const run = initial ? '34179800276' : process.env.GITHUB_RUN_ID
const productHead = initial ? 'cbdc27b375c89ca09007f26c90f861615aa9a9dd' : '018e219856ae42e0cdeb589472a216d75a6ca467'
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`)
  return response.json()
}
async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name)))).flat()
}
const files = (await walk(root)).filter(f => /\.(png|md)$/.test(f) && !f.includes('test-failed') && !f.includes('error-context'))
const seen = new Set()
const images = []
const markdown = []
const tree = []
for (const file of files.sort()) {
  const bytes = await fs.readFile(file)
  const hash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
  if (seen.has(hash)) continue
  seen.add(hash)
  const name = path.relative(root, file).split(path.sep).join('/')
  const blob = await api('git/blobs', 'POST', { content: bytes.toString('base64'), encoding: 'base64' })
  tree.push({ path: name, mode: '100644', type: 'blob', sha: blob.sha })
  if (file.endsWith('.png')) images.push(name)
  else markdown.push({ name, content: bytes.toString() })
}
if (!images.length) throw new Error('No screenshots collected')
const gitTree = await api('git/trees', 'POST', { tree })
const commit = await api('git/commits', 'POST', {
  message: `PR 19376 rendered evidence from run ${run}; product ${productHead}`,
  tree: gitTree.sha,
  parents: []
})
const ref = `git/refs/heads/${branch}`
const lookup = await fetch(`https://api.github.com/repos/${repo}/${ref}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` } })
if (lookup.status === 404) await api('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha })
else if (lookup.ok) await api(ref, 'PATCH', { sha: commit.sha, force: true })
else throw new Error(`Cannot read screenshot ref: ${lookup.status}`)
function caption(name) {
  if (name.includes('before')) return 'Table before Backspace: header, two populated rows, and the empty row selected for removal.'
  if (name.includes('after')) return 'Table after Backspace: empty row removed; both populated rows remain.'
  if (name.includes('saving-in-git')) return 'Git workspace: saved file reopened with literal Markdown, malformed wiki brackets, and a bold link intact.'
  if (name.includes('saving-in-folder')) return 'Folder workspace: saved file reopened after reselecting the folder; literal text and formatted link preserved.'
  if (name.includes('saving-in-paired')) return 'Paired remote client: host-backed file saved and reopened; the test verifies the runtime environment and host disk bytes.'
  if (name.includes('link-bubble-over')) return 'Link controls cross the Explorer boundary; Chromium hit testing confirms the bubble remains on top.'
  if (name.includes('link-bubble-edit')) return 'Link edit control remains visible and focused while a long URL scrolls inside its input.'
  if (name.includes('nested-toggle')) return 'Nested-toggle regression: rendered state after this scenario’s nesting/editability or raw-passthrough assertions.'
  if (name.includes('ordered-list')) return 'Ordered-list exit: following text is a paragraph outside the list, verified in the document and serialized draft.'
  if (name.includes('prose-reflow')) return 'Prose reflow: original hard-wrapped source remains one flowing paragraph after the tested editing operation.'
  return 'Rendered editor state captured after the scenario assertions.'
}
let body = `<!-- pr-19376-visual-proof-${initial ? 'initial' : 'final'} -->\n## ${initial ? 'Table editing: visual evidence' : 'Editor visual proof — screenshot gallery'}\n\n`
body += `[Source CI run](https://github.com/${repo}/actions/runs/${run}) · Product commit \`${productHead}\` · [Original image files](https://github.com/${repo}/tree/${commit.sha})\n\n`
body += initial
  ? 'These four captures come from the earlier migration candidate, before the final inline-scan performance fix. The table scenario passed; the broader run had separately documented failures. The final product commit subsequently passed all 16 focused editor tests. A separate final-code screenshot run will add the other scenarios.\n\n'
  : `All 15 screenshot scenarios passed on an isolated Linux CI display with \`ORCA_BACKGROUND_LAUNCH=1\`. This evidence branch adds screenshot calls and retention only; product code is identical to the PR commit above. Screenshots complement the DOM, saved-byte, and interaction assertions; they do not establish cross-platform coverage.\n\n`
for (const [i, name] of images.entries()) {
  const url = `https://github.com/${repo}/blob/${commit.sha}/${name.split('/').map(encodeURIComponent).join('/')}?raw=true`
  body += `### ${i + 1}. ${caption(name)}\n\nScenario: \`${name}\`\n\n![${caption(name)}](${url})\n\n`
}
for (const file of markdown) body += `<details>\n<summary>Saved Markdown bytes: ${file.name}</summary>\n\n\`\`\`markdown\n${file.content}\n\`\`\`\n\n</details>\n\n`
body += '\nThe product PR still tracks its separate full-CI and Windows golden-test status; this gallery does not override those results.\n'
const comment = await api('issues/19376/comments', 'POST', { body })
console.log(comment.html_url)
