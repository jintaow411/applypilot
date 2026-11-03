import { Server } from 'lucide-react';
import { Input } from '../../../../components/ui/input';
import { SettingField } from '../../components/SettingField';
import type { ServerSettings } from './errors';

export function ServerSection({
  server,
  onUpdate,
}: {
  server: ServerSettings;
  onUpdate: (patch: Partial<ServerSettings>) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Server className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
        <h3 className="truncate text-ui-sm font-semibold tracking-wide text-foreground">本地服务</h3>
      </div>

      <div className="space-y-3">
        <SettingField label="服务地址">
          <Input
            value={server.baseUrl}
            onChange={(event) => onUpdate({ baseUrl: event.target.value })}
            placeholder="http://127.0.0.1:17880"
            spellCheck={false}
          />
        </SettingField>

        <SettingField label="配对 Token">
          <Input
            type="password"
            value={server.token}
            onChange={(event) => onUpdate({ token: event.target.value })}
            placeholder="服务端启动时打印的随机串"
            spellCheck={false}
            autoComplete="off"
          />
        </SettingField>
      </div>
    </section>
  );
}
