import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  isChunkError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, isChunkError: false };

  static getDerivedStateFromError(error: Error): State {
    // ChunkLoadError = Vite hashed chunk URL ที่หายไปจาก deploy ใหม่
    const isChunk =
      error.name === 'ChunkLoadError' ||
      error.message?.includes('Failed to fetch dynamically imported module') ||
      error.message?.includes('Loading chunk');
    return { hasError: true, isChunkError: isChunk };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info);
  }

  reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    if (this.state.isChunkError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-cream p-4">
          <div className="max-w-md text-center space-y-4">
            <p className="text-lg font-medium text-ink">มีเวอร์ชันใหม่กว่า</p>
            <p className="text-sm text-ink-soft">ระบบมีการอัปเดต กรุณาโหลดหน้าใหม่เพื่อดูเวอร์ชันล่าสุด</p>
            <button
              onClick={this.reload}
              className="px-4 py-2 bg-salmon-deep text-white rounded-md hover:opacity-90"
            >
              โหลดใหม่
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-cream p-4">
        <div className="max-w-md text-center space-y-4">
          <p className="text-lg font-medium text-ink">เกิดข้อผิดพลาด</p>
          <p className="text-sm text-ink-soft">กรุณาลองโหลดหน้าใหม่ หากปัญหายังอยู่ ติดต่อแอดมิน</p>
          <button
            onClick={this.reload}
            className="px-4 py-2 bg-salmon-deep text-white rounded-md hover:opacity-90"
          >
            โหลดใหม่
          </button>
        </div>
      </div>
    );
  }
}
