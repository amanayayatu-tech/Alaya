import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, ShieldCheck, LineChart, Library, ListChecks,
  Moon, Sun, Menu, X, Settings, PlusCircle, Activity, BookOpenText,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "./Logo";
import type { Project } from "@/lib/alaya";
import { useLocationParam } from "@/lib/hashLocation";
import { apiRequest, hasApiKey, onApiKeyChange, queryClient, setApiKey } from "@/lib/queryClient";

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
  { href: "/", label: "飞轮总览", sub: "当前状态", icon: LayoutDashboard, testId: "link-nav-dashboard" },
  { href: "/gates", label: "人类闸门", sub: "审批卡点", icon: ShieldCheck, testId: "link-nav-human-gates" },
  { href: "/ledger", label: "审计账本", sub: "追溯记录", icon: LineChart, testId: "link-nav-prediction-ledger" },
  { href: "/knowledge", label: "知识库", sub: "信念治理", icon: Library, testId: "link-nav-knowledge-base" },
  { href: "/review", label: "周期评审", sub: "复利证据", icon: ListChecks, testId: "link-nav-cycle-review" },
  { href: "/health", label: "健康证明", sub: "复利指标", icon: Activity, testId: "link-nav-flywheel-health" },
  { href: "/guide", label: "使用说明", sub: "新手上手", icon: BookOpenText, testId: "link-nav-guide" },
  { href: "/project", label: "项目设置", sub: "红线预算", icon: Settings, testId: "link-nav-project-setup" },
];

export function Layout({ children }: { children: ReactNode }) {
  const { dark, toggle } = useThemeState();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyPresent, setApiKeyPresent] = useState(() => hasApiKey());
  const linkedProjectIdParam = useLocationParam("projectId");
  const legacyProjectIdParam = useLocationParam("project");
  const linkedProjectId = linkedProjectIdParam ?? legacyProjectIdParam;

  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  useEffect(() => {
    return onApiKeyChange(() => {
      setApiKeyPresent(hasApiKey());
      setApiKeyDraft("");
    });
  }, []);

  useEffect(() => {
    if (linkedProjectId && projects.some((project) => project.id === linkedProjectId)) {
      if (projectId !== linkedProjectId) setProjectId(linkedProjectId);
      return;
    }
    if (!projectId && projects.length > 0) setProjectId(projects[0].id);
  }, [linkedProjectId, projects, projectId]);

  const current = projects.find((p) => p.id === projectId);
  const saveApiKey = () => {
    setApiKey(apiKeyDraft);
    setApiKeyPresent(hasApiKey());
    setApiKeyDraft("");
    void queryClient.invalidateQueries();
  };
  const clearApiKey = () => {
    setApiKey("");
    setApiKeyPresent(false);
    setApiKeyDraft("");
    void queryClient.invalidateQueries();
  };

  const Sidebar = (
    <aside className="flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-4">
        <Logo className="h-6 w-6 text-primary shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-none text-sidebar-foreground">Alaya</div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">自进化治理引擎</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {NAV.map((item) => {
          const active = location === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              data-testid={item.testId}
              className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm hover-elevate ${
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate">{item.label}</span>
                <span className="block truncate text-[11px] font-normal text-muted-foreground">{item.sub}</span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3 space-y-2">
        <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Project</div>
        <select
          data-testid="select-project"
          value={projectId ?? ""}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="选择项目"
          className="w-full rounded-md border border-input bg-background px-2 py-2 text-xs text-foreground"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <Link
          href="/projects/new"
          data-testid="link-new-project"
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-2 py-2 text-xs text-foreground hover-elevate"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          新建项目
        </Link>
        <div className="space-y-2 rounded-md border border-border bg-background p-2">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              API Key
            </span>
            <span className={apiKeyPresent ? "text-primary" : "text-muted-foreground"}>
              {apiKeyPresent ? "已设置" : "未设置"}
            </span>
          </div>
          <input
            type="password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder={apiKeyPresent ? "输入新 key 可替换" : "输入 API key"}
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
            data-testid="input-api-key"
            aria-label="API Key"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={saveApiKey}
              disabled={apiKeyDraft.trim().length === 0}
              data-testid="button-save-api-key"
            >
              保存
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearApiKey}
              disabled={!apiKeyPresent && apiKeyDraft.trim().length === 0}
              data-testid="button-clear-api-key"
            >
              清除
            </Button>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="button-theme-toggle"
          onClick={toggle}
          className="w-full gap-2"
        >
          {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {dark ? "浅色模式" : "深色模式"}
        </Button>
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
          <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden rounded-md p-1.5 hover-elevate"
              onClick={() => setMobileOpen((o) => !o)}
              data-testid="button-mobile-menu"
              aria-label="打开导航"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate" data-testid="text-current-project">
                {current?.name ?? "还没有项目"}
              </div>
              {current && (
                <div className="truncate text-[11px] text-muted-foreground">{current.direction}</div>
              )}
            </div>
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-mono text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" /> 本地优先
            </span>
          </header>

          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">{children}</div>
          </main>
        </div>
      </div>
    </ProjectContext.Provider>
  );
}

// re-export for convenience
export { apiRequest };
