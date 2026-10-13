import React from 'react';

export interface StatusChipProps {
  status?: 'default' | 'success' | 'warning' | 'error' | 'info';
  icon?: React.ReactNode;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function StatusChip({
  status = 'default',
  icon,
  pulse = false,
  children,
  className = '',
}: StatusChipProps) {
  return (
    <span className={`status-chip status-chip-${status} ${pulse ? 'has-pulse' : ''} ${className}`}>
      {pulse && <span className="status-chip-dot" aria-hidden="true" />}
      {!pulse && icon && <span className="status-chip-icon">{icon}</span>}
      <span className="status-chip-text">{children}</span>
    </span>
  );
}
