// หน้าจัดการผู้ใช้งานสำหรับแอดมิน — สร้าง user + รหัสผ่าน, แก้ชื่อ/role/รหัสผ่าน, ปิด/เปิดใช้งาน
// ฝั่งหลังบ้านเรียก Edge Function 'admin-users' (service_role) — เตยต้อง deploy ก่อนใช้
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, ShieldCheck, UserPlus } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, Select } from './ui'
import {
  createAdminUser,
  getFreelancerGrades,
  listAdminUsers,
  setAdminUserActive,
  setFreelancerGrades,
  updateAdminUser,
  type AdminUserRow,
  type FreelancerGrade,
  type Role,
} from '../lib/db'
import { useAuth } from '../lib/auth'

// เกรดผู้ติดตามหนี้ (A–E ตาม 0018 schema)
const FREELANCER_GRADES: FreelancerGrade[] = ['A', 'B', 'C', 'D', 'E']

interface EditState {
  id?: string // มี id = แก้ไข, ไม่มี = สร้างใหม่
  email: string
  password: string
  fullName: string
  role: Role
}

const emptyEdit: EditState = { email: '', password: '', fullName: '', role: 'staff' }

export function UsersAdmin() {
  const { configured } = useAuth()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [busy, setBusy] = useState(false)
  // แคชเกรดผู้ติดตามหนี้ per user id (โหลดครั้งเดียวพร้อม user list)
  const [gradeMap, setGradeMap] = useState<Record<string, FreelancerGrade[]>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listAdminUsers()
      setUsers(rows)
      // โหลดเกรดสำหรับทุก freelancer พร้อมกัน
      const freelancers = rows.filter((u) => u.role === 'freelancer')
      const entries = await Promise.all(
        freelancers.map(async (u) => {
          const grades = await getFreelancerGrades(u.id)
          return [u.id, grades] as [string, FreelancerGrade[]]
        }),
      )
      setGradeMap(Object.fromEntries(entries))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (configured) load()
    else setLoading(false)
  }, [configured, load])

  if (!configured) {
    return (
      <Card>
        <h3 className="mb-2 font-semibold text-ink">สิทธิ์ผู้ใช้งาน</h3>
        <p className="text-sm text-ink-soft">โหมดตัวอย่าง — ยังไม่เชื่อม Supabase ค่ะ</p>
      </Card>
    )
  }

  async function toggleActive(u: AdminUserRow) {
    if (!window.confirm(`${u.active ? 'ปิด' : 'เปิด'}การใช้งานของ ${u.fullName}?`)) return
    setBusy(true)
    try {
      await setAdminUserActive(u.id, !u.active)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function roleBadge(u: AdminUserRow) {
    if (u.role === 'admin') return <Badge tone="amber">แอดมิน</Badge>
    if (u.role === 'freelancer') return <Badge tone="neutral">ผู้ติดตามหนี้</Badge>
    return <Badge tone="neutral">พนักงาน</Badge>
  }

  function gradeCell(u: AdminUserRow) {
    if (u.role !== 'freelancer') return <span className="text-ink-soft">—</span>
    const grades = gradeMap[u.id]
    if (!grades || grades.length === 0) return <span className="text-amber-600 text-xs">ไม่มีเกรด</span>
    return <span className="text-ink text-xs font-medium">{grades.join(', ')}</span>
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-ink">
          <ShieldCheck size={18} className="text-salmon-deep" />
          สิทธิ์ผู้ใช้งาน
        </h3>
        <Button variant="ghost" onClick={() => setEdit(emptyEdit)}>
          <Plus size={16} /> เพิ่มผู้ใช้
        </Button>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          ⚠️ {error}
          <p className="mt-1 text-xs text-amber-700">
            (ถ้าเห็น "Function not found" — Edge Function ยังไม่ได้ deploy ค่ะ ขอให้เตยรัน <code className="rounded bg-amber-100 px-1">supabase functions deploy admin-users</code>)
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-ink-soft">
          <Loader2 size={16} className="animate-spin" /> กำลังโหลด...
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-peach">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                <th className="px-4 py-2.5 font-semibold">ชื่อ-อีเมล</th>
                <th className="w-28 px-3 py-2.5 text-center font-semibold">สิทธิ์</th>
                <th className="w-24 px-3 py-2.5 text-center font-semibold">เกรด</th>
                <th className="w-24 px-3 py-2.5 text-center font-semibold">สถานะ</th>
                <th className="w-40 px-3 py-2.5 text-right font-semibold">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.id} className={`${u.active ? '' : 'opacity-60'} ${i % 2 ? 'bg-white' : 'bg-cream-deep'}`}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-ink">{u.fullName}</p>
                    <p className="text-xs text-ink-soft">{u.email || '—'}</p>
                  </td>
                  <td className="px-3 py-2.5 text-center">{roleBadge(u)}</td>
                  <td className="px-3 py-2.5 text-center">{gradeCell(u)}</td>
                  <td className="px-3 py-2.5 text-center">
                    <Badge tone={u.active ? 'green' : 'neutral'}>{u.active ? 'ใช้งาน' : 'ปิด'}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() =>
                          setEdit({
                            id: u.id,
                            email: u.email ?? '',
                            password: '',
                            fullName: u.fullName,
                            role: u.role,
                          })
                        }
                        className="rounded-lg p-1.5 text-ink-soft hover:bg-peach-light"
                        title="แก้ไข"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => toggleActive(u)}
                        disabled={busy}
                        className="rounded-lg px-2 py-1 text-xs text-ink-soft hover:bg-peach-light disabled:opacity-50"
                      >
                        {u.active ? 'ปิด' : 'เปิด'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-ink-soft">
                    ยังไม่มีผู้ใช้งานในระบบ
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <UserEditModal
          value={edit}
          existingGrades={edit.id && edit.role === 'freelancer' ? (gradeMap[edit.id] ?? []) : []}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null)
            await load()
          }}
        />
      )}
    </Card>
  )
}

