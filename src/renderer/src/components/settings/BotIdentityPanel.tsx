import React from 'react';
import { usePersonaStore } from '../../stores/personaStore';
import { Card } from '../primitives/Card';
import { Save, UserCircle, Building2, MessageSquare, Info } from 'lucide-react';

export function BotIdentityPanel() {
    const { profile, updateProfile, isLoading } = usePersonaStore();
    const [localProfile, setLocalProfile] = React.useState(profile);
    const [isSaving, setIsSaving] = React.useState(false);

    // Sync local state when global profile loads/changes
    React.useEffect(() => {
        if (profile) {
            setLocalProfile(profile);
        }
    }, [profile]);

    const handleSave = async () => {
        if (!localProfile) return;
        setIsSaving(true);
        await updateProfile({
            name: localProfile.name,
            industry: localProfile.industry,
            tone: localProfile.tone,
            customRules: localProfile.customRules
        });
        setIsSaving(false);
    };

    if (isLoading && !localProfile) {
        return <div className="animate-pulse flex space-x-4"><div className="flex-1 space-y-4 py-1"><div className="h-4 bg-gray-600 rounded w-3/4"></div></div></div>;
    }

    if (!localProfile) return null;

    return (
        <div className="space-y-6">
            <div className="bg-[var(--color-brand-teal)]/10 border border-[var(--color-brand-teal)]/30 rounded-xl p-4 flex gap-3">
                <Info size={18} className="text-[var(--color-brand-teal)] shrink-0 mt-0.5" />
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                    <strong>Safe System Prompt Control:</strong> Configure how the AI presents itself to users. 
                    These settings are dynamically injected into the core system prompt, ensuring the AI maintains its base instructions (like tool usage and formatting protocols) while adapting to your brand.
                </p>
            </div>

            <Card variant="glass" padding="md" className="space-y-5">
                <div>
                    <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2 flex items-center gap-2">
                        <UserCircle size={16} className="text-[var(--color-text-muted)]" />
                        Agent Name
                    </label>
                    <input
                        type="text"
                        value={localProfile.name || ''}
                        onChange={(e) => setLocalProfile({ ...localProfile, name: e.target.value })}
                        className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
                        placeholder="e.g. SupportBot, Sarah, AIConsumerAgent"
                    />
                    <p className="text-xs text-[var(--color-text-dim)] mt-1">The name the bot uses to introduce itself.</p>
                </div>

                <div>
                    <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2 flex items-center gap-2">
                        <Building2 size={16} className="text-[var(--color-text-muted)]" />
                        Company / Industry
                    </label>
                    <input
                        type="text"
                        value={localProfile.industry || ''}
                        onChange={(e) => setLocalProfile({ ...localProfile, industry: e.target.value })}
                        className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
                        placeholder="e.g. Tech Startup, E-commerce Store, Local Bakery"
                    />
                    <p className="text-xs text-[var(--color-text-dim)] mt-1">Helps the bot understand the context of its products/services.</p>
                </div>

                <div>
                    <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2 flex items-center gap-2">
                        <MessageSquare size={16} className="text-[var(--color-text-muted)]" />
                        Conversational Tone
                    </label>
                    <select
                        value={localProfile.tone || 'professional'}
                        onChange={(e) => setLocalProfile({ ...localProfile, tone: e.target.value as NonNullable<typeof localProfile.tone> })}
                        className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors appearance-none"
                    >
                        <option value="professional">Professional (Polite, structured, formal)</option>
                        <option value="casual">Casual (Friendly, relaxed, approachable)</option>
                        <option value="enthusiastic">Enthusiastic (High energy, uses emojis, upbeat)</option>
                        <option value="concise">Concise (Extremely brief, cuts straight to the point)</option>
                    </select>
                </div>

                <div className="pt-2">
                    <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">
                        Custom Business Rules (Optional)
                    </label>
                    <textarea
                        value={localProfile.customRules || ''}
                        onChange={(e) => setLocalProfile({ ...localProfile, customRules: e.target.value })}
                        placeholder="e.g. 'Never promise a refund. Always end the conversation by asking if there's anything else you can help with.'"
                        className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-3 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors min-h-[120px] resize-y placeholder:text-[var(--color-text-dim)]"
                    />
                    <p className="text-xs text-[var(--color-text-muted)] mt-2">
                        These instructions are appended directly to the bot's system prompt. Keep them brief and strictly related to business operations.
                    </p>
                </div>

                <div className="pt-4 border-t border-[var(--color-border)] flex justify-end">
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="flex items-center gap-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary)]/90 text-white px-6 py-2 rounded-lg font-bold text-sm transition-all shadow-md shadow-[var(--color-primary)]/20 disabled:opacity-50"
                    >
                        <Save size={16} />
                        {isSaving ? 'Saving...' : 'Save Identity'}
                    </button>
                </div>
            </Card>
        </div>
    );
}
