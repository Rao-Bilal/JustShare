import { formatBytes } from '../services/format';
import { getFileIconComponent, IconCheckCircle, IconX } from './Icons';

export interface FileRowProps {
  name: string;
  size: number;
  relativePath?: string;
  onRemove?: () => void;
  progress?: number; // 0 to 100
  isVerified?: boolean;
  statusText?: string;
}

export function FileRow({
  name,
  size,
  relativePath,
  onRemove,
  progress,
  isVerified,
  statusText,
}: FileRowProps) {
  const displayName = relativePath || name;

  return (
    <div className="file-row">
      <div className="file-row-icon" aria-hidden="true">
        {getFileIconComponent(name, 20)}
      </div>

      <div className="file-row-info">
        <span className="file-row-name" title={displayName}>
          {displayName}
        </span>
        <div className="file-row-meta">
          <span className="file-row-size">{formatBytes(size)}</span>
          {statusText && <span className="file-row-status">{statusText}</span>}
          {isVerified && (
            <span className="file-row-verified">
              <IconCheckCircle size={14} /> SHA-256 Verified
            </span>
          )}
        </div>
        {typeof progress === 'number' && progress >= 0 && progress < 100 && (
          <div className="file-row-progress-track">
            <div
              className="file-row-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        )}
      </div>

      {onRemove && (
        <button
          type="button"
          className="file-row-remove-btn"
          onClick={onRemove}
          aria-label={`Remove ${displayName}`}
          title={`Remove ${displayName}`}
        >
          <IconX size={16} />
        </button>
      )}
    </div>
  );
}
