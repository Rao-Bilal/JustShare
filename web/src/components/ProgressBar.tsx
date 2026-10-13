export interface ProgressBarProps {
  value?: number; // 0 to 100
  indeterminate?: boolean;
}

export function ProgressBar({ value = 0, indeterminate = false }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`progress-fill ${indeterminate ? 'progress-indeterminate' : ''}`}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
