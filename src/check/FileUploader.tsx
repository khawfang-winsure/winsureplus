import { useId, useRef, useState } from 'react'
import { Paperclip, X } from 'lucide-react'
import { Button } from './ui'
import { processSelectedFile } from './fileHelpers'
import type { FileKind } from './api'

export interface AttachedFile {
  id: string
  kind: FileKind
  name: string
  mime: string
  size: number
  sha256: string
  blob: Blob
}

export default function FileUploader({
  kind,
  label,
  hint,
  allowPdf = false,
  highlight = false,
  files,
  disabled = false,
  onAdd,
  onRemove,
}: {
  kind: FileKind
  label: string
  hint?: string
  allowPdf?: boolean
  highlight?: boolean
  files: AttachedFile[]
  disabled?: boolean
  onAdd: (file: AttachedFile) => void
  onRemove: (id: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const errorId = useId()

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setBusy(true)
    setError(null)
    for (const raw of Array.from(fileList)) {
      const result = await processSelectedFile(raw, { allowPdf })
      if (!result.ok) {
        setError(result.error)
        continue
      }
      onAdd({
        id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        name: raw.name,
        mime: result.result.mime,
        size: result.result.size,
        sha256: result.result.sha256,
        blob: result.result.blob,
      })
    }
    setBusy(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="wsc-card p-3" style={highlight ? { borderColor: 'var(--wsc-brand)', background: 'rgba(255,122,0,.05)' } : undefined}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="wsc-label !mb-0">
          {label}
        </label>
        <Button
          type="button"
          variant="ghost"
          className="!w-auto !min-h-0 px-3 py-1.5 text-xs"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip className="h-3.5 w-3.5" />
          {busy ? 'กำลังประมวลผล...' : 'แนบไฟล์'}
        </Button>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={allowPdf ? 'image/*,application/pdf' : 'image/*'}
          className="hidden"
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>
      {hint && <p className="wsc-hint">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="wsc-error-text mt-1">
          {error}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 rounded bg-white px-2.5 py-1.5 text-xs" style={{ border: '1px solid var(--wsc-rule)' }}>
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                aria-label={`ลบไฟล์ ${f.name}`}
                onClick={() => onRemove(f.id)}
                className="shrink-0 rounded p-0.5 wsc-muted hover:opacity-70"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
