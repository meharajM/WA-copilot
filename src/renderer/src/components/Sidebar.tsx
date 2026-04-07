import React from 'react'
import { SidebarHeader } from './sidebar/SidebarHeader'
import { RecentSessionsList } from './sidebar/RecentSessionsList'
import { SidebarFooter } from './sidebar/SidebarFooter'
import { useChatStore } from '../stores/chatStore'
import { MessageSquare, Brain, Users, LayoutDashboard, Mail } from 'lucide-react'
import { clsx } from "clsx"

export type ViewMode = 'chat' | 'brain' | 'leads' | 'dashboard' | 'settings' | 'connections' | 'identity' | 'drafts'

interface SidebarProps {
  activeView: ViewMode
  onViewChange: (view: ViewMode) => void
}

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  const { sidebarOpen } = useChatStore()

  if (!sidebarOpen) return null

  return (
    <div className="w-64 flex-shrink-0 bg-[var(--color-card-dark)] hidden md:flex flex-col h-full border-r border-[var(--color-border)] transition-all duration-[var(--duration-normal)]">
      {/* 1. Header with Logo */}
      <SidebarHeader />

      {/* 2. Scrollable Body containing Agents & Sessions */}
      <div className="flex-1 overflow-y-auto py-2 px-3 space-y-6">
        {/* Core Views */}
        <div className="space-y-1">
          <button 
            onClick={() => onViewChange('dashboard')}
            className={clsx(
              "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors",
              activeView === 'dashboard' ? "bg-white/10 text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
            )}
          >
            <LayoutDashboard className="w-4 h-4" />
            <span>Command Center</span>
          </button>
          <button 
            onClick={() => onViewChange('chat')}
            className={clsx(
              "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors",
              activeView === 'chat' ? "bg-white/10 text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
            )}
          >
            <MessageSquare className="w-4 h-4" />
            <span>All Chats</span>
          </button>
          <button 
            onClick={() => onViewChange('brain')}
            className={clsx(
              "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors",
              activeView === 'brain' ? "bg-white/10 text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
            )}
          >
            <Brain className="w-4 h-4" />
            <span>Brain View</span>
          </button>
          <button 
            onClick={() => onViewChange('leads')}
            className={clsx(
              "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors",
              activeView === 'leads' ? "bg-white/10 text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
            )}
          >
            <Users className="w-4 h-4" />
            <span>Lead Directory</span>
          </button>
          <button 
            onClick={() => onViewChange('drafts')}
            className={clsx(
              "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors",
              activeView === 'drafts' ? "bg-white/10 text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
            )}
          >
            <Mail className="w-4 h-4" />
            <span>Email Drafts</span>
          </button>
        </div>

        {/* Divider */}
        <div className="mx-2 border-t border-[var(--color-border)]" />

        <RecentSessionsList onViewChange={onViewChange} />
      </div>

      {/* 3. Footer with quick settings link */}
      <SidebarFooter currentView={activeView} onViewChange={onViewChange} />
    </div>
  )
}
