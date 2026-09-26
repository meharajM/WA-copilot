import { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { Users, Search, MessageCircle, Phone, Clock, Filter, ChevronRight, Mail, Hash, MessageSquare } from 'lucide-react'
import { clsx } from 'clsx'

interface LeadDirectoryProps {
    onOpenChat?: () => void
}

export function LeadDirectory({ onOpenChat }: LeadDirectoryProps) {
    const { sessions, setActiveSession } = useChatStore()
    const [search, setSearch] = useState('')

    const openLead = (id: string) => {
        setActiveSession(id)
        onOpenChat?.()
    }

    // Only show sessions linked to an omnichannel contact
    const leads = sessions.filter(s => !!s.contact_id || !!s.whatsapp_jid)
    
    const filteredLeads = leads.filter(l => {
        const identifier = l.contact_id || l.whatsapp_jid || ''
        return l.title.toLowerCase().includes(search.toLowerCase()) || 
               identifier.includes(search)
    })
    
    const getChannelIcon = (channel?: string) => {
        switch (channel) {
            case 'email': return <Mail className="w-3 h-3" />
            case 'telegram': return <MessageSquare className="w-3 h-3" />
            case 'instagram': return <Hash className="w-3 h-3" />
            case 'whatsapp':
            default: return <Phone className="w-3 h-3" />
        }
    }

    return (
        <div className="flex-1 flex flex-col h-full bg-[#0f1115] text-white">
            {/* Header */}
            <header className="p-8 border-b border-white/5 space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-green-500/20 flex items-center justify-center border border-green-500/20">
                            <Users className="w-6 h-6 text-green-400" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold">Lead Directory</h1>
                            <p className="text-gray-400 text-sm">Real-time CRM-lite for your WhatsApp customer interactions.</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button className="p-2 rounded-xl bg-white/5 border border-white/10 text-gray-400 hover:text-white transition-colors">
                            <Filter className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Search Bar */}
                <div className="relative max-w-xl">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input 
                        type="text"
                        placeholder="Search leads by name or number..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-12 pr-4 focus:outline-none focus:ring-2 focus:ring-green-500/50 transition-all"
                    />
                </div>
            </header>

            {/* Content */}
            <main className="flex-1 overflow-y-auto">
                {filteredLeads.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-center space-y-4">
                        <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center border border-white/10 mb-2">
                            <MessageCircle className="w-8 h-8 text-gray-600" />
                        </div>
                        <h3 className="text-lg font-bold text-gray-400">No Leads Found</h3>
                        <p className="text-gray-500 text-sm max-w-xs">WhatsApp contacts will appear here as soon as they message your bot.</p>
                    </div>
                ) : (
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-white/5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                                <th className="px-8 py-4">Customer</th>
                                <th className="px-4 py-4">Contact ID & Channel</th>
                                <th className="px-4 py-4">Last Active</th>
                                <th className="px-4 py-4">Status</th>
                                <th className="px-4 py-4">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredLeads.map((lead) => (
                                <tr 
                                    key={lead.id}
                                    onClick={() => openLead(lead.id)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault()
                                            openLead(lead.id)
                                        }
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    className="group border-b border-white/5 hover:bg-white/[0.02] cursor-pointer transition-colors"
                                >
                                    <td className="px-8 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-green-500/20 to-blue-500/20 border border-white/10 flex items-center justify-center font-bold text-green-400">
                                                {lead.title.charAt(0)}
                                            </div>
                                            <div>
                                                <div className="font-bold text-gray-200">{lead.title}</div>
                                                <div className="text-[10px] text-gray-500 font-medium">Auto-extracted Lead</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-4 py-4">
                                        <div className="flex flex-col gap-1 text-sm text-gray-400 font-mono">
                                            <div className="flex items-center gap-2">
                                                {getChannelIcon(lead.channel)}
                                                {lead.contact_id?.split('@')[0] || lead.whatsapp_jid?.split('@')[0]}
                                            </div>
                                            {lead.channel && (
                                                <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">
                                                    {lead.channel}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-4">
                                        <div className="flex items-center gap-2 text-sm text-gray-400">
                                            <Clock className="w-3 h-3" />
                                            {new Date(lead.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </td>
                                    <td className="px-4 py-4">
                                        <span className={clsx(
                                            "text-[10px] font-bold px-2 py-1 rounded-md",
                                            lead.status === 'resolved' ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-500"
                                        )}>
                                            {lead.status?.toUpperCase() || 'ACTIVE'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-4">
                                        <button className="p-2 rounded-lg bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/10">
                                            <ChevronRight className="w-4 h-4 text-gray-400" />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </main>
        </div>
    )
}
