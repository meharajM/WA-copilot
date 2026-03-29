import { useState } from 'react'
import { X } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'

interface AuthModalProps {
    isOpen: boolean
    onClose: () => void
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
    const auth = useAuthStore()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [name, setName] = useState('')
    const [isSignUp, setIsSignUp] = useState(false)
    const [localError, setLocalError] = useState<string | null>(null)

    if (!isOpen) return null

    const submit = async () => {
        setLocalError(null)
        try {
            if (isSignUp) {
                await auth.signUpWithEmail(email.trim(), password, name.trim())
            } else {
                await auth.signInWithEmail(email.trim(), password)
            }
            onClose()
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : 'Authentication failed')
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-card-elevated)] p-5">
                <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-bold text-[var(--color-text-primary)]">
                        {isSignUp ? 'Create Account' : 'Sign In'}
                    </h4>
                    <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                        <X size={16} />
                    </button>
                </div>

                <div className="space-y-3">
                    {isSignUp && (
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Name"
                            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] px-3 py-2 text-sm"
                        />
                    )}
                    <input
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Email"
                        type="email"
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] px-3 py-2 text-sm"
                    />
                    <input
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        type="password"
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] px-3 py-2 text-sm"
                    />
                    {(localError || auth.error) && (
                        <p className="text-xs text-[var(--color-error)]">{localError || auth.error}</p>
                    )}
                    <button
                        onClick={submit}
                        disabled={auth.loading || !email || !password || (isSignUp && !name)}
                        className="w-full rounded-lg bg-[var(--color-brand-teal)] text-white py-2 text-sm font-medium disabled:opacity-60"
                    >
                        {auth.loading ? 'Please wait...' : (isSignUp ? 'Create Account' : 'Sign In')}
                    </button>
                    <button
                        onClick={() => setIsSignUp((v) => !v)}
                        className="w-full text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    >
                        {isSignUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
                    </button>
                </div>
            </div>
        </div>
    )
}
