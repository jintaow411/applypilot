import { Loader2, Sparkles, Upload, WandSparkles } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import type { BusyState } from '../features/schema/types';

export function FooterBar({
  busy,
  loading,
  generating,
  canGenerate,
  canFill,
  onGenerate,
  onFill,
  onReport,
}: {
  busy: BusyState;
  loading: boolean;
  generating: boolean;
  canGenerate: boolean;
  canFill: boolean;
  onGenerate: () => void;
  onFill: () => void;
  onReport: () => void;
}) {
  const disabled = Boolean(busy) || loading;
  return (
    <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-3 pt-2.5 pb-[calc(10px_+_env(safe-area-inset-bottom))] backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="outline"
          className="h-8 min-w-0 flex-1 disabled:opacity-60"
          onClick={onGenerate}
          disabled={disabled || generating || !canGenerate}
          title="调用 AI 识别可填项"
        >
          {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
          <span className="truncate">一键生成</span>
        </Button>
        <Button
          className="h-8 min-w-0 flex-1 disabled:opacity-60"
          onClick={onFill}
          disabled={disabled || generating || !canFill}
        >
          {busy === 'fill' ? <Loader2 className="animate-spin" /> : <WandSparkles />}
          <span className="truncate">一键填入</span>
        </Button>
        <Tooltip className="shrink-0">
          <TooltipTrigger>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0 disabled:opacity-60"
              onClick={onReport}
              disabled={disabled || generating}
              aria-label="上报当前页"
            >
              {busy === 'report' ? <Loader2 className="animate-spin" /> : <Upload />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="right-0 left-auto translate-x-2">
            上报当前页
          </TooltipContent>
        </Tooltip>
      </div>
    </footer>
  );
}
