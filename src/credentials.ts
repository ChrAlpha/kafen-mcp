import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

export interface Credential {
  /** Discourse User API key. */
  key: string
  /** `User-Api-Client-Id` the key was issued to. */
  clientId: string
  scopes: string[]
  username?: string
  createdAt: string
  /** ISO timestamp when the key stops working, if the forum set one. */
  expiresAt?: string
}

interface CredentialFile {
  version: 1
  /** Keyed by forum base URL so one store can serve several Discourse sites. */
  sites: Record<string, Credential>
}

/**
 * Persists User API keys in a 0600 JSON file. Every read goes to disk so a
 * long-running MCP server picks up a `kafen-mcp login` done in another process.
 */
export class CredentialStore {
  readonly path: string

  constructor(readonly dir: string) {
    this.path = join(dir, 'credentials.json')
  }

  async get(baseUrl: string): Promise<Credential | undefined> {
    return (await this.read()).sites[baseUrl]
  }

  async set(baseUrl: string, credential: Credential): Promise<void> {
    const file = await this.read()
    file.sites[baseUrl] = credential
    await this.write(file)
  }

  async delete(baseUrl: string): Promise<boolean> {
    const file = await this.read()
    if (!(baseUrl in file.sites))
      return false
    delete file.sites[baseUrl]
    if (Object.keys(file.sites).length === 0)
      await rm(this.path, { force: true })
    else
      await this.write(file)
    return true
  }

  private async read(): Promise<CredentialFile> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, sites: {} }
      throw error
    }
    const parsed = JSON.parse(text) as Partial<CredentialFile>
    return { version: 1, sites: parsed.sites ?? {} }
  }

  private async write(file: CredentialFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.path)
  }
}
