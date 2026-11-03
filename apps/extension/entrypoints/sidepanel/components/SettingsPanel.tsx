import { X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import type { useAIProfiles } from '../features/ai-profiles/hooks';
import { ProfileModals } from '../features/ai-profiles/ProfileModals';
import { ProfilesSection } from '../features/ai-profiles/ProfilesSection';
import type { useCandidate } from '../features/candidate/hooks';
import { CandidateSection } from '../features/candidate/CandidateSection';
import type { ServerSettings } from '../features/server/errors';
import { ServerSection } from '../features/server/ServerSection';

export function SettingsPanel({
  server,
  onUpdateServer,
  ai,
  cand,
  onClose,
  closing,
}: {
  server: ServerSettings;
  onUpdateServer: (patch: Partial<ServerSettings>) => void;
  ai: ReturnType<typeof useAIProfiles>;
  cand: ReturnType<typeof useCandidate>;
  onClose: () => void;
  closing?: boolean;
}) {
  return (
    <div
      className="relative flex h-screen flex-col overflow-hidden bg-bg"
      style={{ animation: closing ? 'ai-slide-out-right 180ms ease-out forwards' : 'ai-slide-in-right 180ms ease-out' }}
    >
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg px-4">
        <div className="min-w-0">
          <h2 className="truncate text-ui-lg font-semibold leading-tight text-foreground">设置</h2>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-scroll px-4 py-4">
        <div className="space-y-4">
          <ServerSection server={server} onUpdate={onUpdateServer} />

          <ProfilesSection ai={ai} />

          <CandidateSection cand={cand} />

        </div>
      </div>

      <ProfileModals ai={ai} />
    </div>
  );
}
