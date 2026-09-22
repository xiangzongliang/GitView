// Unified diff parser — turns raw `git diff` output into structured hunks.

export type DiffLineKind = 'ctx' | 'add' | 'del' | 'nonl'

export interface DiffLine {
  kind: DiffLineKind
  oldNo: number
  newNo: number
  text: string
}

export interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface DiffFile {
  header: string
  oldPath: string
  newPath: string
  meta: string[]
  binary: boolean
  newFile: boolean
  deletedFile: boolean
  renamed: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

function newFile(header: string): DiffFile {
  return {
    header,
    oldPath: '',
    newPath: '',
    meta: [],
    binary: false,
    newFile: false,
    deletedFile: false,
    renamed: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  }
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  if (!raw) return files

  let text = raw
  if (text.endsWith('\n')) text = text.slice(0, -1)
  const lines = text.split('\n')

  let cur: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const flushHunk = () => {
    if (cur && hunk) cur.hunks.push(hunk)
    hunk = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushHunk()
      cur = newFile(line)
      files.push(cur)
      const rest = line.slice('diff --git '.length)
      const bi = rest.lastIndexOf(' b/')
      if (bi >= 0) {
        cur.oldPath = rest.slice(0, bi).replace(/^a\//, '')
        cur.newPath = rest.slice(bi + 3)
      }
      continue
    }

    if (!cur) {
      // Diff text without a `diff --git` header (synthesized / piped).
      if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        cur = newFile('')
        files.push(cur)
      } else {
        continue
      }
    }

    if (line.startsWith('@@')) {
      flushHunk()
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldNo = m ? parseInt(m[1], 10) : 1
      newNo = m ? parseInt(m[2], 10) : 1
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] }
      continue
    }

    if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'add', oldNo: 0, newNo: newNo++, text: line.slice(1) })
        cur.additions++
      } else if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: 0, text: line.slice(1) })
        cur.deletions++
      } else if (line.startsWith('\\')) {
        hunk.lines.push({ kind: 'nonl', oldNo: 0, newNo: 0, text: line })
      } else {
        hunk.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
      }
      continue
    }

    // File-level metadata (between the header and the first hunk).
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true
      continue
    }
    if (line.startsWith('new file mode')) cur.newFile = true
    if (line.startsWith('deleted file mode')) cur.deletedFile = true
    if (
      line.startsWith('rename from') ||
      line.startsWith('rename to') ||
      line.startsWith('similarity index')
    ) {
      cur.renamed = true
    }
    cur.meta.push(line)
  }
  flushHunk()
  return files
}

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  vue: 'xml', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json',
  go: 'go', py: 'python', rs: 'rust', rb: 'ruby', php: 'php',
  java: 'java', kt: 'kotlin', swift: 'swift', scala: 'scala', groovy: 'groovy',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp', m: 'objectivec',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', properties: 'ini',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql', lua: 'lua', pl: 'perl', r: 'r', dart: 'dart',
  gradle: 'gradle', txt: 'plaintext',
}

export function langFromPath(p: string): string | undefined {
  const base = (p || '').split('/').pop() || ''
  if (/^dockerfile/i.test(base)) return 'dockerfile'
  if (/^makefile$/i.test(base)) return 'makefile'
  if (/^taskfile/i.test(base)) return 'yaml'
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
  return LANGS[ext]
}
