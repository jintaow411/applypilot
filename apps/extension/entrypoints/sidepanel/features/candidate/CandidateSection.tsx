import * as React from 'react';
import { AlertCircle, ChevronRight, Database, Loader2, Sparkles, Upload } from 'lucide-react';
import { cn } from '../../../../components/ui/utils';
import { Button } from '../../../../components/ui/button';
import { toast } from '../../../../components/ui/toast';
import { MIN_CANDIDATE_TEXT_LENGTH } from '../../../../lib/candidate';
import { Modal } from '../../components/Modal';
import { FilePreviewModal } from './FilePreviewModal';
import { ProfileSummary } from './ProfileSummary';
import { StagedFiles } from './StagedFiles';
import { formatDateTime } from '../schema/helpers';
import { errorText } from '../server/errors';
import type { useCandidate } from './hooks';

const inputCls =
  'w-full rounded-md border border-input-border bg-input px-2 py-1.5 text-ui-sm text-foreground outline-none focus:border-brand disabled:opacity-60';

/** 信息库文本弹窗：textarea 直接显示/编辑存的文本，保存只做非空过短校验 */
function CandidateProfileModal(props: { text: string; onClose: () => void; onSave: (text: string) => Promise<void> }) {
  const onClose = props.onClose;
  const onSave = props.onSave;
  const [text, setText] = React.useState(props.text);
  const [saving, setSaving] = React.useState(false);

  const handleSave = function () {
    if (saving) return Promise.resolve();
    if (text.replace(/\s+/g, '').length < MIN_CANDIDATE_TEXT_LENGTH) {
      toast.error('信息库内容太短', { description: '有效内容至少 ' + MIN_CANDIDATE_TEXT_LENGTH + ' 字，补全后再保存。' });
      return Promise.resolve();
    }
    setSaving(true);
    return onSave(text.trim()).then(function () {
      toast.success('信息库已更新');
      onClose();
    }).catch(function (error) {
      toast.error('保存失败', { description: errorText(error) });
    }).then(function () {
      setSaving(false);
    });
  };

  return (
    <Modal
      title="信息库内容"
      onClose={onClose}
      wide
      footer={
        <>
          <Button size="sm" variant="outline" className="h-8 flex-1" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button size="sm" className="h-8 flex-1" onClick={function () { void handleSave(); }} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-ui-xs leading-relaxed text-foreground-subtlest">直接编辑信息库文本，保存后回填时原样发给 AI。</p>
        <textarea value={text} disabled={saving} onChange={function (e) { setText(e.target.value); }} spellCheck={false} className={cn(inputCls, 'min-h-[320px] resize-y font-mono leading-relaxed')} />
      </div>
    </Modal>
  );
}

/** 最后一条非空行；没有非空行时返回空串。对齐 mini-agent latestLine */
function latestLine(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length > 0) return line;
  }
  return '';
}

/**
 * 流式回复行：流式期展开或横向滚动显示最新回复，流式一结束自动折叠。
 * 前端样式和前端交互逻辑对齐 mini-agent 模型流式返回设计。
 */
