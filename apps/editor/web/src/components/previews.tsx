import { useEffect, useMemo, useState } from 'react'
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
  const plannedFiles = useMemo(() => plannedRepoPreview(form), [form])
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

function plannedRepoPreview(form: PublishForm): RepoFile[] {
  const title = form.title || 'Untitled Knowledge Base'
  const slug = form.slug || 'knowledge-base'
  const productionUrl = form.customDomain ? `https://${form.customDomain}/` : `https://${slug}.pages.dev/`
  return [
    {
      path: 'zensical.toml',
      content: [
        `title = "${title.replace(/"/g, '\\"')}"`,
        `base_url = "${productionUrl}"`,
        'content_dir = "docs"',
        'output_dir = "site"',
        '',
        '[navigation]',
        'items = [',
        '  { title = "Start", path = "index.md" },',
        '  { title = "First Principles", path = "first-principles.md" },',
        '  { title = "Assessment Method", path = "assessment-method.md" },',
        '  { title = "Governance", path = "governance.md" },',
        '  { title = "Operations", path = "operations.md" },',
        '  { title = "Support and Escalation", path = "support-and-escalation.md" },',
        '  { title = "Access Policy", path = "access-policy.md" },',
        '  { title = "Register", path = "register.md" }',
        ']',
      ].join('\n'),
    },
    {
      path: 'docs/index.md',
      content: [
        `# ${title}`,
        '',
        form.prompt || 'Describe the knowledge base you want to publish. ProDocStore will generate Markdown source files for a Zensical book.',
        '',
        '## Company Context',
        '',
        `- Company: ${form.companyName || 'Not specified'}`,
        `- Department: ${form.department || 'Not specified'}`,
        `- Audience: ${form.audience || 'Not specified'}`,
        `- Knowledge owner: ${form.knowledgeOwner || 'Not specified'}`,
        `- Review cadence: ${form.reviewCadence || 'Not specified'}`,
        `- Compliance mode: ${form.complianceMode || 'Not specified'}`,
      ].join('\n'),
    },
    {
      path: 'docs/governance.md',
      content: [
        '# Governance',
        '',
        `Knowledge owner: ${form.knowledgeOwner || 'Not assigned'}.`,
        `Review cadence: ${form.reviewCadence || 'Not specified'}.`,
        `Compliance mode: ${form.complianceMode || 'Standard internal controls'}.`,
      ].join('\n'),
    },
    {
      path: 'docs/operations.md',
      content: [
        '# Operations',
        '',
        `Department: ${form.department || 'Not specified'}.`,
        `Audience: ${form.audience || 'Not specified'}.`,
      ].join('\n'),
    },
    {
      path: 'docs/support-and-escalation.md',
      content: [
        '# Support and Escalation',
        '',
        `Support channel: ${form.supportChannel || 'Not specified'}.`,
        `Escalation path: ${form.escalationPath || 'Not specified'}.`,
      ].join('\n'),
    },
    {
      path: 'docs/access-policy.md',
      content: [
        '# Access Policy',
        '',
        `Visibility: ${form.visibility}.`,
        `Staff email domain: ${form.accessEmailDomain || 'Not specified'}.`,
        `Allowed emails: ${form.accessAllowedEmails || 'Not specified'}.`,
        `Client email domain: ${form.accessClientDomain || 'Not specified'}.`,
        `Office CIDRs: ${form.accessOfficeCidrs || 'Not specified'}.`,
      ].join('\n'),
    },
    {
      path: '.github/workflows/deploy.yml',
      content: [
        'name: Deploy Zensical KB',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-python@v5',
        '        with:',
        '          python-version: "3.x"',
        '      - run: python3 -m pip install zensical && python3 -m zensical build --strict',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        `          command: pages deploy site --project-name=${slug}`,
      ].join('\n'),
    },
    {
      path: 'README.md',
      content: [
        `# ${title}`,
        '',
        'ProDocStore knowledge base.',
        '',
        '- Engine: Zensical',
        `- Company: ${form.companyName || 'Not specified'}`,
        `- Department: ${form.department || 'Not specified'}`,
        `- Audience: ${form.audience || 'Not specified'}`,
        `- Knowledge owner: ${form.knowledgeOwner || 'Not specified'}`,
        '- Source: `docs/`',
        '- Build output: `site/`',
        `- Production target: ${productionUrl}`,
      ].join('\n'),
    },
  ]
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
