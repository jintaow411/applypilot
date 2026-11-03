import { Trash2, X } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Select } from '../../../../components/ui/select';
import { AI_PROTOCOLS, type AIProtocol } from '../../../../lib/ai';
import { Modal } from '../../components/Modal';
import { SettingField } from '../../components/SettingField';
import type { useAIProfiles } from './hooks';

export function ProfileModals({ ai }: { ai: ReturnType<typeof useAIProfiles> }) {
  return (
    <>
      {ai.editingProfile ? (
        <Modal
          title={ai.isNewProfile ? '新增 AI 配置' : '编辑 AI 配置'}
          onClose={() => ai.setEditingProfile(null)}
          footer={
            <>
              {!ai.isNewProfile ? (
                <Button
                  variant="ghost"
                  className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void ai.handleDeleteProfileInModal()}
                  title="删除配置"
                  aria-label="删除配置"
                >
                  <Trash2 />
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1"
                onClick={() => ai.setEditingProfile(null)}
              >
                取消
              </Button>
              <Button size="sm" className="h-8 flex-1" onClick={() => void ai.saveProfileModal()}>
                保存
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <SettingField label="Base URL" hint="名称自动取 host">
              <Input
                value={ai.editingProfile.baseUrl}
                onChange={(event) =>
                  ai.setEditingProfile({ ...ai.editingProfile!, baseUrl: event.target.value })
                }
                placeholder="https://api.example.com/v1"
                spellCheck={false}
              />
            </SettingField>
            <SettingField label="协议">
              <Select
                value={ai.editingProfile.protocol}
                onChange={(event) =>
                  ai.setEditingProfile({
                    ...ai.editingProfile!,
                    protocol: event.target.value as AIProtocol,
                  })
                }
              >
                {AI_PROTOCOLS.map((protocol) => (
                  <option key={protocol.value} value={protocol.value}>
                    {protocol.label}
                  </option>
                ))}
              </Select>
            </SettingField>
            <SettingField label="模型 id" hint="保存后进入模型列表">
              <Input
                value={ai.editingProfile.model}
                onChange={(event) =>
                  ai.setEditingProfile({ ...ai.editingProfile!, model: event.target.value })
                }
                placeholder="模型 id"
                spellCheck={false}
              />
            </SettingField>
            <SettingField label="API Key" hint="仅存本地">
              <Input
                type="password"
                value={ai.editingProfile.apiKey}
                onChange={(event) =>
                  ai.setEditingProfile({ ...ai.editingProfile!, apiKey: event.target.value })
                }
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
              />
            </SettingField>
          </div>
        </Modal>
      ) : null}

      {ai.modelModalOpen && ai.activeProfile ? (
        <Modal
          title="添加模型"
          onClose={() => ai.setModelModalOpen(false)}
          footer={
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1"
                onClick={() => ai.setModelModalOpen(false)}
              >
                取消
              </Button>
              <Button size="sm" className="h-8 flex-1" onClick={() => void ai.saveModelModal()}>
                保存
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            {ai.activeProfile.models.length ? (
              <div>
                <div className="mb-1.5 text-ui-sm font-medium text-foreground">模型列表</div>
                <div className="space-y-1.5">
                  {ai.activeProfile.models.map((model) => (
                    <div
                      key={model}
                      className="flex min-h-8 items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground">
                        {model}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0"
                        onClick={() => void ai.removeProfileModel(model)}
                        title="移除"
                        aria-label="移除"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <SettingField label="模型 id">
              <Input
                value={ai.modelInput}
                onChange={(event) => ai.setModelInput(event.target.value)}
                placeholder="模型 id"
                spellCheck={false}
              />
            </SettingField>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
