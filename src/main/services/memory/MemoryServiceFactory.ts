import { app } from 'electron'
import Store from 'electron-store'
import { UnifiedMemoryBackend } from './UnifiedMemoryBackend'
import { ServerMemoryAdapter } from './adapters/ServerMemoryAdapter'
import { MementoMCPAdapter } from './adapters/MementoMCPAdapter'
import { SQLiteMemoryAdapter } from './adapters/SQLiteMemoryAdapter'

/**
 * Memory Configuration
 */
export interface MemoryConfig {
  backend: 'server-memory' | 'memento-mcp' | 'sqlite'
  
  serverMemory?: {
    storagePath: string
  }
  
  memento?: {
    neo4jUri: string
    username: string
    password: string
  }
  
  sqlite?: {
    storagePath: string
  }
  
  autoMigration?: {
    enabled: boolean
    thresholds: {
      entityCount: number
      searchLatency: number    // ms
      fileSize: number         // bytes
    }
  }
}

/**
 * Default Configuration
 */
const DEFAULT_CONFIG: MemoryConfig = {
  backend: 'sqlite',
  
  sqlite: {
    storagePath: app.getPath('userData') + '/memory_v2.db'
  },

  serverMemory: {
    storagePath: app.getPath('userData') + '/memory'
  },
  
  autoMigration: {
    enabled: true,
    thresholds: {
      entityCount: 10000,
      searchLatency: 100,
      fileSize: 50 * 1024 * 1024  // 50MB
    }
  }
}

/**
 * MemoryServiceFactory
 * 
 * Creates the appropriate memory backend based on configuration.
 * Allows swapping backends without changing application code.
 * 
 * Usage:
 *   const backend = MemoryServiceFactory.create()
 *   await backend.createEntity({...})
 * 
 * To switch backends:
 *   1. Update config.backend to 'memento-mcp'
 *   2. Restart service
 *   3. Data migrates automatically
 */
export class MemoryServiceFactory {
  // Use same type assertion as store.ts for consistent API
  private static store = new Store<Record<string, unknown>>() as Store<Record<string, unknown>> & {
    get: (key: string, defaultValue?: unknown) => unknown;
    set: (key: string, value: unknown) => void;
  }
  
  /**
   * Create backend instance based on config
   */
  static create(config?: MemoryConfig): UnifiedMemoryBackend {
    const finalConfig = config || this.loadConfig()
    
    switch (finalConfig.backend) {
      case 'server-memory':
        if (!finalConfig.serverMemory) {
          throw new Error('server-memory config missing')
        }
        return new ServerMemoryAdapter(finalConfig.serverMemory)
        
      case 'memento-mcp':
        if (!finalConfig.memento) {
          throw new Error('memento-mcp config missing. Please configure Neo4j settings.')
        }
        return new MementoMCPAdapter(finalConfig.memento)
        
      case 'sqlite':
        if (!finalConfig.sqlite) {
          throw new Error('sqlite config missing')
        }
        return new SQLiteMemoryAdapter(finalConfig.sqlite)
        
      default: {
        const _exhaustiveCheck: never = finalConfig.backend
        throw new Error(`Unknown backend: ${_exhaustiveCheck}`)
      }
    }
  }
  
  /**
   * Load configuration from electron-store
   */
  static loadConfig(): MemoryConfig {
    const config = this.store.get('memory', DEFAULT_CONFIG) as MemoryConfig
    if (config.backend === 'memento-mcp') {
      const fallback: MemoryConfig = { ...config, backend: 'sqlite', sqlite: config.sqlite || DEFAULT_CONFIG.sqlite }
      console.warn('[MemoryServiceFactory] Memento MCP is unavailable; falling back to SQLite memory')
      this.store.set('memory', fallback)
      return fallback
    }
    return config
  }
  
  /**
   * Save configuration to electron-store
   */
  static saveConfig(config: MemoryConfig): void {
    this.store.set('memory', config)
  }
  
  /**
   * Update backend (triggers migration)
   */
  static async switchBackend(newBackend: 'server-memory' | 'memento-mcp' | 'sqlite'): Promise<void> {
    const config = MemoryServiceFactory.loadConfig()
    config.backend = newBackend
    MemoryServiceFactory.saveConfig(config)
  }
  
  /**
   * Get current backend name
   */
  static getCurrentBackend(): string {
    return this.loadConfig().backend
  }
  
  /**
   * Check if auto-migration is enabled
   */
  static isAutoMigrationEnabled(): boolean {
    return this.loadConfig().autoMigration?.enabled ?? true
  }
  
  /**
   * Get migration thresholds
   */
  static getMigrationThresholds() {
    return this.loadConfig().autoMigration?.thresholds || DEFAULT_CONFIG.autoMigration!.thresholds
  }
}