function CandidateStreamingRow({
  text,
  streaming,
  error,
  title,
}: {
  text: string;
  streaming: boolean;
  error?: string | null;
  title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const viewportRef = React.useRef<HTMLSpanElement | null>(null);
  const summary = latestLine(text);

  // 摘要增长后把单行视口推到末尾：旧内容向左移出，右端始终是最新回复
  React.useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [summary]);

  // 解析一结束就自动折叠：流式期间用户手动展开过也收回，收起后仍可点开重读
  React.useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  const displayTitle = error ? '处理失败' : streaming ? (title || '解析中…') : '模型回复';

  return (
    <div className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-left text-ui-sm leading-relaxed transition-colors">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="group/stream flex w-full min-w-0 cursor-pointer items-center gap-2 text-left focus-visible:outline-none"
        aria-expanded={open}
        aria-label={streaming ? `${displayTitle}：${summary}` : error ? `处理失败：${error}` : '处理完成'}
      >
        {error ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <Sparkles
            className={cn(
              'h-4 w-4 shrink-0 text-foreground-subtlest transition-colors',
              streaming && 'animate-pulse text-brand'
            )}
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            'shrink-0 whitespace-nowrap font-medium',
            error ? 'text-destructive' : streaming ? 'text-foreground-subtle' : 'text-foreground-subtlest'
          )}
        >
          {displayTitle}
        </span>
        {error ? (
          <span className="min-w-0 flex-1 truncate text-destructive/80 text-ui-xs">{error}</span>
        ) : streaming ? (
          <span
            ref={viewportRef}
            className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-foreground-subtle"
          >
            <span className="inline-block min-w-max">{summary || '等待模型响应…'}</span>
          </span>
        ) : null}
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-foreground-subtlest transition-transform duration-160',
            open ? 'rotate-90 opacity-100' : 'opacity-60 group-hover/stream:opacity-100'
          )}
        />
      </button>
      {open ? (
        <div className="ml-2 border-l border-border pl-3.5 pt-2.5">
          <div className="max-h-60 space-y-1.5 overflow-auto font-mono text-ui-xs whitespace-pre-wrap break-words text-foreground-subtlest">
            {text || '（等待输出…）'}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 候选人信息库分区：摘要（可删除）/ 暂存文件（可多选，先存不解析）/ 进度条 / 解析追加。
 * 拖入文件不再立即保存，改为暂存；点“解析并追加”才把 N 个文件一起发给 AI，
 * 已有信息库走合并追加，不会覆盖。
 */
export function CandidateSection(props: { cand: ReturnType<typeof useCandidate> }) {
  const cand = props.cand;
  const candidate = cand.candidate;
  const candidateBusy = cand.candidateBusy;
  const streamState = cand.streamState;
  const merging = cand.merging;
  const busy = candidateBusy || merging;
  const isStreaming = streamState.streaming || (busy && Boolean(streamState.text));
  const dragActive = cand.dragActive;
  const staged = cand.staged;
  const progress = cand.progress;
  const preview = cand.preview;
  const [modalOpen, setModalOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const clickable = candidate.state === 'ready' && !!candidate.text;
  const text = candidate.text;
  const charCount = text ? text.replace(/\s+/g, '').length : 0;
  const readyCount = staged.filter((item) => item.status !== 'error').length;
  const hasStaged = staged.length > 0;
  const hasProfile = candidate.state === 'ready';

  const handleDelete = function () {
    if (cand.deleting) return;
    void cand.deleteProfile().then(function (ok) {
      if (ok) setConfirmDelete(false);
    });
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Database className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 truncate text-ui-sm font-semibold tracking-wide text-foreground">候选人信息库</h3>
      </div>

      <ProfileSummary
        state={candidate.state}
        charCount={charCount}
        updatedAt={candidate.updatedAt ? formatDateTime(candidate.updatedAt) : null}
        error={candidate.error}
        deleting={cand.deleting}
        onOpen={function () { setModalOpen(true); }}
        onDelete={function () { setConfirmDelete(true); }}
      />

      {hasStaged || progress.active ? (
        <div className="mt-2.5">
          <StagedFiles
            files={staged}
            progress={progress}
            disabled={busy}
            onOpen={function (id) { void cand.openPreview(id); }}
            onRemove={cand.removeStagedFile}
            onClear={cand.clearStaged}
          />
        </div>
      ) : null}

      {hasStaged ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <Button
            className="h-8 w-full"
            onClick={function () { void cand.runStagedParse(); }}
            disabled={busy || readyCount === 0}
            title={hasProfile ? '解析后追加合并进信息库，不会覆盖已有内容' : '解析后写入信息库'}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            <span className="truncate">
              {busy ? '正在解析并合并…' : hasProfile ? `解析并追加（${readyCount} 个文件）` : `解析并保存（${readyCount} 个文件）`}
            </span>
          </Button>
          <p className="text-ui-2xs leading-relaxed text-foreground-subtlest">
            {hasProfile ? '多文件一起发给 AI，结果追加合并到已有信息库（不会覆盖）。' : '多文件一起发给 AI，解析后写入信息库。'}
            单次上限 3 万字。
          </p>
        </div>
      ) : null}

      {isStreaming ? (
        <div className="mt-2.5">
          <CandidateStreamingRow
            text={streamState.text}
            streaming={streamState.streaming}
            error={streamState.error}
            title={streamState.title}
          />
        </div>
      ) : null}

      <div
        onDragOver={function (event) {
          event.preventDefault();
          if (!busy) cand.setDragActive(true);
        }}
        onDragLeave={function () { cand.setDragActive(false); }}
        onDrop={function (event) {
          event.preventDefault();
          cand.setDragActive(false);
          if (busy) return;
          cand.addFiles(event.dataTransfer.files);
        }}
        onClick={function () { if (busy) return; if (cand.fileInputRef.current) cand.fileInputRef.current.click(); }}
        className={cn(
          'mt-3 flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-8 text-center text-ui-xs leading-relaxed transition-colors',
          dragActive
            ? 'border-brand bg-brand/10 text-foreground'
            : 'border-border bg-surface text-foreground-subtle hover:border-brand/60 hover:bg-brand/5 hover:text-foreground'
        )}
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2 text-foreground">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            {progress.label || (merging && !candidateBusy ? '正在更新信息库…' : '正在解析并保存…')}
          </span>
        ) : (
          <span className="flex flex-col items-center justify-center gap-2">
            <Upload className={cn('h-4 w-4 shrink-0 transition-colors', dragActive ? 'text-foreground' : 'text-foreground-subtlest')} />
            <span className="text-ui-sm font-medium text-foreground">把个人资料拖到这里，或点击选择文件</span>
            <span>支持 .txt / .md / .docx，可一次拖入多个</span>
          </span>
        )}
        <input
          ref={cand.fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.docx"
          className="hidden"
          onChange={function (event) {
            const target = event.target as HTMLInputElement;
            const files = Array.from(target.files ?? []);
            target.value = '';
            if (files.length) cand.addFiles(files);
          }}
          onClick={function (event) { event.stopPropagation(); }}
        />
      </div>

      {modalOpen && clickable && text ? (
        <CandidateProfileModal text={text} onClose={function () { setModalOpen(false); }} onSave={cand.saveEditedProfile} />
      ) : null}

      {confirmDelete ? (
        <Modal
          title="删除信息库？"
          onClose={function () { if (!cand.deleting) setConfirmDelete(false); }}
          footer={(
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" onClick={function () { setConfirmDelete(false); }} disabled={cand.deleting}>
                取消<span className="ml-1 text-ui-sm text-foreground-subtlest">esc</span>
              </Button>
              <Button variant="destructive" onClick={handleDelete} disabled={cand.deleting}>
                {cand.deleting ? '删除中…' : '确认删除'}
              </Button>
            </div>
          )}
        >
          <p className="text-ui-base leading-relaxed text-foreground-subtle">
            将清空本地保存的候选人信息库{charCount > 0 ? `（${charCount.toLocaleString('zh-CN')} 字）` : ''}，删除后无法恢复。
            暂存的文件不会被删除。
          </p>
        </Modal>
      ) : null}

      {preview ? (
        <FilePreviewModal
          name={preview.name}
          sizeText={preview.sizeText}
          charCount={preview.charCount}
          text={preview.text}
          loading={preview.loading}
          error={preview.error}
          onClose={cand.closePreview}
        />
      ) : null}
    </section>
  );
}
