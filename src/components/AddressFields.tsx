import { Field, Input } from './ui'
import type { CustomerAddress } from '../lib/letters'

// ช่องที่อยู่แยกบรรทัด (ใช้ซ้ำในฟอร์มสัญญา + กรอกที่อยู่ทะเบียนราษฎร์)
export const ADDR_FIELDS: { key: keyof CustomerAddress; label: string }[] = [
  { key: 'houseNo', label: 'บ้านเลขที่' },
  { key: 'moo', label: 'หมู่' },
  { key: 'soi', label: 'ซอย' },
  { key: 'road', label: 'ถนน' },
  { key: 'subdistrict', label: 'ตำบล/แขวง' },
  { key: 'district', label: 'อำเภอ/เขต' },
  { key: 'province', label: 'จังหวัด' },
  { key: 'postalCode', label: 'รหัสไปรษณีย์' },
]

export function AddressFields({
  title,
  value,
  onChange,
  onCopy,
}: {
  title?: string
  value: CustomerAddress
  onChange: (field: keyof CustomerAddress, v: string) => void
  onCopy?: () => void
}) {
  return (
    <div className={title ? 'rounded-2xl border border-peach p-3' : ''}>
      {title && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink">{title}</span>
          {onCopy && (
            <button
              type="button"
              onClick={onCopy}
              className="text-xs text-salmon-deep hover:underline"
              title="คัดลอกจากที่อยู่ปัจจุบัน"
            >
              คัดลอกจากปัจจุบัน
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {ADDR_FIELDS.map(({ key, label }) => (
          <Field key={key} label={label}>
            <Input value={value[key] ?? ''} onChange={(e) => onChange(key, e.target.value)} />
          </Field>
        ))}
      </div>
    </div>
  )
}
