import * as React from 'react';
import { Activity, Bot, ChevronDown, Loader2, Pencil, Plus } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Select } from '../../../../components/ui/select';
import { toast } from '../../../../components/ui/toast';
import { cn } from '../../../../components/ui/utils';
import { testAIConnection, type AIProfile } from '../../../../lib/ai';
import { errorText } from '../server/errors';
import type { useAIProfiles } from './hooks';
import { profileLabel } from './helpers';

export function ProfilesSection({ ai }: { ai: ReturnType<typeof useAIProfiles> }) {
  // 维护每个供应商卡片的折叠状态，默认全部关闭
  const [expandedIds, setExpandedIds] = React.useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSelect = (id: string) => {
    void ai.handleSelectProfile(id);
  };

  const [testingId, setTestingId] = React.useState<string | null>(null);

  const handleTestConnection = async (profile: AIProfile) => {
    if (testingId) return;
    setTestingId(profile.id);
    try {
      const { latencyMs } = await testAIConnection(profile);
      toast.success(`连接成功（${profile.model || '模型'} · ${latencyMs}ms）`);
    } catch (error) {
      toast.error(`连接失败：${errorText(error)}`);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
          <h3 className="truncate text-ui-sm font-semibold tracking-wide text-foreground">AI 配置</h3>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          onClick={() => ai.openProfileModal(null)}
        >
          <Plus />
          新增
        </Button>
      </div>

      <div className="space-y-2">
        {ai.profilesState.profiles.map((profile) => {
          const selected = profile.id === ai.profilesState.activeId;
          const expanded = Boolean(expandedIds[profile.id]);
          return (
            <div
              key={profile.id}
              className={cn(
                'overflow-hidden rounded-lg border transition-colors',
                selected
                  ? 'border-brand/50 bg-brand/5'
                  : 'border-border bg-surface hover:border-border-hover',
              )}
            >
              {/* 头部：左侧点击展开/折叠，中间点击选中，右侧编辑 */}
              <div className="flex h-10 items-center gap-1.5 px-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(profile.id);
                  }}
                  aria-expanded={expanded}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
                  title={expanded ? '折叠模型配置' : '展开模型配置'}
                  aria-label={expanded ? '折叠模型配置' : '展开模型配置'}
                >
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 shrink-0 transition-transform duration-200',
                      !expanded && '-rotate-90',
                    )}
                  />
                </button>

                <button
                  type="button"
                  onClick={() => handleSelect(profile.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
                  title={selected ? '当前生效的配置' : '点击切换为当前配置'}
                >
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full transition-colors',
                      selected ? 'bg-brand' : 'bg-foreground-subtlest/60',
                    )}
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground"
                    title={profileLabel(profile)}
                  >
                    {profileLabel(profile)}
                  </span>
                  {selected ? (
                    <span className="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-ui-xs font-medium text-brand">
                      使用中
                    </span>
                  ) : null}
                </button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleTestConnection(profile);
                  }}
                  disabled={testingId === profile.id}
                  title="测试模型连接"
                  aria-label="测试模型连接"
                >
                  {testingId === profile.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
                  ) : (
                    <Activity className="h-3.5 w-3.5" />
                  )}
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    ai.openProfileModal(profile);
                  }}
                  title="编辑配置"
                  aria-label="编辑配置"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* 展开区：内嵌模型选择与添加模型按钮 */}
              {expanded ? (
                <div className="border-t border-border/60 bg-background/50 p-3 space-y-2.5">
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      <Select
                        value={profile.models.includes(profile.model) ? profile.model : ''}
                        onChange={(event) => void ai.handleSelectModel(event.target.value, profile.id)}
                        title="模型 id（切换即保存）"
                      >
                        <option value="">
                          {profile.models.length ? '选择模型…' : '暂无模型，请先添加'}
                        </option>
                        {profile.models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button
                      variant="outline"
                      className="shrink-0"
                      onClick={() => {
                        void ai.handleSelectProfile(profile.id);
                        ai.setModelInput('');
                        ai.setModelModalOpen(true);
                      }}
                    >
                      <Plus />
                      添加模型
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {ai.profilesState.profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-ui-xs text-foreground-subtle">
            还没有 AI 配置，点「新增」创建。
          </p>
        ) : null}
      </div>
    </section>
  );
}
