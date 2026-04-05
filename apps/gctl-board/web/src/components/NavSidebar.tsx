import type { Route } from "../hooks/useRoute"

interface NavSidebarProps {
  route: Route
  navigate: (path: string) => void
  unreadCount: number
}

function BoardIcon({ active }: { active: boolean }) {
  const color = active ? "text-emerald-400" : "text-zinc-500"
  return (
    <svg
      className={`w-5 h-5 ${color} transition-colors duration-150`}
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      {/* 2x2 grid icon */}
      <rect x="2" y="2" width="7" height="7" rx="1.5" />
      <rect x="11" y="2" width="7" height="7" rx="1.5" />
      <rect x="2" y="11" width="7" height="7" rx="1.5" />
      <rect x="11" y="11" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function InboxIcon({ active }: { active: boolean }) {
  const color = active ? "text-emerald-400" : "text-zinc-500"
  return (
    <svg
      className={`w-5 h-5 ${color} transition-colors duration-150`}
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      {/* Envelope icon */}
      <path d="M2 5a2 2 0 012-2h12a2 2 0 012 2v1.2l-8 4.8-8-4.8V5z" />
      <path d="M2 8.2l8 4.8 8-4.8V15a2 2 0 01-2 2H4a2 2 0 01-2-2V8.2z" />
    </svg>
  )
}

function GctlMark() {
  return (
    <div className="flex items-center justify-center">
      <svg className="w-6 h-6 text-zinc-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v18M3 12h18" strokeOpacity="0.4" />
        <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.6" stroke="none" />
      </svg>
    </div>
  )
}

export function NavSidebar({ route, navigate, unreadCount }: NavSidebarProps) {
  const isBoardActive = route.page === "board"
  const isInboxActive = route.page === "inbox"

  return (
    <nav className="w-14 min-h-screen bg-zinc-950 border-r border-zinc-800 flex flex-col items-center py-4 gap-1 shrink-0">
      {/* Board nav item */}
      <button
        onClick={() => navigate("/")}
        className={`w-10 h-10 flex items-center justify-center rounded-md transition-all duration-150 cursor-pointer
          ${isBoardActive ? "bg-emerald-500/10" : "hover:bg-zinc-800/60"}`}
        title="Board"
      >
        <BoardIcon active={isBoardActive} />
      </button>

      {/* Inbox nav item */}
      <button
        onClick={() => navigate("/inbox")}
        className={`w-10 h-10 flex items-center justify-center rounded-md transition-all duration-150 cursor-pointer relative
          ${isInboxActive ? "bg-emerald-500/10" : "hover:bg-zinc-800/60"}`}
        title="Inbox"
      >
        <InboxIcon active={isInboxActive} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-emerald-500 text-zinc-950 text-[10px] font-mono font-bold leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Logo mark at bottom */}
      <GctlMark />
    </nav>
  )
}
