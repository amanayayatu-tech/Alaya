import { Link } from "wouter";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { EmptyState, PageShell } from "@/components/AppPrimitives";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <PageShell
      title="页面不存在"
      eyebrow="404"
      description="当前路由没有对应的 Alaya 工作台页面。"
      className="pb-8"
    >
      <EmptyState
        title="找不到这个页面"
        description="回到飞轮总览继续查看当前项目状态。"
        action={
          <Button asChild className="gap-2">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              返回总览
            </Link>
          </Button>
        }
      />
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        <span>Hash 路由仍由现有 wouter 配置处理。</span>
      </div>
    </PageShell>
  );
}
