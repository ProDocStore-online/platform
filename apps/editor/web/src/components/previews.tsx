import { useEffect, useMemo, useState } from 'react'
import { buildStarterKbFiles } from '../lib/publishing'
import type { Proposal, PublishForm, RepoFile } from '../types'

export function PreviewTabs({
  active,
  setActive,
  hasProposal,
  publish = false,
}: {
  active: 'files' | 'source' | 'proposal' | 'diff'
  setActive: (tab: 'files' | 'source' | 'proposal' | 'diff') => void
  hasProposal: boolean
  publish?: boolean
}) {
  if (publish) {
    return (
      <div className="preview-tabs">
        <button className="preview-tab active" type="button" onClick={() => setActive('files')}>
          Generated files
        </button>
      </div>
    )
  }
  return (
    <div className="preview-tabs">
      <button className={active === 'diff' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('diff')}>
        Diff
      </button>
      <button className={active === 'proposal' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('proposal')} disabled={!hasProposal}>
        Proposal
      </button>
      <button className={active === 'source' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('source')}>
        Source
      </button>
    </div>
  )
}

export function FilesPreview({ files, summary, form }: { files: RepoFile[]; summary: string; form: PublishForm }) {
  const plannedFiles = useMemo(() => buildStarterKbFiles(form), [form])
  const displayFiles = files.length ? files : plannedFiles
  const [selected, setSelected] = useState('')
  const preferred = displayFiles.find((file) => file.path === 'docs/index.md') ?? displayFiles[0]
  const current = displayFiles.find((file) => file.path === selected) ?? preferred
  useEffect(() => {
    if (preferred && !displayFiles.some((file) => file.path === selected)) setSelected(preferred.path)
  }, [displayFiles, selected])
  return (
    <div className="preview-body">
      <div className="preview-summary">
        <strong>{files.length ? summary : 'Repository preview'}</strong>
        <p>{files.length
          ? 'Review before publishing. Generated files must stay Markdown/Zensical source, not committed static output.'
          : 'This is the Zensical repo shape that will be generated and pushed to GitHub.'}</p>
      </div>
      <div className="file-preview-layout">
        <div className="file-list">
          {displayFiles.map((file) => (
            <button key={file.path} className={current?.path === file.path ? 'file-row active' : 'file-row'} onClick={() => setSelected(file.path)} type="button">
              {file.path}
            </button>
          ))}
        </div>
        <pre className="code-view">{current?.content}</pre>
      </div>
    </div>
  )
}

export function EditPreview({
  active,
  source,
  proposal,
  diff,
  path,
}: {
  active: 'files' | 'source' | 'proposal' | 'diff'
  source: string
  proposal: Proposal | null
  diff: string
  path: string
}) {
  const text = active === 'proposal' ? proposal?.content ?? '' : active === 'source' ? source : diff
  return (
    <div className="preview-body">
      <div className="preview-summary">
        <strong>{proposal?.summary ?? path}</strong>
        <p>{proposal?.rationale ?? 'Load a Markdown file and ask AI for a replacement proposal.'}</p>
      </div>
      <pre className="code-view">{text || 'Nothing to preview yet.'}</pre>
    </div>
  )
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={secret ? 'password' : 'text'} />
    </label>
  )
}