function UserEditModal({
  value,
  existingGrades,
  onClose,
  onSaved,
}: {
  value: EditState
  existingGrades: FreelancerGrade[]
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !value.id
  const [f, setF] = useState<EditState>(value)
  const [selectedGrades, setSelectedGrades] = useState<FreelancerGrade[]>(existingGrades)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof EditState>(k: K, v: EditState[K]) => setF((p) => ({ ...p, [k]: v }))

  // เมื่อ role เปลี่ยนออกจาก freelancer ให้ล้าง grade ที่เลือกออก
  function handleRoleChange(newRole: Role) {
    set('role', newRole)
    if (newRole !== 'freelancer') setSelectedGrades([])
  }

  function toggleGrade(grade: FreelancerGrade) {
    setSelectedGrades((prev) =>
      prev.includes(grade) ? prev.filter((g) => g !== grade) : [...prev, grade],
    )
  }

  async function save() {
    setErr(null)
    if (isNew) {
      if (!f.email || !f.password || !f.fullName) {
        setErr('กรุณากรอก อีเมล / รหัสผ่าน / ชื่อ ให้ครบ')
        return
      }
      if (f.password.length < 6) {
        setErr('รหัสผ่านต้องอย่างน้อย 6 ตัว')
        return
      }
    } else {
      if (!f.fullName) {
        setErr('ชื่อห้ามว่าง')
        return
      }
      if (f.password && f.password.length < 6) {
        setErr('รหัสผ่านใหม่ต้องอย่างน้อย 6 ตัว (หรือเว้นว่างถ้าไม่เปลี่ยน)')
        return
      }
    }
    setBusy(true)
    try {
      let savedId = value.id
      if (isNew) {
        // createAdminUser อาจ return id — ถ้า W3.A คืน void ให้ reload list หา id จาก email แทน
        await createAdminUser({ email: f.email, password: f.password, fullName: f.fullName, role: f.role })
      } else {
        await updateAdminUser({
          id: value.id!,
          fullName: f.fullName,
          role: f.role,
          password: f.password || undefined,
        })
        savedId = value.id
      }
      // sync เกรดผู้ติดตามหนี้ (full-replace)
      if (f.role === 'freelancer' && savedId) {
        await setFreelancerGrades(savedId, selectedGrades)
      }
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const isFreelancer = f.role === 'freelancer'
  const noGradeWarning = isFreelancer && selectedGrades.length === 0

  return (
    <Modal title={isNew ? 'เพิ่มผู้ใช้งาน' : 'แก้ไขผู้ใช้งาน'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="อีเมล (ใช้ล็อกอิน)" required>
          <Input
            type="email"
            value={f.email}
            disabled={!isNew}
            onChange={(e) => set('email', e.target.value)}
            placeholder="staff@example.com"
            className={!isNew ? 'bg-slate-100 text-ink-soft' : ''}
          />
        </Field>
        <Field label="ชื่อ-นามสกุล" required>
          <Input value={f.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="เช่น สมชาย ใจดี" />
        </Field>
        <Field label="สิทธิ์" required>
          <Select value={f.role} onChange={(e) => handleRoleChange(e.target.value as Role)}>
            <option value="staff">พนักงาน (staff)</option>
            <option value="admin">แอดมิน (admin)</option>
            <option value="freelancer">ผู้ติดตามหนี้ (freelancer)</option>
          </Select>
        </Field>

        {isFreelancer && (
          <div className="rounded-xl border border-peach bg-peach-light/40 px-4 py-3">
            <p className="mb-2 text-sm font-medium text-ink">เกรดที่รับผิดชอบ</p>
            <div className="flex flex-wrap gap-2">
              {FREELANCER_GRADES.map((grade) => {
                const checked = selectedGrades.includes(grade)
                return (
                  <button
                    key={grade}
                    type="button"
                    onClick={() => toggleGrade(grade)}
                    className={`min-w-[2.5rem] rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                      checked
                        ? 'border-salmon-deep bg-salmon-deep text-white shadow-sm'
                        : 'border-peach bg-white text-ink-soft hover:border-salmon-deep/60 hover:text-ink'
                    }`}
                  >
                    {grade}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              เลือกได้หลายเกรด — ลูกค้าค้างวันมากขึ้นจะข้ามไปเกรดถัดไปอัตโนมัติ
            </p>
            {noGradeWarning && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                ⚠️ ผู้ติดตามหนี้ที่ไม่มีเกรดจะไม่เห็นลูกค้าใดๆ
              </p>
            )}
          </div>
        )}

        <Field label={isNew ? 'รหัสผ่าน (อย่างน้อย 6 ตัว)' : 'รหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)'} required={isNew}>
          <Input
            type="text"
            value={f.password}
            onChange={(e) => set('password', e.target.value)}
            placeholder={isNew ? 'รหัสผ่านสำหรับล็อกอินครั้งแรก' : 'พิมพ์รหัสใหม่ ถ้าจะเปลี่ยน'}
          />
        </Field>
        {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">⚠️ {err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : isNew ? <UserPlus size={16} /> : <Pencil size={16} />}
            {isNew ? 'สร้างผู้ใช้' : 'บันทึก'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
