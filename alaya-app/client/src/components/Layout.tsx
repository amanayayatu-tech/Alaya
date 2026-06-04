import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, ShieldCheck, LineChart, Library, ListChecks,
  Moon, Sun, Menu, X, Settings, PlusCircle,
} from "lucide-react";
import { Logo } from "./Logo";
import type { Project } from "@/lib/alaya";
import { apiRequest } from "@/lib/queryClient";

// ---------- theme ----------
function useThemeState() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

// ---------- project context ----------
interface ProjectCtx { projectId: string | null; setProjectId: (id: string) => void; projects: Project[]; }
const ProjectContext = createContext<ProjectCtx>({ projectId: null, setProjectId: () => {}, projects: [] });
export const useProject = () => useContext(ProjectContext);

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/gates", label: "Human Gates", icon: ShieldCheck },
  { href: "/ledger", label: "Prediction Ledger", icon: LineChart },
  { href: "/knowledge", label: "Knowledge Base", icon: Library },
  { href: "/review", label: "Cycle Review", icon: ListChecks },
  { href: "/project", label: "Project Setup", icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const { dark, toggle } = useThemeState();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);

  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const current = projects.find((p) => p.id === projectId);

  const Sidebar = (
    <aside className="flex h-full w-60 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-sidebar-border">
        <Logo className="h-6 w-6 text-primary shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-none text-sidebar-foreground">Alaya</div>
          <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">flywheel console</div>
        </div>
      </div>

      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const active = location === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover-elevate ${
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono px-1">Project</div>
        <select
          data-testid="select-project"
          value={projectId ?? ""}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground font-mono"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <Link
          href="/projects/new"
          data-testid="link-new-project"
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground hover-elevate"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          New Project
        </Link>
        <button
          data-testid="button-theme-toggle"
          onClick={toggle}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground hover-elevate"
        >
          {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {dark ? "Light" : "Dark"} mode
        </button>
      </div>
    </aside>
  );

  return (
    <ProjectContext.Provider value={{ projectId, setProjectId, projects }}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        {/* desktop sidebar */}
        <div className="hidden md:block shrink-0">{Sidebar}</div>

        {/* mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
            <div className="absolute left-0 top-0 h-full">{Sidebar}</div>
          </div>
        )}

        <div className="flex flex-1 flex-col min-w-0">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <button
              className="md:hidden rounded-md p-1.5 hover-elevate"
              onClick={() => setMobileOpen((o) => !o)}
              data-testid="button-mobile-menu"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate" data-testid="text-current-project">
                {current?.name ?? "No project"}
              </div>
              {current && (
                <div className="text-[11px] text-muted-foreground font-mono truncate">{current.direction}</div>
              )}
            </div>
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-mono text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" /> local MVP
            </span>
          </header>

          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">{children}</div>
          </main>
        </div>
      </div>
    </ProjectContext.Provider>
  );
}

// re-export for convenience
export { apiRequest };
