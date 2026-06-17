import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, FileText, Loader2, Search } from 'lucide-react'
import { getContracts, getShops } from '../lib/db'
import { useAuth } from '../lib/auth'
import type { Contract, Shop } from '../lib/types'

// ---------- ชนิดแถวผลลัพธ์ ----------

type ContractResult = {
  kind: 'contract'
  id: string
  label: string    // ชื่อลูกค้า
  sub: string      // เลขสัญญา
}

type ShopResult = {
  kind: 'shop'
  id: string
  label: string    // ชื่อร้าน
  sub: string      // รหัสร้าน
}

type SearchResult = ContractResult | ShopResult

// ---------- helper filter ----------

function filterContracts(contracts: Contract[], q: string): ContractResult[] {
  const lower = q.toLowerCase()
  return contracts
    .filter(
      (c) =>
        c.customerName.toLowerCase().includes(lower) ||
        c.contractNo.toLowerCase().includes(lower),
    )
    .slice(0, 5)
    .map((c) => ({
      kind: 'contract' as const,
      id: c.id,
      label: c.customerName,
      sub: c.contractNo,
    }))
}

function filterShops(shops: Shop[], q: string): ShopResult[] {
  const lower = q.toLowerCase()
  return shops
    .filter((s) => s.name.toLowerCase().includes(lower) || s.code.toLowerCase().includes(lower))
    .slice(0, 3)
    .map((s) => ({
      kind: 'shop' as const,
      id: s.id,
      label: s.name,
      sub: s.code,
    }))
}

// ---------- Component หลัก ----------

export default function QuickSearch() {
  const { role, configured } = useAuth()
  const navigate = useNavigate()

  // role gate: executive และ freelancer ห้ามเข้าถึงข้อมูลสัญญา/ร้านในรูปแบบนี้
  const isAdminOrStaff =
    !configured || role === 'admin' || role === 'staff'
  if (!isAdminOrStaff) return null

  return <QuickSearchModal navigate={navigate} />
}

