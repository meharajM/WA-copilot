import { ExecutionPlan } from "./agent-protocol";
import electron from "./electron";
import { getBrowserAgentdClient } from './browser-agentd-client';
import { isTauriRuntime } from './tauri-native-bridge';

/**
 * Syncs the internal ExecutionPlan to a JSON file 
 * in the user's workspace under `.aica/tasks.json`.
 * 
 * Bypasses Safe Mode so the user isn't prompted for every step.
 */
export async function syncPlanToFile(workspacePath: string | undefined, plan: ExecutionPlan | null, sessionId?: string): Promise<void> {
    if (!plan) return;

    try {
        if (typeof window !== 'undefined' && !window.electron && !isTauriRuntime()) {
            const browserSessionId = sessionId || (workspacePath?.startsWith('browser://session/') ? workspacePath.slice('browser://session/'.length) : undefined);
            if (browserSessionId) {
                await getBrowserAgentdClient().appendMessage(browserSessionId, {
                    id: `execution-plan-${Date.now()}`,
                    role: 'system',
                    content: 'Execution plan checkpoint',
                    timestamp: Date.now(),
                    metadata: { executionPlan: plan },
                });
            }
            return;
        }
        if (!workspacePath) return;
        await electron.fs.writeInternalFile(workspacePath, 'tasks.json', JSON.stringify(plan, null, 2));
    } catch (e) {
        console.warn('[TaskManager] Failed to sync tasks.json to workspace:', e);
    }
}

export async function recoverPlan(workspacePath: string | undefined, sessionId?: string): Promise<ExecutionPlan | null> {
    if (typeof window !== 'undefined' && !window.electron && !isTauriRuntime()) {
        const browserSessionId = sessionId || (workspacePath?.startsWith('browser://session/') ? workspacePath.slice('browser://session/'.length) : undefined);
        if (!browserSessionId) return null;
        const session = (await getBrowserAgentdClient().loadSessions()).find(item => item.id === browserSessionId);
        const plans = session?.messages.map(message => message.metadata?.executionPlan).filter(Boolean) || [];
        return (plans.at(-1) as ExecutionPlan | undefined) || null;
    }
    if (!workspacePath) return null;
    try {
        const result = await electron.fs.readInternalFile(workspacePath, 'tasks.json');
        return result.success && result.content ? JSON.parse(result.content) as ExecutionPlan : null;
    } catch { return null; }
}
