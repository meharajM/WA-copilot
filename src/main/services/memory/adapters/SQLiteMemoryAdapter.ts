import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import {
  UnifiedMemoryBackend,
  CreateEntityInput,
  Entity,
  CreateRelationInput,
  Relation,
  SearchOptions,
  MemoryStats,
  ExportData
} from '../UnifiedMemoryBackend'

interface EntityRow {
  id: string
  name: string
  type: string
  description: string
  observations: string
  metadata: string
  createdAt: string
  updatedAt: string
}

interface RelationRow {
  id: string
  fromEntityId: string
  toEntityId: string
  relationType: string
  description: string
  metadata: string
}

/**
 * SQLiteMemoryAdapter
 * 
 * A robust, local SQLite implementation of the UnifiedMemoryBackend.
 * Replaces the fragile MCP-based server-memory adapter.
 */
export class SQLiteMemoryAdapter implements UnifiedMemoryBackend {
  private db: Database.Database
  private storagePath: string

  constructor(config: { storagePath: string }) {
    this.storagePath = config.storagePath
    
    // Ensure directory exists
    const dirname = path.dirname(this.storagePath)
    if (!fs.existsSync(dirname)) {
      fs.mkdirSync(dirname, { recursive: true })
    }

    this.db = new Database(this.storagePath)
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT,
        description TEXT,
        observations TEXT, -- JSON array
        metadata TEXT,     -- JSON object
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        fromEntityId TEXT NOT NULL,
        toEntityId TEXT NOT NULL,
        relationType TEXT NOT NULL,
        description TEXT,
        metadata TEXT,     -- JSON object
        FOREIGN KEY(fromEntityId) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY(toEntityId) REFERENCES entities(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(fromEntityId);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(toEntityId);
    `)
  }

  async initialize(): Promise<void> {
    // Database is initialized in constructor
    console.log(`[SQLiteMemoryAdapter] Initialized at ${this.storagePath}`)
  }

  async shutdown(): Promise<void> {
    this.db.close()
  }

  async createEntity(input: CreateEntityInput): Promise<Entity> {
    const id = input.name // Use name as ID for compatibility with server-memory logic
    const entity: Entity = {
      id,
      name: input.name,
      type: input.type,
      description: input.description,
      observations: input.observations || [],
      metadata: input.metadata || {},
      createdAt: new Date().toISOString()
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entities (id, name, type, description, observations, metadata, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      entity.id,
      entity.name,
      entity.type,
      entity.description,
      JSON.stringify(entity.observations),
      JSON.stringify(entity.metadata),
      entity.createdAt,
      entity.createdAt
    )

    return entity
  }

  async getEntity(id: string): Promise<Entity | null> {
    const stmt = this.db.prepare('SELECT * FROM entities WHERE id = ?')
    const row = stmt.get(id) as EntityRow | undefined
    if (!row) return null

    return this.mapRowToEntity(row)
  }

  async updateEntity(id: string, updates: Partial<Entity>): Promise<Entity> {
    const existing = await this.getEntity(id)
    if (!existing) throw new Error(`Entity not found: ${id}`)

    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() }

    const stmt = this.db.prepare(`
      UPDATE entities 
      SET type = ?, description = ?, observations = ?, metadata = ?, updatedAt = ?
      WHERE id = ?
    `)

    stmt.run(
      updated.type,
      updated.description,
      JSON.stringify(updated.observations),
      JSON.stringify(updated.metadata),
      updated.updatedAt,
      id
    )

    return updated
  }

  async deleteEntity(id: string): Promise<void> {
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(id)
  }

  async listEntities(options?: { limit?: number; offset?: number }): Promise<Entity[]> {
    const limit = options?.limit || 100
    const offset = options?.offset || 0
    const rows = this.db.prepare('SELECT * FROM entities LIMIT ? OFFSET ?').all(limit, offset) as EntityRow[]
    return rows.map(row => this.mapRowToEntity(row))
  }

  async search(query: string, options?: SearchOptions): Promise<Entity[]> {
    const limit = options?.limit || 20
    // Simple LIKE search for now (could upgrade to FTS5 if needed)
    const rows = this.db.prepare(`
      SELECT * FROM entities 
      WHERE name LIKE ? OR description LIKE ? OR observations LIKE ?
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as EntityRow[]
    
    return rows.map(row => this.mapRowToEntity(row))
  }

  async createRelation(input: CreateRelationInput): Promise<Relation> {
    const id = `${input.fromEntityId}-${input.relationType}-${input.toEntityId}`
    const relation: Relation = {
      id,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      relationType: input.relationType,
      description: input.description,
      metadata: input.metadata || {}
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO relations (id, fromEntityId, toEntityId, relationType, description, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      relation.id,
      relation.fromEntityId,
      relation.toEntityId,
      relation.relationType,
      relation.description,
      JSON.stringify(relation.metadata)
    )

    return relation
  }

  async getRelation(id: string): Promise<Relation | null> {
    const row = this.db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as RelationRow | undefined
    if (!row) return null
    return this.mapRowToRelation(row)
  }

  async deleteRelation(id: string): Promise<void> {
    this.db.prepare('DELETE FROM relations WHERE id = ?').run(id)
  }

  async listRelations(entityId: string): Promise<Relation[]> {
    const rows = this.db.prepare(`
      SELECT * FROM relations 
      WHERE fromEntityId = ? OR toEntityId = ?
    `).all(entityId, entityId) as RelationRow[]
    return rows.map(row => this.mapRowToRelation(row))
  }

  async getStats(): Promise<MemoryStats> {
    const entityResult = this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number } | undefined
    const relationResult = this.db.prepare('SELECT COUNT(*) as count FROM relations').get() as { count: number } | undefined
    
    const entityCount = entityResult?.count || 0
    const relationCount = relationResult?.count || 0
    
    let storageSize = 0
    try {
      storageSize = fs.statSync(this.storagePath).size
    } catch {
      // Ignore if file doesn't exist yet
    }

    return {
      entityCount,
      relationCount,
      storageSize,
      avgSearchLatency: 0,
      backend: 'sqlite'
    }
  }

  async exportAll(): Promise<ExportData> {
    const entities = await this.listEntities({ limit: 100000 })
    const relations = await this.db.prepare('SELECT * FROM relations').all() as RelationRow[]
    
    return {
      entities,
      relations: relations.map(r => this.mapRowToRelation(r)),
      metadata: {
        exportedAt: new Date().toISOString(),
        version: '1.0.0',
        backend: 'sqlite'
      }
    }
  }

  async importAll(data: ExportData): Promise<void> {
    const transaction = this.db.transaction((entities: Entity[], relations: Relation[]) => {
      for (const entity of entities) {
        this.db.prepare(`
          INSERT OR REPLACE INTO entities (id, name, type, description, observations, metadata, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entity.id,
          entity.name,
          entity.type,
          entity.description,
          JSON.stringify(entity.observations),
          JSON.stringify(entity.metadata),
          entity.createdAt,
          new Date().toISOString()
        )
      }

      for (const relation of relations) {
        this.db.prepare(`
          INSERT OR REPLACE INTO relations (id, fromEntityId, toEntityId, relationType, description, metadata)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          relation.id,
          relation.fromEntityId,
          relation.toEntityId,
          relation.relationType,
          relation.description,
          JSON.stringify(relation.metadata)
        )
      }
    })

    transaction(data.entities, data.relations)
  }

  listTools(): { tools: any[] } {
    return {
      tools: [
        {
          name: 'create_entities',
          description: 'Create new entities in memory',
          inputSchema: {
            type: 'object',
            properties: {
              entities: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    entityType: { type: 'string' },
                    observations: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          }
        },
        {
          name: 'read_graph',
          description: 'Read the memory graph',
          inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'search_nodes',
            description: 'Search entities by query',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                limit: { type: 'number' }
              }
            }
        }
      ]
    }
  }

  async callTool(name: string, args: any): Promise<{ result: any; error?: string }> {
    try {
      switch (name) {
        case 'create_entities':
          for (const ent of args.entities) {
            await this.createEntity({
              name: ent.name,
              type: ent.entityType || 'entity',
              description: '',
              observations: ent.observations || []
            })
          }
          return { result: [{ type: 'text', text: 'Entities created successfully' }] }
        
        case 'read_graph':
          const data = await this.exportAll()
          return { result: [{ type: 'text', text: JSON.stringify(data) }] }

        case 'search_nodes':
          const results = await this.search(args.query, { limit: args.limit })
          return { result: [{ type: 'text', text: JSON.stringify(results) }] }

        default:
          return { result: null, error: `Tool not found: ${name}` }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { result: null, error: message }
    }
  }

  private mapRowToEntity(row: EntityRow): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      observations: JSON.parse(row.observations || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  private mapRowToRelation(row: RelationRow): Relation {
    return {
      id: row.id,
      fromEntityId: row.fromEntityId,
      toEntityId: row.toEntityId,
      relationType: row.relationType,
      description: row.description,
      metadata: JSON.parse(row.metadata || '{}')
    }
  }
}
