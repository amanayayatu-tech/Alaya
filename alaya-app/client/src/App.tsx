import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Gates from "@/pages/Gates";
import Ledger from "@/pages/Ledger";
import Knowledge from "@/pages/Knowledge";
import Review from "@/pages/Review";
import NewProject from "@/pages/NewProject";
import ProjectSetup from "@/pages/ProjectSetup";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/gates" component={Gates} />
      <Route path="/ledger" component={Ledger} />
      <Route path="/knowledge" component={Knowledge} />
      <Route path="/review" component={Review} />
      <Route path="/project" component={ProjectSetup} />
      <Route path="/projects/new" component={NewProject} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <Layout>
            <AppRouter />
          </Layout>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
