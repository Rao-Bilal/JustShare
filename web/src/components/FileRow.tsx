import { formatBytes } from '../services/format';
import { truncateMiddle } from '../services/errorMapper';

export interface FileRowProps {
  name: string;
  size: number;
  relativePath?: string;
  onRemove?: () => void;
  showMiddleTruncate?: boolean;
}

export function FileRow({
  name,
  size,
  relativePath,
  onRemove,
  showMiddleTruncate = true,
}: FileRowProps) {
  const fullPath = relativePath || name;
  const displayTitle = showMiddleTruncate ? truncateMiddle(fullPath, 34) : fullPath;

  return (
    <div className="file-row">
      <span className="file-row-name" title={fullPath}>
        {displayTitle}
      </span>
      <div className="file-row-meta">
        <span className="tabular-numbers">{formatBytes(size)}</span>
        {onRemove && (
          <button
            type="button"
            className="btn-remove-file"
            onClick={onRemove}
            aria-label={`Remove ${fullPath}`}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
