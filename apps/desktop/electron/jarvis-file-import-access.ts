import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

interface FolderPolicy {
  allowed: string[]
  blocked: string[]
}

function inside(file: string, folder: string): boolean {
  const relative = path.relative(folder, file)

  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function canonical(file: string): string {
  try {return fs.realpathSync(file)}
  catch {throw new Error('Attachment is unavailable or its path changed. Choose it again and retry.')}
}

export class JarvisFileImportAccess {
  private readonly selected = new Map<string, Map<string, string>>()

  constructor(private readonly userData: string) {}

  private policyFile(scope: string): string {
    return path.join(this.userData, `jarvis-file-import-${createHash('sha256').update(scope).digest('hex')}.json`)
  }

  private policy(scope: string): FolderPolicy {
    try {
      const raw = fs.readFileSync(this.policyFile(scope), 'utf8')

      if (raw.length > 64 * 1024) {throw new Error('Oversized file import policy')}
      const value: unknown = JSON.parse(raw)

      if (!value || typeof value !== 'object') {throw new Error('Invalid file import policy')}
      const record = value as Record<string, unknown>

      if (!Array.isArray(record.allowed) || !Array.isArray(record.blocked)) {throw new Error('Invalid file import policy')}

      if (![...record.allowed, ...record.blocked].every(item => typeof item === 'string' && path.isAbsolute(item))) {
        throw new Error('Invalid file import policy')
      }

      return { allowed: record.allowed as string[], blocked: record.blocked as string[] }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { allowed: [], blocked: [] }
      }

      throw new Error('Could not verify attachment import permissions. Retry from Connections & permissions.')
    }
  }

  private save(scope: string, policy: FolderPolicy): void {
    fs.mkdirSync(this.userData, { recursive: true })
    const target = this.policyFile(scope)
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`

    try {
      fs.writeFileSync(temporary, JSON.stringify(policy), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, target)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  list(scope: string): FolderPolicy {
    return this.policy(scope)
  }

  selectFiles(scope: string, files: string[]): void {
    const selections = this.selected.get(scope) ?? new Map<string, string>()

    for (const file of files) {
      if (!path.isAbsolute(file)) {continue}

      try {
        const real = canonical(file)

        if (fs.statSync(real).isFile()) {selections.set(path.resolve(file), real)}
      } catch { /* Missing picks cannot grant access. */ }
    }

    this.selected.set(scope, selections)
  }

  setFolder(scope: string, folder: string, mode: 'allow' | 'block'): FolderPolicy {
    const raw = path.resolve(folder)

    try {
      if (!fs.statSync(raw).isDirectory()) {throw new Error('Not a directory')}
    } catch {throw new Error('Folder is unavailable. Choose it again and retry.')}

    const real = canonical(raw)
    const policy = this.policy(scope)
    policy.allowed = policy.allowed.filter(item => item !== raw && item !== real)
    policy.blocked = policy.blocked.filter(item => item !== raw && item !== real)
    const target = mode === 'allow' ? policy.allowed : policy.blocked
    target.push(raw)

    if (real !== raw) {target.push(real)}
    this.save(scope, policy)

    return policy
  }

  revokeFolder(scope: string, folder: string): FolderPolicy {
    const raw = path.resolve(folder)
    const policy = this.policy(scope)

    if (!policy.allowed.includes(raw)) {throw new Error('Folder grant was not found. Refresh and retry.')}
    let real = raw

    try {real = canonical(raw)} catch { /* Revoke the original path even if removed. */ }
    policy.allowed = policy.allowed.filter(item => item !== raw && item !== real)

    // A revocation overrides older exact picker grants until explicitly allowed again.
    if (!policy.blocked.includes(raw)) {policy.blocked.push(raw)}

    if (real !== raw && !policy.blocked.includes(real)) {policy.blocked.push(real)}
    this.save(scope, policy)

    return policy
  }

  assertAllowed(scope: string, file: string): string {
    if (!path.isAbsolute(file)) {
      throw new Error('Attachment import needs a file picked in Jarvis or an allowed folder. Choose the file again and retry.')
    }

    const raw = path.resolve(file)
    const real = canonical(raw)

    try {
      if (!fs.statSync(real).isFile()) {throw new Error('Not a file')}
    } catch {throw new Error('Attachment is unavailable or its path changed. Choose it again and retry.')}

    const policy = this.policy(scope)

    if (policy.blocked.some(folder => inside(raw, folder) || inside(real, folder))) {
      throw new Error('Attachment import blocked for this folder. Change its access in Connections & permissions, then retry.')
    }

    const selected = this.selected.get(scope)?.get(raw)
    const exactSelection = selected === real

    const folderGrant = policy.allowed.some(folder => inside(raw, folder))
      && policy.allowed.some(folder => inside(real, folder))

    if (!exactSelection && !folderGrant) {
      throw new Error('Attachment import needs a file picked in Jarvis or an allowed folder. Choose the file again or allow its folder, then retry.')
    }

    return real
  }
}
