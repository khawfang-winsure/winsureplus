// โลโก้ WIN SURE PLUS — กล่องเข้มมุมมน มีตัว W และเครื่องหมาย +
export default function Logo({ size = 56 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-2xl bg-[#2b2b2b] text-white shadow-md"
      style={{ width: size, height: size }}
    >
      <div className="relative font-bold leading-none" style={{ fontSize: size * 0.5 }}>
        <span>W</span>
        <span
          className="absolute -right-2 -top-1 text-[#f6a623]"
          style={{ fontSize: size * 0.3 }}
        >
          +
        </span>
      </div>
    </div>
  )
}
