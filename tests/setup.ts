class MemoryStorage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

const localStorage = new MemoryStorage()

if (!(globalThis as Record<string, unknown>).window) {
  ;(globalThis as Record<string, unknown>).window = {}
}

;(globalThis as { localStorage: MemoryStorage }).localStorage = localStorage
;(globalThis as {
  window: {
    localStorage?: MemoryStorage
    electron?: unknown
    location?: { hostname: string; port: string }
    require?: (moduleName: string) => unknown
  }
}).window.localStorage = localStorage
;(globalThis as {
  window: {
    localStorage?: MemoryStorage
    electron?: unknown
    location?: { hostname: string; port: string }
    require?: (moduleName: string) => unknown
  }
}).window.location = { hostname: '', port: '' }
;(globalThis as {
  window: {
    localStorage?: MemoryStorage
    electron?: unknown
    location?: { hostname: string; port: string }
    require?: (moduleName: string) => unknown
  }
}).window.require = () => undefined
