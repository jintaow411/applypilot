import * as React from 'react';
import {
  activeProfileOf,
  createAIProfile,
  defaultProfilesState,
  hostOfUrl,
  loadAIProfiles,
  normalizeAIBaseUrl,
  saveAIProfiles,
  type AIProfile,
  type AIProfilesState,
} from '../../../../lib/ai';
import { toast } from '../../../../components/ui/toast';
import { errorText } from '../server/errors';
import { profileLabel } from './helpers';

/** AI 配置：弹窗新增/编辑，行内切换/选模型；保存结果统一走全局 toast */
export function useAIProfiles() {
  const [profilesState, setProfilesState] = React.useState<AIProfilesState>(() => defaultProfilesState());

  /** 新增/编辑 AI 配置的弹窗草稿（null = 关闭） */
  const [editingProfile, setEditingProfile] = React.useState<AIProfile | null>(null);
  const [isNewProfile, setIsNewProfile] = React.useState(false);
  /** 添加模型 id 的弹窗 */
  const [modelModalOpen, setModelModalOpen] = React.useState(false);
  const [modelInput, setModelInput] = React.useState('');

  const activeProfile = activeProfileOf(profilesState);

  /** AI 配置立即存（下拉切换/弹窗保存/增删模型），存完 toast */
  const persistProfilesNow = async (next: AIProfilesState, what = 'AI 配置'): Promise<boolean> => {
    try {
      await saveAIProfiles(next);
      setProfilesState(next);
      toast.success(`${what}保存成功`);
      return true;
    } catch (error) {
      toast.error(`${what}保存失败`, { description: errorText(error) });
      return false;
    }
  };

  /** 打开设置页时以 storage 为准，丢弃上次未保存的草稿 */
  const reload = React.useCallback(async () => {
    try {
      setProfilesState(await loadAIProfiles());
    } catch (error) {
      toast.error('读取 AI 配置失败', { description: errorText(error) });
    }
  }, []);

  const handleSelectProfile = async (id: string) => {
    if (id === profilesState.activeId) return;
    await persistProfilesNow({ ...profilesState, activeId: id });
  };

  const openProfileModal = (profile: AIProfile | null) => {
    setIsNewProfile(!profile);
    setEditingProfile(
      profile
        ? { ...profile }
        : createAIProfile({ baseUrl: '', protocol: 'chat-completions', model: '', apiKey: '', models: [] }),
    );
  };

  const saveProfileModal = async () => {
    const draft = editingProfile;
    if (!draft) return;
    const baseUrl = normalizeAIBaseUrl(draft.baseUrl);
    const model = draft.model.trim();
    if (!baseUrl) {
      toast.error('请填写 Base URL', { duration: 4000 });
      return;
    }
    if (!model) {
      toast.error('请填写模型 id', { duration: 4000 });
      return;
    }
    // 名称栏已去掉：名称一律自动取 Base URL 的 host
    const clean: AIProfile = {
      ...draft,
      name: hostOfUrl(baseUrl) || '新配置',
      baseUrl,
      model,
      apiKey: draft.apiKey.trim(),
      models: [...new Set([...draft.models, model].map((item) => item.trim()).filter(Boolean))],
    };
    const exists = profilesState.profiles.some((profile) => profile.id === clean.id);
    const next: AIProfilesState = exists
      ? {
          ...profilesState,
          profiles: profilesState.profiles.map((profile) =>
            profile.id === clean.id ? clean : profile,
          ),
        }
      : {
          ...profilesState,
          profiles: [...profilesState.profiles, clean],
          activeId: clean.id,
        };
    if (await persistProfilesNow(next)) setEditingProfile(null);
  };

  const handleDeleteProfileInModal = async () => {
    const draft = editingProfile;
    if (!draft || isNewProfile) return;
    if (!window.confirm(`删除 AI 配置「${profileLabel(draft)}」？`)) return;
    const remaining = profilesState.profiles.filter((profile) => profile.id !== draft.id);
    const next: AIProfilesState = {
      ...profilesState,
      profiles: remaining,
      activeId:
        profilesState.activeId === draft.id ? remaining[0]?.id ?? '' : profilesState.activeId,
    };
    if (await persistProfilesNow(next, 'AI 配置')) setEditingProfile(null);
  };

  const handleSelectModel = async (model: string, profileId?: string) => {
    const targetId = profileId || profilesState.activeId;
    const target = profilesState.profiles.find((p) => p.id === targetId);
    if (!target || !model || model === target.model) return;
    const next: AIProfilesState = {
      ...profilesState,
      profiles: profilesState.profiles.map((profile) =>
        profile.id === target.id
          ? { ...profile, model, models: [...new Set([...profile.models, model])] }
          : profile,
      ),
    };
    await persistProfilesNow(next);
  };

  const saveModelModal = async () => {
    const active = activeProfileOf(profilesState);
    const modelId = modelInput.trim();
    if (!active) {
      setModelModalOpen(false);
      return;
    }
    if (!modelId) return;
    const next: AIProfilesState = {
      ...profilesState,
      profiles: profilesState.profiles.map((profile) =>
        profile.id === active.id
          ? { ...profile, model: modelId, models: [...new Set([...profile.models, modelId])] }
          : profile,
      ),
    };
    if (await persistProfilesNow(next)) {
      setModelModalOpen(false);
      setModelInput('');
    }
  };

  const removeProfileModel = async (model: string) => {
    const active = activeProfileOf(profilesState);
    if (!active) return;
    const next: AIProfilesState = {
      ...profilesState,
      profiles: profilesState.profiles.map((profile) => {
        if (profile.id !== active.id) return profile;
        const models = profile.models.filter((item) => item !== model);
        return {
          ...profile,
          models,
          model: profile.model === model ? models[0] ?? '' : profile.model,
        };
      }),
    };
    await persistProfilesNow(next);
  };

  return {
    profilesState,
    activeProfile,
    editingProfile,
    setEditingProfile,
    isNewProfile,
    modelModalOpen,
    setModelModalOpen,
    modelInput,
    setModelInput,
    reload,
    handleSelectProfile,
    openProfileModal,
    saveProfileModal,
    handleDeleteProfileInModal,
    handleSelectModel,
    saveModelModal,
    removeProfileModel,
  };
}

