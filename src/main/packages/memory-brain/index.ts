import { MigrationService } from '../../services/memory/MigrationService'
import { MetricsCollector } from '../../services/memory/MetricsCollector'

/**
 * @copilot/memory-brain
 * 
 * Modular knowledge graph and long-term memory engine.
 * Extracted from MemoryService.
 */
export class MemoryBrain {
    private static instance: MemoryBrain
    public metricsCollector = new MetricsCollector()
    public migrationService = new MigrationService()

    private constructor() {
        // Initialization logic for memory adapters
    }

    static getInstance(): MemoryBrain {
        if (!MemoryBrain.instance) {
            MemoryBrain.instance = new MemoryBrain()
        }
        return MemoryBrain.instance
    }

    // High-level methods for entity creation, updates, and searching
    // Wrapper around the UnifiedMemoryBackend
}