// แยก logic ออกมาเพื่อให้ hook ไม่ถูก early-return ข้างบน (Rules of Hooks)
function QuickSearchModal({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // cache ข้อมูลหลังโหลดครั้งแรก
  const contractsCache = useRef<Contract[] | null>(null)
  const shopsCache = useRef<Shop[] | null>(null)

  // ผลลัพธ์ที่ filter แล้ว
  const [results, setResults] = useState<SearchResult[]>([])

  const inputRef = useRef<HTMLInputElement>(null)

  // ---------- open/close ----------

  const openModal = useCallback(async () => {
    setOpen(true)
    setQuery('')
    setResults([])
    setSelectedIndex(0)

    // fetch ครั้งแรกเท่านั้น
    if (contractsCache.current === null || shopsCache.current === null) {
      setLoading(true)
      try {
        const [contracts, shops] = await Promise.all([getContracts(), getShops()])
        contractsCache.current = contracts
        shopsCache.current = shops
      } catch {
        contractsCache.current = []
        shopsCache.current = []
      } finally {
        setLoading(false)
      }
    }
  }, [])

  const closeModal = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResults([])
    setSelectedIndex(0)
  }, [])

  // ---------- global keydown: Ctrl/Cmd+K ----------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (open) {
          closeModal()
        } else {
          void openModal()
        }
      }
      if (e.key === 'Escape' && open) {
        closeModal()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, openModal, closeModal])

  // ---------- autofocus เมื่อ modal เปิด ----------

  useEffect(() => {
    if (open) {
      // รอ DOM paint รอบนึงก่อน focus
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  // ---------- filter เมื่อ query หรือ loading เปลี่ยน ----------
  // loading เป็น dep เพราะ ref ที่เปลี่ยนไม่ trigger effect — ต้องใช้ loading state เป็น signal ว่า cache พร้อม

  useEffect(() => {
    const q = query.trim()
    if (!q || contractsCache.current === null || shopsCache.current === null) {
      setResults([])
      setSelectedIndex(0)
      return
    }
    const contracts = filterContracts(contractsCache.current, q)
    const shops = filterShops(shopsCache.current, q)
    setResults([...contracts, ...shops])
    setSelectedIndex(0)
  }, [query, loading])

  // ---------- keyboard navigation ----------

  function onKeyDownInModal(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[selectedIndex]
      if (item) navigateTo(item)
    }
  }

  // ---------- navigate ----------

  function navigateTo(item: SearchResult) {
    closeModal()
    if (item.kind === 'contract') {
      navigate(`/contract/${item.id}`)
    } else {
      navigate(`/shop/${item.id}`)
    }
  }

  // ---------- แบ่ง results เป็น 2 section ----------

  const contractResults = results.filter((r): r is ContractResult => r.kind === 'contract')
  const shopResults = results.filter((r): r is ShopResult => r.kind === 'shop')

  // index ใน results[] ที่ flat: ใช้ดู selectedIndex
  function globalIndex(item: SearchResult): number {
    return results.indexOf(item)
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 p-4"
      style={{ paddingTop: '20vh' }}
      onClick={closeModal}
    >
      <div
        className="mx-auto w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDownInModal}
      >
        {/* Input ค้นหา */}
        <div className="flex items-center gap-3 border-b border-peach px-4 py-3">
          <Search size={18} className="shrink-0 text-ink-soft" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-soft"
            placeholder="ค้นหาลูกค้า เลขสัญญา หรือร้าน..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <Loader2 size={16} className="animate-spin text-ink-soft" />}
        </div>

        {/* ผลลัพธ์ */}
        <div className="max-h-[50vh] overflow-y-auto">
          {!query.trim() && !loading && (
            <p className="px-4 py-6 text-center text-sm text-ink-soft">พิมพ์เพื่อค้นหา</p>
          )}

          {query.trim() && results.length === 0 && !loading && (
            <p className="px-4 py-6 text-center text-sm text-ink-soft">ไม่พบผลลัพธ์</p>
          )}

          {contractResults.length > 0 && (
            <section>
              <p className="sticky top-0 bg-peach-light/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft backdrop-blur-sm">
                สัญญา / ลูกค้า
              </p>
              {contractResults.map((item) => {
                const idx = globalIndex(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                      selectedIndex === idx
                        ? 'bg-salmon-deep/10 text-salmon-deep'
                        : 'text-ink hover:bg-peach-light/50'
                    }`}
                    onClick={() => navigateTo(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <FileText size={16} className="shrink-0 text-salmon-deep" />
                    <span className="flex-1">
                      <span className="block font-medium">{item.label}</span>
                      <span className="block text-xs text-ink-soft">{item.sub}</span>
                    </span>
                  </button>
                )
              })}
            </section>
          )}

          {shopResults.length > 0 && (
            <section>
              <p className="sticky top-0 bg-peach-light/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft backdrop-blur-sm">
                ร้านค้า
              </p>
              {shopResults.map((item) => {
                const idx = globalIndex(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                      selectedIndex === idx
                        ? 'bg-salmon-deep/10 text-salmon-deep'
                        : 'text-ink hover:bg-peach-light/50'
                    }`}
                    onClick={() => navigateTo(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <Building2 size={16} className="shrink-0 text-salmon-deep" />
                    <span className="flex-1">
                      <span className="block font-medium">{item.label}</span>
                      <span className="block text-xs text-ink-soft">{item.sub}</span>
                    </span>
                  </button>
                )
              })}
            </section>
          )}
        </div>

        {/* Keyboard hint */}
        <div className="flex items-center gap-4 border-t border-peach px-4 py-2.5">
          <span className="text-xs text-ink-soft">
            <kbd className="rounded bg-peach px-1.5 py-0.5 font-mono text-[10px]">↵</kbd>
            {' '}เปิด
          </span>
          <span className="text-xs text-ink-soft">
            <kbd className="rounded bg-peach px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd>
            {' '}เลื่อน
          </span>
          <span className="text-xs text-ink-soft">
            <kbd className="rounded bg-peach px-1.5 py-0.5 font-mono text-[10px]">esc</kbd>
            {' '}ปิด
          </span>
          <span className="ml-auto text-xs text-ink-soft">
            <kbd className="rounded bg-peach px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
            {' '}/
            {' '}<kbd className="rounded bg-peach px-1.5 py-0.5 font-mono text-[10px]">Ctrl K</kbd>
          </span>
        </div>
      </div>
    </div>
  )
}
